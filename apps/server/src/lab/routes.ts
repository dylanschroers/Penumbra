import {
  benchmarkRequest,
  colabProviderConfig,
  exportRequest,
  findSuite,
  finetuneRequest,
  type LabJob,
  SUITES,
} from "@penumbra/shared";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../http/auth";
import { lmEvalAvailable, runBenchmark } from "./benchmark";
import type { LabStore } from "./jobs";
import { StudioClient, type StudioRun, TrainingBusyError } from "./studio";

// The Model Lab's HTTP surface. Jobs start, return immediately with an id, and
// report progress over SSE — training runs for minutes to hours, so nothing
// here blocks a request on completion.
//
// Behind the same gate as the agent routes, and for stronger reasons: these
// spawn training, write files, and can evict the loaded model.

/** Identify a Studio run across the several id fields it may carry, so runs
 *  seen before a training start can be told apart from the one it produces. */
function runKey(run: StudioRun): string {
  return run.run_id ?? run.id ?? run.output_dir ?? JSON.stringify(run);
}

/** Quantizing a large model is slow, but not unbounded. */
const EXPORT_TIMEOUT_MS = 60 * 60 * 1000;

export interface LabRouteOptions {
  store: LabStore;
  studio?: StudioClient;
  /** Where benchmarked models are served from — Studio, by default. */
  inferenceURL?: string;
  apiKey?: string;
  token?: string;
  /** Builds the Colab fallback trainer from the config a user submits.
   *  Injectable so tests can supply a fake without standing up a live tunnel. */
  makeColab?: (config: { baseURL: string; apiKey?: string }) => StudioClient;
}

