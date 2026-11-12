import { join } from "node:path";
import {
  type AvailableModel,
  type BenchmarkRequest,
  type BenchmarkResult,
  benchmarkRequest,
  exportRequest,
  type FinetuneRequest,
  findSuite,
  finetuneRequest,
  type LabJob,
  type LabRun,
  looksLocalPath,
  SUITES,
} from "@penumbra/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  TargetCredentials,
  TargetId,
  TargetStore,
} from "../compute/targets";
import type { DeviceStore } from "../devices/store";
import { requireAuth } from "../http/auth";
import { openSseStream } from "../http/sse";
import { lmEvalAvailable, runBenchmark } from "./benchmark";
import type { LabStore } from "./jobs";
import {
  readInventory,
  StudioClient,
  type StudioRun,
  TrainingBusyError,
} from "./studio";
import {
  computeNeed,
  type DatasetFile,
  dirFileSizes,
  freeSpace,
  isLocalFile,
  isOutOfSpace,
  listDatasets,
  resolveDest,
  uploadRoot,
  writeChunk,
} from "./uploads";

const UPLOAD_CHUNK_LIMIT = 16 * 1024 * 1024;

// Jobs return an id immediately; progress is polled. Gated like /agent/*.

/** Snapshotting runs before training lets the new one be identified. */
function runKey(run: StudioRun): string {
  return run.run_id ?? run.id ?? run.output_dir ?? JSON.stringify(run);
}

const EXPORT_TIMEOUT_MS = 60 * 60 * 1000;

export interface LabStarted {
  ok: true;
  jobId: string;
  runId?: string;
}

/** `error` is a stable code for the status; `message` is relayable text. */
export interface LabRefused {
  ok: false;
  error: string;
  message: string;
}

/**
 * Returned by `registerLabRoutes` so the agent and the routes share one
 * `inFlight` map: Cancel must reach jobs started from chat.
 */
export interface LabService {
  models(): Promise<{
    target: TargetId;
    models: AvailableModel[];
    inventoryError: string | null;
  }>;
  datasets(): Promise<DatasetFile[]>;
  finetune(input: FinetuneRequest): Promise<LabStarted | LabRefused>;
  benchmark(input: BenchmarkInput): Promise<LabStarted | LabRefused>;
  jobs(): LabJob[];
  job(id: string): LabJob | undefined;
  runs(): LabRun[];
  scores(): BenchmarkResult[];
}

/**
 * `model` is only a label (Studio serves what's resident); an omitted one is
 * filled with the model that will answer.
 */
export type BenchmarkInput = Omit<BenchmarkRequest, "model"> & {
  model?: string;
};

/** Everything else describes machine state: 409. */
const BAD_REQUEST = new Set(["unknown_suite"]);

function sendStarted(
  reply: FastifyReply,
  result: LabStarted | LabRefused,
): FastifyReply {
  if (!result.ok) {
    return reply
      .code(BAD_REQUEST.has(result.error) ? 400 : 409)
      .send({ error: result.error, message: result.message });
  }
  return reply.code(202).send({
    jobId: result.jobId,
    ...(result.runId ? { runId: result.runId } : {}),
  });
}

export interface LabRouteOptions {
  store: LabStore;
  /** Read at use time, so key rotation and retargeting apply on the next request. */
  targets: TargetStore;
  makeClient?: (id: TargetId, creds: TargetCredentials) => StudioClient;
  inferenceURL?: string;
  token?: string;
  devices?: DeviceStore;
}

