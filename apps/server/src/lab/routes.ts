import {
  benchmarkRequest,
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
import { StudioClient, TrainingBusyError } from "./studio";

// The Model Lab's HTTP surface. Jobs start, return immediately with an id, and
// report progress over SSE — training runs for minutes to hours, so nothing
// here blocks a request on completion.
//
// Behind the same gate as the agent routes, and for stronger reasons: these
// spawn training, write files, and can evict the loaded model.

export interface LabRouteOptions {
  store: LabStore;
  studio?: StudioClient;
  /** Where benchmarked models are served from — Studio, by default. */
  inferenceURL?: string;
  apiKey?: string;
  token?: string;
}

export function registerLabRoutes(
  app: FastifyInstance,
  {
    store,
    studio = new StudioClient(),
    inferenceURL,
    apiKey = process.env.UNSLOTH_API_KEY,
    token = process.env.PENUMBRA_AGENT_TOKEN,
  }: LabRouteOptions,
): void {
  const preHandler = requireAuth(token);
  const baseURL = inferenceURL ?? studio.baseURL;

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

  app.get("/lab/status", { preHandler }, async () => ({
    studio: (await studio.reachable()) ? "ready" : "stopped",
    lmEval: (await lmEvalAvailable()) ? "installed" : "missing",
    suites: SUITES,
  }));

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
      try {
        // QLoRA and 4-bit are forced here, not offered: the GPU host cannot run
        // anything heavier, so a client must not be able to ask for it.
        await studio.startTraining({
          model_name: input.baseModel,
          training_type: "LoRA/QLoRA",
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

      for await (const frame of studio.trainingProgress()) {
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
          break;
        }
      }

      // Studio reports the output directory only via its runs list.
      const runs = await studio.listRuns();
      const latest = runs.at(-1);
      if (latest?.output_dir) {
        store.setRunArtifacts(run.id, { outputDir: latest.output_dir });
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

    const job = store.createJob("export");
    runJob(job, async (report) => {
      report({ detail: "loading checkpoint" });
      await studio.loadCheckpoint(run.outputDir as string);
      const saveDir = `${run.outputDir}/gguf`;
      report({ detail: "exporting gguf" });
      await studio.exportGguf(saveDir, parsed.data.quantization);

      // Export is asynchronous inside Studio; poll until it settles.
      for (;;) {
        const status = await studio.exportStatus();
        if (status.status === "complete" || status.status === "completed")
          break;
        if (status.status === "error") {
          throw new Error(status.message ?? "export failed");
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      store.setRunArtifacts(run.id, { ggufPath: saveDir });
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