export function registerLabRoutes(
  app: FastifyInstance,
  {
    store,
    studio = new StudioClient(),
    inferenceURL,
    apiKey = process.env.UNSLOTH_API_KEY,
    token = process.env.PENUMBRA_AGENT_TOKEN,
    makeColab = (config) => new StudioClient(config),
  }: LabRouteOptions,
): void {
  const preHandler = requireAuth(token);
  const baseURL = inferenceURL ?? studio.baseURL;

  // The optional Colab fallback: a second Studio, reached through a tunnel the
  // user configures at runtime. Held in memory only — the bearer never touches
  // disk and must be re-entered after a restart, the same posture the local
  // Studio key keeps. `null` until configured.
  let colab: StudioClient | null = null;

  /** Choose the Studio to train on. "auto" prefers local and falls back to a
   *  reachable Colab; an explicit provider is honored as asked. Returns the
   *  chosen client and a label, or an error code the route turns into a 409. */
  async function pickTrainer(
    provider: "auto" | "local" | "colab" | undefined,
  ): Promise<
    | { ok: true; client: StudioClient; via: "local" | "colab" }
    | { ok: false; error: string; message: string }
  > {
    if (provider === "local") return { ok: true, client: studio, via: "local" };
    if (provider === "colab") {
      if (!colab) {
        return {
          ok: false,
          error: "colab_not_configured",
          message: "no Colab endpoint is configured",
        };
      }
      return { ok: true, client: colab, via: "colab" };
    }
    // auto: local first, then a reachable Colab.
    if (await studio.reachable()) {
      return { ok: true, client: studio, via: "local" };
    }
    if (colab && (await colab.reachable())) {
      return { ok: true, client: colab, via: "colab" };
    }
    return {
      ok: false,
      error: "no_trainer",
      message:
        "local Studio is unreachable and no reachable Colab endpoint is configured",
    };
  }

  /** Run work in the background, keeping the job record current. The job row
   *  is the source of truth: the client may be gone, and must still be able to
   *  read what happened. */
  const runJob = (
    job: LabJob,
    work: (report: (patch: Partial<LabJob>) => void) => Promise<void>,
  ): void => {
    store.updateJob(job.id, { state: "running" });
    void work((patch) => store.updateJob(job.id, patch))
      .then(() => {
        // A job that failed already set its own state; don't overwrite it.
        if (store.getJob(job.id)?.state === "running") {
          store.updateJob(job.id, { state: "done", progress: 1 });
        }
      })
      .catch((err) => store.failJob(job.id, err));
  };

  app.get("/lab/status", { preHandler }, async () => {
    // Probe both providers in parallel; a missing Colab is simply "stopped".
    const [studioState, lmEval, colabState] = await Promise.all([
      studio.probe(),
      lmEvalAvailable(),
      colab ? colab.probe() : Promise.resolve("stopped" as const),
    ]);
    return {
      // Tri-state: "unauthorized" (up, bad/missing key) is not "stopped".
      studio: studioState,
      lmEval: lmEval ? "installed" : "missing",
      suites: SUITES,
      // The URL is not secret and helps the user confirm what they pointed at;
      // the bearer is never returned.
      colab: {
        configured: colab !== null,
        baseURL: colab?.baseURL ?? null,
        studio: colabState,
      },
    };
  });

  // Configure (or replace) the Colab fallback. The key arrives once here and is
  // held only in memory — see the `colab` declaration above.
  app.post("/lab/provider/colab", { preHandler }, async (req, reply) => {
    const parsed = colabProviderConfig.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    colab = makeColab(parsed.data);
    return { ok: true, baseURL: colab.baseURL };
  });

  app.delete("/lab/provider/colab", { preHandler }, async () => {
    colab = null;
    return { ok: true };
  });

  app.get("/lab/jobs", { preHandler }, async () => store.listJobs());
  app.get("/lab/runs", { preHandler }, async () => store.listRuns());
  app.get("/lab/scores", { preHandler }, async () => store.listScores());

  app.get<{ Params: { id: string } }>(
    "/lab/jobs/:id",
    { preHandler },
    async (req, reply) => {
      const job = store.getJob(req.params.id);
      return job ?? reply.code(404).send({ error: "not_found" });
    },
  );

  // Poll-based progress. The job row already holds every state change, so a
  // client that reconnects simply reads the current value — no replay needed.
  app.get<{ Params: { id: string } }>(
    "/lab/jobs/:id/events",
    { preHandler },
    async (req, reply) => {
      const job = store.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: "not_found" });

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      let open = true;
      req.raw.on("close", () => {
        open = false;
      });

      const send = (event: string, data: unknown) => {
        if (open && !reply.raw.writableEnded) {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      let last = "";
      while (open) {
        const current = store.getJob(req.params.id);
        if (!current) break;
        const snapshot = JSON.stringify(current);
        if (snapshot !== last) {
          send("job", current);
          last = snapshot;
        }
        if (current.state === "done" || current.state === "failed") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      send("done", {});
      if (!reply.raw.writableEnded) reply.raw.end();
    },
  );

  app.post("/lab/finetune", { preHandler }, async (req, reply) => {
    const parsed = finetuneRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request" });
    }
    const input = parsed.data;

    // Decide where this trains before creating a job, so a request with no
    // usable trainer fails fast with a clear code instead of a dead job row.
    const pick = await pickTrainer(input.provider);
    if (!pick.ok) {
      return reply.code(409).send({ error: pick.error, message: pick.message });
    }
    const trainer = pick.client;

    const job = store.createJob("finetune");
    const run = store.createRun({
      jobId: job.id,
      baseModel: input.baseModel,
      dataset:
        input.dataset.kind === "hf" ? input.dataset.id : input.dataset.path,
      outputDir: null,
      ggufPath: null,
    });

    runJob(job, async (report) => {
      report({ detail: `training via ${pick.via}` });
      // Snapshot the runs that already exist, so the output dir recorded below
      // is provably the one this training produced.
      const existingRuns = new Set((await trainer.listRuns()).map(runKey));

      try {
        // QLoRA and 4-bit are forced here, not offered: the GPU host cannot run
        // anything heavier, so a client must not be able to ask for it.
        await trainer.startTraining({
          model_name: input.baseModel,
          training_type: "LoRA/QLoRA",
          format_type: input.format,
          learning_rate: input.learningRate,
          max_steps: input.maxSteps,
          lora_r: input.loraR,
          load_in_4bit: true,
          ...(input.dataset.kind === "hf"
            ? { hf_dataset: input.dataset.id }
            : { local_datasets: [input.dataset.path] }),
        });
      } catch (err) {
        if (err instanceof TrainingBusyError) {
          report({ state: "failed", error: `busy: ${err.message}` });
          return;
        }
        throw err;
      }

      let sawComplete = false;
      for await (const frame of trainer.trainingProgress()) {
        if (frame.event === "progress") {
          const step = Number(frame.data.step ?? 0);
          const total = Number(frame.data.total_steps ?? input.maxSteps);
          report({
            progress: total > 0 ? Math.min(step / total, 1) : null,
            detail: `step ${step}/${total}${
              frame.data.loss ? `, loss ${frame.data.loss}` : ""
            }`,
          });
        } else if (frame.event === "error") {
          throw new Error(String(frame.data.message ?? "training failed"));
        } else if (frame.event === "complete") {
          sawComplete = true;
          break;
        }
      }
      // A stream that simply ends — Studio restarted, the tunnel dropped — is
      // not a finished run. Falling through would mark an interrupted training
      // "done" and then attach some other run's checkpoint to it.
      if (!sawComplete) {
        throw new Error("training stream ended before reporting completion");
      }

      // Studio reports the output directory only via its runs list, which is
      // not guaranteed to end with ours. Match against the runs that existed
      // beforehand so a previous run's checkpoint can't be recorded as this
      // one's. If nothing new appears, record nothing: the run then has no
      // outputDir and export refuses it, which is the safe failure.
      const after = await trainer.listRuns();
      const ours = after.find((r) => !existingRuns.has(runKey(r)));
      if (ours?.output_dir) {
        store.setRunArtifacts(run.id, { outputDir: ours.output_dir });
      }
    });

    return reply.code(202).send({ jobId: job.id, runId: run.id });
  });

  app.post("/lab/export", { preHandler }, async (req, reply) => {
    const parsed = exportRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });

    const run = store.getRun(parsed.data.runId);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    if (!run.outputDir) {
      return reply
        .code(409)
        .send({ error: "no_checkpoint", message: "run has no output dir yet" });
    }

    // Export targets the local Studio: it needs the checkpoint on the same host,
    // and a Colab tunnel is ephemeral — by export time the notebook that trained
    // the run is usually gone. A run trained on Colab therefore exports only
    // while that session is alive and pointed at as the local Studio; otherwise
    // loadCheckpoint fails on a path this host cannot see, which is the safe,
    // visible failure rather than a silently wrong artifact.
    const job = store.createJob("export");
    runJob(job, async (report) => {
      report({ detail: "loading checkpoint" });
      await studio.loadCheckpoint(run.outputDir as string);
      const saveDir = `${run.outputDir}/gguf`;

      // Baseline the op counter immediately before the export, so the check
      // below tracks *this* operation rather than the load-checkpoint that
      // precedes it. Studio reports the outcome of the last op, so without a
      // baseline an earlier success reads as ours and the job finishes
      // instantly against a stale artifact.
      const baseline = (await studio.exportStatus()).last_op_seq ?? 0;

      report({ detail: "exporting gguf" });
      try {
        await studio.exportGguf(saveDir, parsed.data.quantization);
      } catch (err) {
        // Quantization routinely outlives the HTTP request that starts it — a
        // Cloudflare tunnel cuts the connection at ~100s with a 524 — while the
        // work carries on inside Studio. Losing the kickoff response is not the
        // same as the export failing, so consult the status endpoint (the
        // actual source of truth) and only give up if nothing started.
        const s = await studio.exportStatus();
        const started = s.is_export_active || (s.last_op_seq ?? 0) > baseline;
        if (!started) throw err;
        report({ detail: "exporting gguf (kickoff response lost, polling)" });
      }

      // Export runs asynchronously inside Studio, and there is no `status`
      // field to poll: settled means "not active, and the op counter moved".
      const deadline = Date.now() + EXPORT_TIMEOUT_MS;
      for (;;) {
        const s = await studio.exportStatus();
        if (!s.is_export_active && (s.last_op_seq ?? 0) > baseline) {
          if (s.last_op_status === "success") {
            store.setRunArtifacts(run.id, {
              ggufPath: s.last_op_output_path ?? saveDir,
            });
            return;
          }
          throw new Error(
            s.last_op_error ?? `export ${s.last_op_status ?? "failed"}`,
          );
        }
        // Bounded: a counter that never moves must not poll forever.
        if (Date.now() > deadline) throw new Error("export timed out");
        await new Promise((r) => setTimeout(r, 1000));
      }
    });

    return reply.code(202).send({ jobId: job.id });
  });

  app.post("/lab/benchmark", { preHandler }, async (req, reply) => {
    const parsed = benchmarkRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });

    const suite = findSuite(parsed.data.suite);
    if (!suite) return reply.code(400).send({ error: "unknown_suite" });
    if (suite.kind === "general" && !(await lmEvalAvailable())) {
      return reply.code(409).send({
        error: "lm_eval_missing",
        message: "pip install 'lm-eval[api]' to run general suites",
      });
    }

    const job = store.createJob("benchmark");
    runJob(job, async (report) => {
      const result = await runBenchmark({
        model: parsed.data.model,
        suite,
        samplesPerTask: parsed.data.samplesPerTask,
        baseURL,
        apiKey,
        onProgress: (line) => report({ detail: line.slice(0, 200) }),
      });
      store.recordScores(result);
    });

    return reply.code(202).send({ jobId: job.id });
  });
}
