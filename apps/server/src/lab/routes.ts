import { join } from "node:path";
import {
  type AvailableModel,
  type BenchmarkRequest,
  benchmarkRequest,
  exportRequest,
  type FinetuneRequest,
  findSuite,
  finetuneRequest,
  type LabJob,
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

/** A chunk write body's headroom — chunks are a few MB; keep the ceiling well
 *  above that but bounded. */
const UPLOAD_CHUNK_LIMIT = 16 * 1024 * 1024;

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

/** Background work started: the job to watch, and the run it created if it
 *  created one. */
export interface LabStarted {
  ok: true;
  jobId: string;
  runId?: string;
}

/** Work refused before anything started. `error` is the stable code a route
 *  turns into a status; `message` is the sentence a caller can relay. */
export interface LabRefused {
  ok: false;
  error: string;
  message: string;
}

/**
 * What the Model Lab can do, for callers inside this process.
 *
 * Returned by `registerLabRoutes` rather than built as a separate module
 * because both callers must share one piece of job orchestration: `inFlight`
 * is what decides whether a job can be cancelled, so a second copy would leave
 * a benchmark the agent started running with the Lab's Cancel button unable to
 * reach it. The agent binds this (../agent/tools.ts) instead of calling this
 * server's own HTTP surface, which would mean holding the bearer to talk to
 * itself.
 */
export interface LabService {
  /** What the benchmark target can serve, and which of it is resident. */
  models(): Promise<{
    target: TargetId;
    models: AvailableModel[];
    inventoryError: string | null;
  }>;
  /** Datasets already uploaded to this host. */
  datasets(): Promise<DatasetFile[]>;
  finetune(input: FinetuneRequest): Promise<LabStarted | LabRefused>;
  benchmark(input: BenchmarkInput): Promise<LabStarted | LabRefused>;
  jobs(): LabJob[];
  job(id: string): LabJob | undefined;
}

/**
 * A benchmark to run.
 *
 * `model` is optional here where the wire schema requires it, because it is
 * only a label: Studio serves whatever is resident regardless of what the
 * request names. An omitted one is filled with the model that will actually
 * answer, which is the value that should have been sent anyway.
 */
export type BenchmarkInput = Omit<BenchmarkRequest, "model"> & {
  model?: string;
};

/** Refusals that mean the request was wrong rather than the compute being
 *  unable — the rest describe the state of a machine, which is a 409. */
const BAD_REQUEST = new Set(["unknown_suite"]);

/** Render a service result as the response the route contract promises. */
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
  /** Where compute lives and which target each role uses. Addresses and keys
   *  are read at the moment they are needed, so a rotated key or a retargeted
   *  role takes effect on the next request with nothing to invalidate. */
  targets: TargetStore;
  /** Builds a Studio client for a target. Injectable so tests can supply fakes
   *  without standing up a live Studio or tunnel. */
  makeClient?: (id: TargetId, creds: TargetCredentials) => StudioClient;
  /** Overrides where benchmarked models are served from. Unset means the target
   *  assigned to the benchmark role. */
  inferenceURL?: string;
  token?: string;
  /** Issued device tokens, accepted alongside the shared secret. Optional so a
   *  test can stand these routes up without a device store. */
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

  /** The Studio for a target, or null when it has no address yet. Built per
   *  call rather than cached: a client is a URL and a header map, so there is
   *  nothing to keep alive — and nothing that can go stale against the store. */
  function clientFor(id: TargetId): StudioClient | null {
    if (!targets.list().find((t) => t.id === id)?.configured) return null;
    return makeClient(id, targets.credentials(id));
  }

  /** Choose the Studio to train on. "auto" prefers local and falls back to a
   *  reachable Colab; an explicit provider is honored as asked. Returns the
   *  chosen client and a label, or an error code the route turns into a 409. */
  async function pickTrainer(
    provider: "auto" | "local" | "colab" | undefined,
  ): Promise<
    | { ok: true; client: StudioClient; via: "local" | "colab" }
    | { ok: false; error: string; message: string }
  > {
    const local = clientFor("local");
    const colab = clientFor("colab");

    if (provider === "local") {
      // Local always has an address (an environment default at worst), so this
      // branch cannot be unconfigured — but the type says it can.
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
    // auto: local first, then a reachable Colab.
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

  /**
   * Controllers for jobs that can still be stopped, keyed by job id.
   *
   * In memory rather than in the job row: a controller belongs to a running
   * process in *this* server, so one that outlived a restart would name work
   * nobody can reach. A job left running by a restart is already handled as a
   * job whose progress simply stops.
   */
  const inFlight = new Map<string, AbortController>();

  /** Run work in the background, keeping the job record current. The job row is
   *  the source of truth: the client may be gone, and must still be able to read
   *  what happened. A controller, when given, makes the job stoppable. */
  const runJob = (
    job: LabJob,
    work: (report: (patch: Partial<LabJob>) => void) => Promise<void>,
    controller?: AbortController,
  ): void => {
    if (controller) inFlight.set(job.id, controller);
    store.updateJob(job.id, { state: "running" });
    void work((patch) => store.updateJob(job.id, patch))
      .then(() => {
        // A job that failed already set its own state; don't overwrite it.
        if (store.getJob(job.id)?.state === "running") {
          store.updateJob(job.id, { state: "done", progress: 1 });
        }
      })
      .catch((err) => {
        // The work rejects either way, so the signal is what tells a deliberate
        // stop from a break. Recorded as cancelled, with no scores written: a
        // partial run is not a result, and half a suite recorded as a whole one
        // is exactly the mislabeled row the rest of this file guards against.
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
   * Stop a running job.
   *
   * Only the work that holds a controller can be stopped, which today is a
   * benchmark: it owns its subprocess (or its own request loop) and killing it
   * leaves nothing behind. Training is not cancellable here on purpose — the
   * run belongs to Studio, so stopping it means telling Studio, and abandoning
   * this side would leave a job row saying "cancelled" over a GPU still
   * training.
   */
  app.post<{ Params: { id: string } }>(
    "/lab/jobs/:id/cancel",
    { preHandler },
    async (req, reply) => {
      const job = store.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: "not_found" });
      if (job.state !== "running" && job.state !== "queued") {
        // Already finished: nothing to stop, and saying so beats reporting a
        // success that did nothing.
        return reply
          .code(409)
          .send({ error: "not_running", message: `job is ${job.state}` });
      }
      const controller = inFlight.get(job.id);
      if (!controller) {
        // Training holds no controller by design. Anything else claiming to run
        // without one is an orphan whose process is gone — a restart mid-run,
        // caught here rather than left to sit as a permanently "running" row
        // that blocks the next run and refuses to be stopped.
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
      // 202: the state flips when the work unwinds, not now.
      return reply.code(202).send({ ok: true });
    },
  );

  // What the Lab needs that isn't compute: whether the general suite can run,
  // and what suites exist. Target addresses, keys, and readiness moved to
  // /compute/targets — chat needs them too, and they were never Lab-specific.
  app.get("/lab/status", { preHandler }, async () => ({
    lmEval: (await lmEvalAvailable()) ? "installed" : "missing",
    suites: SUITES,
  }));

  // --- Upload: bring a client-local model or dataset onto this host ---------
  //
  // The picker on a laptop yields a path only the laptop can read; training runs
  // here. These routes land the file under the upload root so the finetune can
  // then pass Studio a path Studio can open. Chunked so a multi-GB model streams
  // rather than buffering whole.

  // Which files of a model the host still needs — lets the client skip an
  // upload when a full copy is already here. Body: { name, files:[{rel,size}] }.
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
        // Prove every rel is safe before we agree to receive it.
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
    // Say up front that a multi-GB model won't fit, rather than filling the disk
    // and failing mid-transfer on a chunk write.
    const free = await freeSpace(uploadRoot());
    if (bytes > free) {
      return reply
        .code(507)
        .send({ error: "insufficient_space", need: bytes, free });
    }
    return plan;
  });

  // One chunk of a file. Query: kind (datasets|models), rel, offset. Body: the
  // raw bytes (application/octet-stream). Returns the host path being written.
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
        // A full disk is the client's problem to report, not a server fault:
        // name it instead of letting a bare 500 reach the upload UI.
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
   * What the benchmark target can serve, for the picker.
   *
   * Read from the target a run would actually go to, not from "local": with
   * benchmarking assigned to Colab, offering this host's models would name
   * models that machine has never seen. An unreachable target answers with an
   * empty list rather than an error — the form stays usable, and the pill
   * already reports why nothing is there.
   *
   * `loaded` is the point of the endpoint as much as the list is. Studio serves
   * whatever is resident regardless of the id sent, so the entry marked loaded
   * is the one a benchmark would really measure — and it is offered even when
   * the inventory does not list it, since otherwise the form hides the only
   * model this target can score.
   */
  const models: LabService["models"] = async () => {
    const id = targets.effective("benchmark");
    const client = clientFor(id);
    if (!client) return { target: id, models: [], inventoryError: null };

    // Same read the compute panel's list goes through, so the two views of one
    // inventory cannot disagree about a model's name or which is resident.
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

  // Poll-based progress. The job row already holds every state change, so a
  // client that reconnects simply reads the current value — no replay needed.
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
    // Decide where this trains before creating a job, so a request with no
    // usable trainer fails fast with a clear code instead of a dead job row.
    const pick = await pickTrainer(input.provider);
    if (!pick.ok) return pick;
    const trainer = pick.client;

    // A model path means something only on the machine holding the file. Colab
    // is a different machine: it reads an unrecognized model name as a
    // HuggingFace repo id and rejects a path as an invalid one ("Repo id must
    // use alphanumeric chars…"). Datasets don't have this problem — those are
    // pushed to the trainer before the run — but there is no upload endpoint
    // for a model, so say plainly what's needed instead.
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
      // Whose disk the checkpoint will land on. Export has to come back to the
      // same trainer, and by then "auto" may resolve elsewhere.
      provider: pick.via,
    });

    runJob(job, async (report) => {
      report({ detail: `training via ${pick.via}` });

      // Studio only opens a dataset that lives under one of its own dataset
      // roots, and our upload root is elsewhere by design (a drive with room,
      // sometimes another machine). So a dataset file this host holds is handed
      // to Studio first, and the path Studio hands back is what trains. A value
      // this host can't stat is not ours to send — it's an HF id or a name only
      // Studio can resolve, and passes through untouched.
      let datasetPath =
        input.dataset.kind === "local" ? input.dataset.path : null;
      if (datasetPath && (await isLocalFile(datasetPath))) {
        report({ detail: "sending the dataset to Studio" });
        datasetPath = await trainer.uploadDataset(datasetPath);
      }

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

      // The stream is not the verdict. Studio emits `complete` whenever
      // training stops being active — a CUDA failure 20 seconds in ends the
      // stream exactly like a finished run does — so the outcome has to come
      // from the run record. Without this a crashed run reads as "done" with
      // no model behind it.
      //
      // Only an explicit failure fails the job: a status this client doesn't
      // know must not turn a good run into a bad one.
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

    // `outputDir` is a path on the machine that trained the run, so the export
    // has to go back to that same trainer — handing a Colab checkpoint path to
    // the local Studio just fails on a path it cannot see. A Colab session is
    // ephemeral, so it may well be gone; say that plainly here rather than
    // failing deep inside a job with a network error.
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

    // Attributed to the run, so the Runs tab can show this job's progress on
    // the row the button belongs to instead of only in the global list.
    const job = store.createJob("export", run.id);
    runJob(job, async (report) => {
      const saveDir = `${run.outputDir}/gguf`;
      // Every line says where the artifact is going. The trainer's disk is not
      // this machine, which is the single most surprising thing about export.
      const where = `${saveDir} on ${run.provider}`;
      report({ detail: `loading checkpoint — ${where}` });
      await exporter.loadCheckpoint(run.outputDir as string);

      // Baseline the op counter immediately before the export, so the check
      // below tracks *this* operation rather than the load-checkpoint that
      // precedes it. Studio reports the outcome of the last op, so without a
      // baseline an earlier success reads as ours and the job finishes
      // instantly against a stale artifact.
      const baseline = (await exporter.exportStatus()).last_op_seq ?? 0;

      // A push to the Hub is the only way an artifact leaves an ephemeral
      // trainer: Studio writes exports to its own disk and serves none of them
      // for download, so a Colab VM keeps them until the runtime recycles.
      const hub = parsed.data.repoId
        ? {
            repoId: parsed.data.repoId,
            hfToken: parsed.data.hfToken,
            private: parsed.data.private,
          }
        : undefined;
      // The destination is part of every line from here on: an export that
      // wrote to a machine you can't reach, with no push, is the failure mode
      // worth seeing while it happens rather than afterwards.
      const target = hub
        ? `${parsed.data.quantization} → ${where}, pushing to ${hub.repoId}`
        : `${parsed.data.quantization} → ${where}, no hub push`;
      report({ detail: `exporting ${target}` });
      try {
        await exporter.exportGguf(saveDir, parsed.data.quantization, hub);
      } catch (err) {
        // Quantization routinely outlives the HTTP request that starts it — a
        // Cloudflare tunnel cuts the connection at ~100s with a 524 — while the
        // work carries on inside Studio. Losing the kickoff response is not the
        // same as the export failing, so consult the status endpoint (the
        // actual source of truth) and only give up if nothing started.
        const s = await exporter.exportStatus();
        const started = s.is_export_active || (s.last_op_seq ?? 0) > baseline;
        if (!started) throw err;
        report({ detail: `exporting ${target} (still running, polling)` });
      }

      // Export runs asynchronously inside Studio, and there is no `status`
      // field to poll: settled means "not active, and the op counter moved".
      const started = Date.now();
      const deadline = started + EXPORT_TIMEOUT_MS;
      for (;;) {
        const s = await exporter.exportStatus();
        if (!s.is_export_active && (s.last_op_seq ?? 0) > baseline) {
          if (s.last_op_status === "success") {
            const path = s.last_op_output_path ?? saveDir;
            // Recorded, not just reported: for a trainer whose disk is
            // temporary, the repo is the only lasting answer to "where did the
            // weights go", and a job detail line is not a record.
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
        // Bounded: a counter that never moves must not poll forever.
        if (Date.now() > deadline) throw new Error("export timed out");
        // Quantization is minutes of silence otherwise; an elapsed clock is the
        // difference between "working" and "hung" from the outside.
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

    // Resolved before the job exists, so a run with nowhere to go fails fast
    // with a clear code instead of leaving a dead job row.
    const targetId = targets.effective("benchmark");
    const via = targets.credentials(targetId);

    // What is *actually* loaded there. Studio ignores the `model` field of a
    // request and serves whatever it has resident, so a benchmark naming one
    // model while another is loaded produces a complete, plausible, wrong score
    // with no error anywhere. Asking first is the only way to know.
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

    // Nothing named means the scores are labeled with what will answer, which
    // is the only label that can be right (see BenchmarkInput).
    const model = input.model ?? served;

    const job = store.createJob("benchmark");
    // A benchmark is the one job worth stopping mid-flight: the wrong suite or
    // the wrong sample count can otherwise tie up the GPU for an hour with a
    // result nobody wants.
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
        // The scores describe `served`, wherever it ran. Carried into the record
        // rather than only into a job line, because the comparison these feed is
        // the whole point of keeping them.
        const result = await runBenchmark({
          model,
          servedModel: served,
          target: targetId,
          suite,
          samplesPerTask: input.samplesPerTask,
          baseURL: inferenceURL ?? via.baseURL,
          apiKey: via.apiKey,
          signal: controller.signal,
          // Relayed as given. The suite knows where it is; this route only
          // writes it down. `progress` is null on a line that says nothing
          // about position, and the store's COALESCE keeps the last real value
          // rather than blanking a bar that was right.
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
  };
}