export function registerLabRoutes(
  app: FastifyInstance,
  {
    store,
    targets,
    makeClient = (_id, creds) => new StudioClient(creds),
    inferenceURL,
    token = process.env.PENUMBRA_AGENT_TOKEN,
    devices,
  }: LabRouteOptions,
): LabService {
  const preHandler = requireAuth({ token, devices });

  function clientFor(id: TargetId): StudioClient | null {
    if (!targets.list().find((t) => t.id === id)?.configured) return null;
    return makeClient(id, targets.credentials(id));
  }

  /** "auto": local, then a reachable Colab. */
  async function pickTrainer(
    provider: "auto" | "local" | "colab" | undefined,
  ): Promise<
    | { ok: true; client: StudioClient; via: "local" | "colab" }
    | { ok: false; error: string; message: string }
  > {
    const local = clientFor("local");
    const colab = clientFor("colab");

    if (provider === "local") {
      // Unreachable in practice: local always has an address.
      if (!local) {
        return {
          ok: false,
          error: "no_trainer",
          message: "the local Studio has no address configured",
        };
      }
      return { ok: true, client: local, via: "local" };
    }
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
    if (local && (await local.reachable())) {
      return { ok: true, client: local, via: "local" };
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

  /** In memory, not in the row: a controller dies with this process. */
  const inFlight = new Map<string, AbortController>();

  const runJob = (
    job: LabJob,
    work: (report: (patch: Partial<LabJob>) => void) => Promise<void>,
    controller?: AbortController,
  ): void => {
    if (controller) inFlight.set(job.id, controller);
    store.updateJob(job.id, { state: "running" });
    void work((patch) => store.updateJob(job.id, patch))
      .then(() => {
        if (store.getJob(job.id)?.state === "running") {
          store.updateJob(job.id, { state: "done", progress: 1 });
        }
      })
      .catch((err) => {
        // Cancelled, with no scores written: a partial suite is not a result.
        if (controller?.signal.aborted) {
          store.updateJob(job.id, {
            state: "cancelled",
            detail: "cancelled before it finished",
          });
          return;
        }
        store.failJob(job.id, err);
      })
      .finally(() => inFlight.delete(job.id));
  };

  /**
   * Only benchmarks hold a controller. Training belongs to Studio; abandoning it
   * here would show "cancelled" over a GPU still training.
   */
  app.post<{ Params: { id: string } }>(
    "/lab/jobs/:id/cancel",
    { preHandler },
    async (req, reply) => {
      const job = store.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: "not_found" });
      if (job.state !== "running" && job.state !== "queued") {
        return reply
          .code(409)
          .send({ error: "not_running", message: `job is ${job.state}` });
      }
      const controller = inFlight.get(job.id);
      if (!controller) {
        // A benchmark without a controller is an orphan from a restart.
        if (job.kind === "benchmark") {
          store.updateJob(job.id, {
            state: "failed",
            error: "Interrupted: the server restarted while this was running.",
          });
          return { ok: true, reconciled: true };
        }
        return reply.code(409).send({
          error: "not_cancellable",
          message: `a ${job.kind} job cannot be stopped from here`,
        });
      }
      controller.abort();
      // 202: state flips when the work unwinds.
      return reply.code(202).send({ ok: true });
    },
  );

  app.get("/lab/status", { preHandler }, async () => ({
    lmEval: (await lmEvalAvailable()) ? "installed" : "missing",
    suites: SUITES,
  }));

  // Uploads land client-local files on this host so Studio can open them.
  // Chunked, so multi-GB models stream.

  // Returns which files the host still needs. Body: { name, files:[{rel,size}] }.
  app.post("/lab/models/plan", { preHandler }, async (req, reply) => {
    const body = req.body as {
      name?: unknown;
      files?: { rel?: unknown; size?: unknown }[];
    };
    if (typeof body?.name !== "string" || !Array.isArray(body.files)) {
      return reply.code(400).send({ error: "bad_request" });
    }
    const files: { rel: string; size: number }[] = [];
    let plan: { path: string; need: string[] };
    let bytes = 0;
    try {
      for (const f of body.files) {
        if (typeof f?.rel !== "string" || typeof f?.size !== "number") {
          return reply.code(400).send({ error: "bad_request" });
        }
        resolveDest(uploadRoot(), "models", join(body.name, f.rel));
        files.push({ rel: f.rel, size: f.size });
      }
      const modelDir = resolveDest(uploadRoot(), "models", body.name);
      const sizes = await dirFileSizes(modelDir);
      const need = computeNeed(files, (rel) => sizes[rel]);
      plan = { path: modelDir, need };
      const needed = new Set(need);
      bytes = files
        .filter((f) => needed.has(f.rel))
        .reduce((sum, f) => sum + f.size, 0);
    } catch {
      return reply.code(400).send({ error: "bad_path" });
    }
    // Refuse up front rather than fail mid-transfer.
    const free = await freeSpace(uploadRoot());
    if (bytes > free) {
      return reply
        .code(507)
        .send({ error: "insufficient_space", need: bytes, free });
    }
    return plan;
  });

  // Query: kind (datasets|models), rel, offset. Body: raw bytes.
  app.post<{ Querystring: { kind?: string; rel?: string; offset?: string } }>(
    "/lab/upload",
    { preHandler, bodyLimit: UPLOAD_CHUNK_LIMIT },
    async (req, reply) => {
      const { kind = "", rel = "", offset = "0" } = req.query;
      if (!Buffer.isBuffer(req.body)) {
        return reply.code(400).send({ error: "expected_binary_body" });
      }
      let dest: string;
      try {
        dest = resolveDest(uploadRoot(), kind, rel);
      } catch {
        return reply.code(400).send({ error: "bad_path" });
      }
      try {
        await writeChunk(dest, Number(offset) || 0, req.body);
      } catch (err) {
        if (isOutOfSpace(err)) {
          return reply.code(507).send({ error: "insufficient_space" });
        }
        throw err;
      }
      return { path: dest };
    },
  );

  app.get("/lab/jobs", { preHandler }, async () => store.listJobs());
  app.get("/lab/runs", { preHandler }, async () => store.listRuns());
  app.get("/lab/scores", { preHandler }, async () => store.listScores());

  /**
   * From the target the benchmark role resolves to. Unreachable: empty list,
   * not an error. The loaded model is offered even if the inventory omits it,
   * since it's what a benchmark would actually measure.
   */
  const models: LabService["models"] = async () => {
    const id = targets.effective("benchmark");
    const client = clientFor(id);
    if (!client) return { target: id, models: [], inventoryError: null };

    // Same reader as the compute panel, so the two can't disagree.
    return { target: id, ...(await readInventory(client)) };
  };

  app.get("/lab/models", { preHandler }, () => models());

  app.get<{ Params: { id: string } }>(
    "/lab/jobs/:id",
    { preHandler },
    async (req, reply) => {
      const job = store.getJob(req.params.id);
      return job ?? reply.code(404).send({ error: "not_found" });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/lab/jobs/:id/events",
    { preHandler },
    async (req, reply) => {
      const job = store.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: "not_found" });

      openSseStream(reply);
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

  const finetune: LabService["finetune"] = async (input) => {
    const pick = await pickTrainer(input.provider);
    if (!pick.ok) return pick;
    const trainer = pick.client;

    // Colab reads a local model path as an invalid HF repo id. Datasets are pushed
    // first, but models have no upload path to Colab.
    if (pick.via === "colab" && looksLocalPath(input.baseModel)) {
      return {
        ok: false,
        error: "remote_model_path",
        message:
          "the Colab trainer runs on another machine and cannot read a path from this one — give the base model as a HuggingFace id",
      };
    }

    const job = store.createJob("finetune");
    const run = store.createRun({
      jobId: job.id,
      baseModel: input.baseModel,
      dataset:
        input.dataset.kind === "hf" ? input.dataset.id : input.dataset.path,
      outputDir: null,
      ggufPath: null,
      hubRepo: null,
      // Export must return to this trainer; "auto" may resolve elsewhere later.
      provider: pick.via,
    });

    runJob(job, async (report) => {
      report({ detail: `training via ${pick.via}` });

      // Studio only opens datasets under its own dataset roots, so a file on this
      // host is uploaded to Studio first. Anything this host can't stat (HF id, a
      // name Studio resolves) passes through.
      let datasetPath =
        input.dataset.kind === "local" ? input.dataset.path : null;
      if (datasetPath && (await isLocalFile(datasetPath))) {
        report({ detail: "sending the dataset to Studio" });
        datasetPath = await trainer.uploadDataset(datasetPath);
      }

      // Snapshot existing runs so the new output dir is provably ours.
      const existingRuns = new Set((await trainer.listRuns()).map(runKey));

      try {
        // Forced: the GPU host can't run anything heavier.
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
            : { local_datasets: [datasetPath ?? input.dataset.path] }),
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
      // A stream that just ends (Studio restart, tunnel drop) is not a finished run.
      if (!sawComplete) {
        throw new Error("training stream ended before reporting completion");
      }

      // Output dirs only come from Studio's runs list, which may not end with ours.
      // If nothing new appears, record nothing; export then refuses the run.
      const after = await trainer.listRuns();
      const ours = after.find((r) => !existingRuns.has(runKey(r)));

      // `complete` isn't success either: Studio sends it whenever training stops,
      // crashes included, so the run record decides. Only an explicit failure
      // fails the job.
      const failed =
        ours?.status === "error" ||
        ours?.status === "stopped" ||
        Boolean(ours?.error_message);
      if (failed) {
        throw new Error(
          ours?.error_message?.trim() ||
            `studio reported the run ${ours?.status ?? "unfinished"}`,
        );
      }

      if (ours?.output_dir) {
        store.setRunArtifacts(run.id, { outputDir: ours.output_dir });
      }
    });

    return { ok: true, jobId: job.id, runId: run.id };
  };

  app.post("/lab/finetune", { preHandler }, async (req, reply) => {
    const parsed = finetuneRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    return sendStarted(reply, await finetune(parsed.data));
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

    // `outputDir` lives on the trainer that produced it; a Colab session may be
    // gone.
    const exporter = clientFor(run.provider);
    if (!exporter) {
      return reply.code(409).send({
        error: "trainer_gone",
        message:
          "this run trained on Colab and no Colab endpoint is configured — its checkpoint only exists on that machine",
      });
    }
    if (!(await exporter.reachable())) {
      return reply.code(409).send({
        error: "trainer_unreachable",
        message:
          run.provider === "colab"
            ? "the Colab session that trained this run is not answering — a checkpoint on a recycled runtime cannot be exported"
            : "the local Studio is not answering",
      });
    }

    const job = store.createJob("export", run.id);
    runJob(job, async (report) => {
      const saveDir = `${run.outputDir}/gguf`;
      // The trainer's disk is not this machine, so every line names it.
      const where = `${saveDir} on ${run.provider}`;
      report({ detail: `loading checkpoint — ${where}` });
      await exporter.loadCheckpoint(run.outputDir as string);

      // Baseline right before the export: Studio reports the last op, so an earlier
      // success would otherwise read as ours.
      const baseline = (await exporter.exportStatus()).last_op_seq ?? 0;

      // Studio serves no exports for download; a Hub push is the only way off an
      // ephemeral trainer.
      const hub = parsed.data.repoId
        ? {
            repoId: parsed.data.repoId,
            hfToken: parsed.data.hfToken,
            private: parsed.data.private,
          }
        : undefined;
      const target = hub
        ? `${parsed.data.quantization} → ${where}, pushing to ${hub.repoId}`
        : `${parsed.data.quantization} → ${where}, no hub push`;
      report({ detail: `exporting ${target}` });
      try {
        await exporter.exportGguf(saveDir, parsed.data.quantization, hub);
      } catch (err) {
        // A Cloudflare tunnel cuts the kickoff at ~100s (524) while Studio keeps
        // working, so check status before giving up.
        const s = await exporter.exportStatus();
        const started = s.is_export_active || (s.last_op_seq ?? 0) > baseline;
        if (!started) throw err;
        report({ detail: `exporting ${target} (still running, polling)` });
      }

      // No `status` field: settled means not active and the op counter moved.
      const started = Date.now();
      const deadline = started + EXPORT_TIMEOUT_MS;
      for (;;) {
        const s = await exporter.exportStatus();
        if (!s.is_export_active && (s.last_op_seq ?? 0) > baseline) {
          if (s.last_op_status === "success") {
            const path = s.last_op_output_path ?? saveDir;
            // For an ephemeral trainer the repo is the only lasting record.
            store.setRunArtifacts(run.id, {
              ggufPath: path,
              hubRepo: hub?.repoId ?? null,
            });
            report({
              detail: hub
                ? `done — ${path} on ${run.provider}, pushed to ${hub.repoId}`
                : `done — ${path} on ${run.provider} (not pushed anywhere)`,
            });
            return;
          }
          throw new Error(
            s.last_op_error ?? `export ${s.last_op_status ?? "failed"}`,
          );
        }
        if (Date.now() > deadline) throw new Error("export timed out");
        const mins = Math.floor((Date.now() - started) / 60_000);
        const secs = Math.floor(((Date.now() - started) % 60_000) / 1000);
        report({
          detail: `exporting ${target} — ${mins}m${String(secs).padStart(2, "0")}s elapsed`,
        });
        await new Promise((r) => setTimeout(r, 1000));
      }
    });

    return reply.code(202).send({ jobId: job.id });
  });

  const benchmark: LabService["benchmark"] = async (input) => {
    const suite = findSuite(input.suite);
    if (!suite) {
      return {
        ok: false,
        error: "unknown_suite",
        message: `there is no suite called "${input.suite}"`,
      };
    }
    if (suite.kind === "general" && !(await lmEvalAvailable())) {
      return {
        ok: false,
        error: "lm_eval_missing",
        message: "pip install 'lm-eval[api]' to run general suites",
      };
    }

    const targetId = targets.effective("benchmark");
    const via = targets.credentials(targetId);

    // Studio ignores the request's `model`, so ask what's actually loaded.
    const served = await clientFor(targetId)
      ?.loadedModel()
      .catch(() => null);
    if (!served) {
      return {
        ok: false,
        error: "no_model_loaded",
        message: `${targetId} has no model loaded — a benchmark would score whatever answered, or nothing`,
      };
    }

    const model = input.model ?? served;

    const job = store.createJob("benchmark");
    const controller = new AbortController();
    runJob(
      job,
      async (report) => {
        report({
          detail:
            served === model
              ? `benchmarking ${served} on ${targetId}`
              : `benchmarking ${served} on ${targetId} (requested ${model})`,
        });
        const result = await runBenchmark({
          model,
          servedModel: served,
          target: targetId,
          suite,
          samplesPerTask: input.samplesPerTask,
          baseURL: inferenceURL ?? via.baseURL,
          apiKey: via.apiKey,
          signal: controller.signal,
          // `progress` may be null; the store's COALESCE keeps the last value.
          onProgress: (update) => report(update),
        });
        store.recordScores(result);
      },
      controller,
    );

    return { ok: true, jobId: job.id };
  };

  app.post("/lab/benchmark", { preHandler }, async (req, reply) => {
    const parsed = benchmarkRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    return sendStarted(reply, await benchmark(parsed.data));
  });

  return {
    models,
    datasets: listDatasets,
    finetune,
    benchmark,
    jobs: () => store.listJobs(),
    job: (id) => store.getJob(id),
    runs: () => store.listRuns(),
    scores: () => store.listScores(),
  };
}
