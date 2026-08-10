import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finetuneRequest } from "@penumbra/shared";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTargetStore, type TargetStore } from "../compute/targets";
import { createLabStore, type LabStore } from "./jobs";
import { type LabService, registerLabRoutes } from "./routes";
import type { HubTarget, StudioClient, TrainingStart } from "./studio";

/** Studio stand-in; only the methods a given test exercises are supplied.
 *
 *  The export shape here mirrors a live Studio, verified with src/lab/probe.mts:
 *  there is no `status` field — an export is settled when it is no longer
 *  active AND the monotonic op counter has moved past where it was. An earlier
 *  version of this fake returned `{status:"complete"}`, which does not exist,
 *  and hid a polling loop that would have hung forever. */
function fakeStudio(over: Partial<StudioClient> = {}): StudioClient {
  let opSeq = 0;
  const base = {
    baseURL: "http://studio",
    reachable: async () => true,
    // Studio serves what it has loaded regardless of the request, so a
    // benchmark asks before it runs; the default here is "something is loaded".
    loadedModel: async () => "loaded-model",
    startTraining: async () => {},
    uploadDataset: async (path: string) => path,
    listRuns: async () => [],
    async *trainingProgress() {},
    loadCheckpoint: async () => {},
    listLocalModels: async () => [],
    // A real export advances the op counter when it finishes.
    exportGguf: async () => {
      opSeq += 1;
    },
    exportStatus: async () => ({
      is_export_active: false,
      last_op_seq: opSeq,
      last_op_status: "success",
      last_op_output_path: "/runs/7/gguf",
    }),
    ...over,
  };
  // Derive the tri-state probe from reachable unless a test sets it explicitly,
  // so fakes that only care about up/down don't each have to spell it out.
  const probe =
    over.probe ??
    (async () => ((await base.reachable()) ? "ready" : "stopped"));
  return { ...base, probe } as unknown as StudioClient;
}

let app: FastifyInstance;
let store: LabStore;
let targets: TargetStore;

beforeEach(() => {
  store = createLabStore(new Database(":memory:"));
  // An empty environment, so the local target resolves to Studio's default
  // address and nothing leaks in from the machine running the tests.
  targets = createTargetStore(new Database(":memory:"), {});
});
afterEach(() => app?.close());

/** Make the Colab target exist. The store decides *whether* a target is
 *  configured; `build` decides what answers for it. Splitting the two is what
 *  lets a test route training to Colab without a live tunnel. */
function configureColab(baseURL = "https://tunnel.example") {
  targets.set("colab", { baseURL, apiKey: "colab-secret" });
}

/** The in-process handle the routes hand back, for the tests that exercise it.
 *  Set by every `build`, since it is the same object the routes call. */
let lab: LabService;

async function build(
  studio = fakeStudio(),
  token?: string,
  colabStudio?: StudioClient,
  inferenceURL?: string,
) {
  app = Fastify();
  lab = registerLabRoutes(app, {
    store,
    targets,
    token,
    inferenceURL,
    makeClient: (id) =>
      id === "colab" ? (colabStudio ?? fakeStudio()) : studio,
  });
  await app.ready();
  return app;
}

/** A model server that answers anything with a plain reply. The personal suite
 *  talks real HTTP, so a benchmark that must *finish* needs something to
 *  answer; the fake StudioClient above only covers the control plane. */
function startFakeModel() {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
  });
  return {
    listen: () =>
      new Promise<string>((resolve) =>
        server.listen(0, "127.0.0.1", () =>
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
        ),
      ),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let fakeModel: ReturnType<typeof startFakeModel> | undefined;
afterEach(async () => {
  await fakeModel?.close();
  fakeModel = undefined;
});

/** Jobs run in the background; wait for one to settle. */
async function settle(id: string, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const job = store.getJob(id);
    if (job && (job.state === "done" || job.state === "failed")) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  return store.getJob(id);
}

/** A finished fine-tune with a checkpoint on disk, ready to export. The
 *  provider decides which trainer the export goes back to. */
function seedRun(
  store: LabStore,
  outputDir: string,
  provider: "local" | "colab" = "local",
) {
  const job = store.createJob("finetune");
  return store.createRun({
    jobId: job.id,
    baseModel: "q",
    dataset: "d",
    outputDir,
    ggufPath: null,
    hubRepo: null,
    provider,
  });
}

const finetuneBody = {
  baseModel: "qwen",
  dataset: { kind: "hf", id: "tatsu-lab/alpaca" },
};

describe("auth", () => {
  // /lab is a stronger actuator than /agent/chat: it spawns training and writes
  // files. It must never be the one unauthenticated endpoint on the box.
  it("refuses a non-loopback caller with no token configured", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/lab/status",
      remoteAddress: "192.168.1.50",
    });
    expect(res.statusCode).toBe(403);
  });

  it("gates the mutating routes too", async () => {
    const app = await build(fakeStudio(), "secret");
    for (const url of ["/lab/finetune", "/lab/export", "/lab/benchmark"]) {
      const res = await app.inject({ method: "POST", url, payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("GET /lab/status", () => {
  it("reports the suite catalog and whether lm-eval is installed", async () => {
    const app = await build();
    const body = (await app.inject({ url: "/lab/status" })).json();

    expect(body.suites.map((s: { id: string }) => s.id)).toContain(
      "penumbra-tools-v1",
    );
    expect(["installed", "missing"]).toContain(body.lmEval);
  });

  // Target addresses, keys, and readiness live at /compute/targets now: chat
  // needs them too, so reporting them from a Lab route made the Lab the owner
  // of a setting it merely shares.
  it("no longer carries compute configuration", async () => {
    const app = await build();
    const body = (await app.inject({ url: "/lab/status" })).json();
    expect(body.studio).toBeUndefined();
    expect(body.local).toBeUndefined();
    expect(body.colab).toBeUndefined();
  });
});

// Configuring a target now lives at /compute/targets — see
// ../compute/routes.test.ts. What stays here is what the *Lab* does with the
// targets once they exist: route training, and refuse when it cannot.
describe("Colab as a trainer", () => {
  // The whole point: when the local GPU host is offline, training routes to the
  // configured Colab tunnel instead of failing.
  it("trains via Colab when the local Studio is unreachable", async () => {
    let colabTrained = false;
    const colab = fakeStudio({
      baseURL: "https://tunnel.example",
      startTraining: async () => {
        colabTrained = true;
      },
      async *trainingProgress() {
        yield { event: "complete", data: {} };
      },
    });
    const app = await build(
      fakeStudio({ reachable: async () => false }),
      undefined,
      colab,
    );
    configureColab();

    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/finetune",
        payload: finetuneBody,
      })
    ).json();

    expect((await settle(jobId))?.state).toBe("done");
    expect(colabTrained).toBe(true);
  });

  it("refuses to train on Colab while none is configured", async () => {
    const app = await build(fakeStudio({ reachable: async () => false }));
    const res = await app.inject({
      method: "POST",
      url: "/lab/finetune",
      payload: { ...finetuneBody, provider: "colab" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("colab_not_configured");
  });

  // Colab resolves an unknown model name against HuggingFace, so a path from
  // this machine comes back as "Repo id must use alphanumeric chars…" minutes
  // later. There is no model-upload endpoint to fix it with, so refuse early.
  it("refuses a local model path when the run would go to Colab", async () => {
    const app = await build(
      fakeStudio({ reachable: async () => false }),
      undefined,
      fakeStudio({ baseURL: "https://tunnel.example" }),
    );
    configureColab();

    const res = await app.inject({
      method: "POST",
      url: "/lab/finetune",
      payload: {
        ...finetuneBody,
        baseModel: "F:\\modelStorage\\models\\Qwen3-1.7B",
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("remote_model_path");
    expect(store.listJobs()).toEqual([]);
  });

  it("still accepts a local model path for the local trainer", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/lab/finetune",
      payload: {
        ...finetuneBody,
        baseModel: "F:\\modelStorage\\models\\Qwen3-1.7B",
      },
    });
    expect(res.statusCode).toBe(202);
  });

  it("refuses to fine-tune with no reachable trainer", async () => {
    const app = await build(fakeStudio({ reachable: async () => false }));
    const res = await app.inject({
      method: "POST",
      url: "/lab/finetune",
      payload: finetuneBody,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_trainer");
    // Nothing was started, so no job row was left behind.
    expect(store.listJobs()).toEqual([]);
  });
});

describe("POST /lab/finetune", () => {
  it("accepts and returns a job to follow", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/lab/finetune",
      payload: finetuneBody,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      jobId: expect.any(String),
      runId: expect.any(String),
    });
  });

  it("rejects a malformed request without creating a job", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/lab/finetune",
      payload: { baseModel: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(store.listJobs()).toEqual([]);
  });

  // The GPU host cannot run anything heavier, so a client must not be able to
  // ask for full fine-tuning or 16-bit.
  it("forces QLoRA and 4-bit regardless of the request", async () => {
    let sent: Record<string, unknown> = {};
    const app = await build(
      fakeStudio({
        startTraining: async (body) => {
          sent = body as unknown as Record<string, unknown>;
        },
      }),
    );
    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/finetune",
        payload: finetuneBody,
      })
    ).json();
    await settle(jobId);

    expect(sent).toMatchObject({
      training_type: "LoRA/QLoRA",
      load_in_4bit: true,
      hf_dataset: "tatsu-lab/alpaca",
    });
  });

  it("records the output dir the run produced", async () => {
    // A real Studio's run list *grows*: the new run only exists afterwards.
    let trained = false;
    const app = await build(
      fakeStudio({
        startTraining: async () => {
          trained = true;
        },
        async *trainingProgress() {
          yield { event: "progress", data: { step: 1, total_steps: 2 } };
          yield { event: "complete", data: {} };
        },
        listRuns: async () =>
          trained ? [{ run_id: "new", output_dir: "/runs/42" }] : [],
      }),
    );
    const { jobId, runId } = (
      await app.inject({
        method: "POST",
        url: "/lab/finetune",
        payload: finetuneBody,
      })
    ).json();

    expect((await settle(jobId))?.state).toBe("done");
    expect(store.getRun(runId)?.outputDir).toBe("/runs/42");
  });

  // Studio ends the progress stream with `complete` whenever training stops
  // being active, crash included — so a run that died on a CUDA error looked
  // exactly like a finished one and the job reported "done" with no model.
  it("fails the job when the run record says the training errored", async () => {
    let trained = false;
    const app = await build(
      fakeStudio({
        startTraining: async () => {
          trained = true;
        },
        async *trainingProgress() {
          yield { event: "progress", data: { step: 0, total_steps: 0 } };
          yield { event: "complete", data: {} };
        },
        listRuns: async () =>
          trained
            ? [
                {
                  run_id: "new",
                  status: "error",
                  output_dir: null as unknown as string,
                  error_message:
                    "CUDA error: no kernel image is available for execution on the device",
                },
              ]
            : [],
      }),
    );
    const { jobId, runId } = (
      await app.inject({
        method: "POST",
        url: "/lab/finetune",
        payload: finetuneBody,
      })
    ).json();

    const job = await settle(jobId);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("no kernel image");
    expect(store.getRun(runId)?.outputDir).toBeNull();
  });

  it("fails the job when a run is stopped part-way", async () => {
    let trained = false;
    const app = await build(
      fakeStudio({
        startTraining: async () => {
          trained = true;
        },
        async *trainingProgress() {
          yield { event: "complete", data: {} };
        },
        listRuns: async () =>
          trained ? [{ run_id: "new", status: "stopped" }] : [],
      }),
    );
    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/finetune",
        payload: finetuneBody,
      })
    ).json();

    const job = await settle(jobId);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("stopped");
  });

  // Studio's list is not guaranteed to end with our run, and an earlier run's
  // checkpoint attached to this job would later be exported as if it were ours.
  it("ignores a pre-existing run rather than claiming its checkpoint", async () => {
    const stale = { run_id: "old", output_dir: "/runs/OLD" };
    const app = await build(
      fakeStudio({
        async *trainingProgress() {
          yield { event: "complete", data: {} };
        },
        // The list never grows: no run of ours was produced.
        listRuns: async () => [stale],
      }),
    );
    const { jobId, runId } = (
      await app.inject({
        method: "POST",
        url: "/lab/finetune",
        payload: finetuneBody,
      })
    ).json();

    await settle(jobId);
    // No checkpoint recorded, so export refuses it — the safe failure.
    expect(store.getRun(runId)?.outputDir).toBeNull();
  });

  // Studio restarting or a tunnel dropping ends the stream without "complete".
  // Treating that as success would report unfinished training as done.
  it("fails when the progress stream ends without completing", async () => {
    const app = await build(
      fakeStudio({
        async *trainingProgress() {
          yield { event: "progress", data: { step: 3, total_steps: 20 } };
          // stream simply ends
        },
      }),
    );
    const { jobId, runId } = (
      await app.inject({
        method: "POST",
        url: "/lab/finetune",
        payload: finetuneBody,
      })
    ).json();

    const job = await settle(jobId);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("ended before reporting completion");
    expect(store.getRun(runId)?.outputDir).toBeNull();
  });

  it("surfaces a training error on the job rather than losing it", async () => {
    const app = await build(
      fakeStudio({
        async *trainingProgress() {
          yield { event: "error", data: { message: "CUDA OOM" } };
        },
      }),
    );
    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/finetune",
        payload: finetuneBody,
      })
    ).json();

    const job = await settle(jobId);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("CUDA OOM");
  });
});

describe("POST /lab/export", () => {
  it("refuses a run that has no checkpoint yet", async () => {
    const app = await build();
    const run = seedRun(store, null as unknown as string);

    const res = await app.inject({
      method: "POST",
      url: "/lab/export",
      payload: { runId: run.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_checkpoint");
  });

  it("404s an unknown run", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/lab/export",
      payload: { runId: "nope" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("records the gguf path once the export settles", async () => {
    const app = await build();
    const run = seedRun(store, "/runs/7");

    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/export",
        payload: { runId: run.id },
      })
    ).json();

    expect((await settle(jobId))?.state).toBe("done");
    expect(store.getRun(run.id)?.ggufPath).toBe("/runs/7/gguf");
  });

  // `outputDir` is a path on the machine that trained the run. Exporting a
  // Colab run against the local Studio hands it a path that host has never
  // seen, and either fails confusingly or, worse, finds something else there.
  it("exports a Colab-trained run against the Colab trainer", async () => {
    let localExported = false;
    const colabSaveDirs: string[] = [];
    // The op counter has to move for an export to read as settled — that is how
    // Studio reports "this operation finished", and the route baselines it.
    let seq = 0;
    const colab = fakeStudio({
      baseURL: "https://tunnel.example",
      exportGguf: async (saveDir: string) => {
        colabSaveDirs.push(saveDir);
        seq += 1;
      },
      exportStatus: async () => ({
        is_export_active: false,
        last_op_seq: seq,
        last_op_status: "success",
        last_op_output_path: "/root/outputs/run/gguf",
      }),
    });
    const app = await build(
      fakeStudio({
        exportGguf: async () => {
          localExported = true;
        },
      }),
      undefined,
      colab,
    );
    configureColab();

    const run = seedRun(store, "/root/outputs/run", "colab");
    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/export",
        payload: { runId: run.id },
      })
    ).json();

    expect((await settle(jobId))?.state).toBe("done");
    expect(colabSaveDirs).toEqual(["/root/outputs/run/gguf"]);
    expect(localExported).toBe(false);
    expect(store.getRun(run.id)?.ggufPath).toBe("/root/outputs/run/gguf");
  });

  it("says so when the Colab session that trained the run is gone", async () => {
    const app = await build();
    const run = seedRun(store, "/root/outputs/run", "colab");

    const res = await app.inject({
      method: "POST",
      url: "/lab/export",
      payload: { runId: run.id },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("trainer_gone");
    // Nothing was attempted, so no export job was left behind.
    expect(store.listJobs().some((j) => j.kind === "export")).toBe(false);
  });

  it("refuses when the trainer is configured but not answering", async () => {
    const app = await build(fakeStudio({ reachable: async () => false }));
    const run = seedRun(store, "/runs/7");

    const res = await app.inject({
      method: "POST",
      url: "/lab/export",
      payload: { runId: run.id },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("trainer_unreachable");
  });

  // The Hub push is the only way an artifact leaves an ephemeral trainer, so
  // the fields have to reach Studio together — repo_id without push_to_hub is
  // silently ignored, and the export looks like it worked.
  it("passes the hub target through when a repo is named", async () => {
    const calls: { saveDir: string; hub?: HubTarget }[] = [];
    let seq = 0;
    const app = await build(
      fakeStudio({
        exportGguf: async (saveDir: string, _q: string, hub?: HubTarget) => {
          calls.push({ saveDir, hub });
          seq += 1;
        },
        exportStatus: async () => ({
          is_export_active: false,
          last_op_seq: seq,
          last_op_status: "success",
          last_op_output_path: "/runs/7/gguf",
        }),
      }),
    );
    const run = seedRun(store, "/runs/7");

    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/export",
        payload: {
          runId: run.id,
          repoId: "me/qwen3-tuned",
          hfToken: "hf_secret",
          private: true,
        },
      })
    ).json();

    expect((await settle(jobId))?.state).toBe("done");
    expect(calls[0]?.hub).toEqual({
      repoId: "me/qwen3-tuned",
      hfToken: "hf_secret",
      private: true,
    });
  });

  // Without this the Runs tab can't tell which row an export belongs to, and
  // pressing the button looked like it did nothing.
  it("attributes the export job to the run it exports", async () => {
    const app = await build();
    const run = seedRun(store, "/runs/7");

    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/export",
        payload: { runId: run.id },
      })
    ).json();

    await settle(jobId);
    expect(store.getJob(jobId)?.runId).toBe(run.id);
    // A finetune creates its run rather than acting on one.
    const finetuneJob = store.listJobs().find((j) => j.kind === "finetune");
    expect(finetuneJob?.runId).toBeNull();
  });

  it("records the hub repo on the run, and says so when there wasn't one", async () => {
    const app = await build();
    const pushed = seedRun(store, "/runs/7");
    const kept = seedRun(store, "/runs/8");

    const a = (
      await app.inject({
        method: "POST",
        url: "/lab/export",
        payload: { runId: pushed.id, repoId: "me/qwen3-tuned" },
      })
    ).json();
    await settle(a.jobId);

    const b = (
      await app.inject({
        method: "POST",
        url: "/lab/export",
        payload: { runId: kept.id },
      })
    ).json();
    await settle(b.jobId);

    expect(store.getRun(pushed.id)?.hubRepo).toBe("me/qwen3-tuned");
    expect(store.getJob(a.jobId)?.detail).toContain("pushed to me/qwen3-tuned");
    // The one that went nowhere has to say so — that is the whole question a
    // user has after an export against an ephemeral trainer.
    expect(store.getRun(kept.id)?.hubRepo).toBeNull();
    expect(store.getJob(b.jobId)?.detail).toContain("not pushed anywhere");
  });

  it("keeps the token out of anything it writes down", async () => {
    const app = await build();
    const run = seedRun(store, "/runs/7");

    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/export",
        payload: {
          runId: run.id,
          repoId: "me/qwen3-tuned",
          hfToken: "hf_secret",
        },
      })
    ).json();

    await settle(jobId);
    const written = JSON.stringify([store.getJob(jobId), store.getRun(run.id)]);
    expect(written).not.toContain("hf_secret");
    // The repo is fine to show — it's where the artifact went.
    expect(store.getJob(jobId)?.detail).toContain("me/qwen3-tuned");
  });

  // Quantization outlives the request that starts it (a Cloudflare tunnel cuts
  // at ~100s with a 524) while Studio keeps working. Losing the kickoff
  // response must not fail a job whose export is running.
  it("keeps polling when the kickoff response is lost but the export started", async () => {
    let seq = 0;
    let active = false;
    const app = await build(
      fakeStudio({
        exportGguf: async () => {
          active = true;
          // Simulate the work finishing shortly after the connection drops.
          setTimeout(() => {
            active = false;
            seq = 5;
          }, 100);
          throw new Error("studio responded 524");
        },
        exportStatus: async () => ({
          is_export_active: active,
          last_op_seq: seq,
          last_op_status: "success",
          last_op_output_path: "/runs/10/gguf",
        }),
      }),
    );
    const run = seedRun(store, "/runs/10");
    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/export",
        payload: { runId: run.id },
      })
    ).json();

    expect((await settle(jobId))?.state).toBe("done");
    expect(store.getRun(run.id)?.ggufPath).toBe("/runs/10/gguf");
  });

  // But a kickoff that genuinely failed, with nothing running, is a failure.
  it("fails when the kickoff errored and no export started", async () => {
    const app = await build(
      fakeStudio({
        exportGguf: async () => {
          throw new Error("studio responded 405");
        },
        exportStatus: async () => ({
          is_export_active: false,
          last_op_seq: 0,
          last_op_status: "success",
        }),
      }),
    );
    const run = seedRun(store, "/runs/11");
    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/export",
        payload: { runId: run.id },
      })
    ).json();

    const job = await settle(jobId);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("405");
  });

  it("fails the job when Studio reports the export errored", async () => {
    // Counter advances (the export ran), but the outcome is a failure.
    let seq = 0;
    const app = await build(
      fakeStudio({
        exportGguf: async () => {
          seq += 1;
        },
        exportStatus: async () => ({
          is_export_active: false,
          last_op_seq: seq,
          last_op_status: seq > 0 ? "error" : "success",
          last_op_error: "not enough disk space",
        }),
      }),
    );
    const run = seedRun(store, "/runs/8");
    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/export",
        payload: { runId: run.id },
      })
    ).json();

    const job = await settle(jobId);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("not enough disk space");
  });

  // Studio reports the *last* operation, so a previous export's success would
  // otherwise be read as ours and finish the job instantly against a stale
  // artifact. The op counter is what tells them apart.
  it("does not accept a stale success from an earlier export", async () => {
    const app = await build(
      fakeStudio({
        // Already-successful op, and the counter never moves for ours.
        exportStatus: async () => ({
          is_export_active: false,
          last_op_seq: 42,
          last_op_status: "success",
          last_op_output_path: "/runs/OLD/gguf",
        }),
      }),
    );
    const run = seedRun(store, "/runs/9");
    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/export",
        payload: { runId: run.id },
      })
    ).json();

    await new Promise((r) => setTimeout(r, 150));
    expect(store.getJob(jobId)?.state).toBe("running");
    expect(store.getRun(run.id)?.ggufPath).toBeNull();
  });
});

// Stopping a run you started by mistake. The suites already honour a signal —
// the personal loop checks it per case, the general one SIGTERMs lm_eval — so
// what is tested here is that a controller reaches them and that the outcome is
// recorded as a deliberate stop rather than a break.
describe("POST /lab/jobs/:id/cancel", () => {
  /** Start a benchmark and hand back its job id. */
  async function startBenchmark(app: FastifyInstance) {
    const res = await app.inject({
      method: "POST",
      url: "/lab/benchmark",
      payload: {
        model: "loaded-model",
        suite: "penumbra-tools-v1",
        samplesPerTask: 50,
      },
    });
    expect(res.statusCode).toBe(202);
    return res.json().jobId as string;
  }

  it("stops a running benchmark and records it as cancelled", async () => {
    // Accepts the request and never answers, so the run is genuinely in flight
    // when the cancel lands. A refused port would finish first and the test
    // would pass or fail on a race rather than on the behaviour.
    const hanging = createServer(() => {});
    const url = await new Promise<string>((resolve) =>
      hanging.listen(0, "127.0.0.1", () =>
        resolve(`http://127.0.0.1:${(hanging.address() as AddressInfo).port}`),
      ),
    );

    try {
      const app = await build(fakeStudio(), undefined, undefined, url);
      const id = await startBenchmark(app);
      await vi.waitFor(async () => {
        const job = (await app.inject({ url: `/lab/jobs/${id}` })).json();
        expect(job.state).toBe("running");
      });

      const res = await app.inject({
        method: "POST",
        url: `/lab/jobs/${id}/cancel`,
      });
      expect(res.statusCode).toBe(202);

      // The signal reaches the in-flight fetch, so this settles rather than
      // waiting out a request that was never going to answer.
      await vi.waitFor(async () => {
        const job = (await app.inject({ url: `/lab/jobs/${id}` })).json();
        expect(job.state).toBe("cancelled");
      });

      // A partial suite is not a result; nothing may be written for one.
      expect((await app.inject({ url: "/lab/scores" })).json()).toEqual([]);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((r) => hanging.close(() => r()));
    }
  });

  // A row can outlive the process that owned it, and the user's instinct is to
  // press Cancel. Answering 409 there left the job "running" forever, blocking
  // every later run with no way out of the UI.
  it("clears a job whose process is gone rather than refusing", async () => {
    const app = await build();
    const orphan = store.createJob("benchmark");
    store.updateJob(orphan.id, { state: "running" });

    const res = await app.inject({
      method: "POST",
      url: `/lab/jobs/${orphan.id}/cancel`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, reconciled: true });
    expect(store.getJob(orphan.id)?.state).toBe("failed");
  });

  it("404s an unknown job", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/lab/jobs/nope/cancel",
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses a job that has already finished", async () => {
    const app = await build();
    const id = await startBenchmark(app);
    await vi.waitFor(async () => {
      const job = (await app.inject({ url: `/lab/jobs/${id}` })).json();
      expect(["done", "failed"]).toContain(job.state);
    });

    const res = await app.inject({
      method: "POST",
      url: `/lab/jobs/${id}/cancel`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_running");
  });

  it("is gated like the rest of the lab surface", async () => {
    const app = await build(fakeStudio(), "secret");
    const res = await app.inject({
      method: "POST",
      url: "/lab/jobs/any/cancel",
    });
    expect(res.statusCode).toBe(401);
  });
});

// The picker's list. Free text here used to be a trap: Studio ignores the
// `model` a request names and answers from whatever is resident, so a typo
// returned a full score attributed to another model rather than an error.
describe("GET /lab/models", () => {
  const inventory = [
    {
      id: "unsloth/gemma-4-12b-it-GGUF",
      load_id: "unsloth/gemma-4-12b-it-GGUF",
      display_name: "gemma-4-12b-it",
      size_bytes: 7_366_421_920,
      model_format: "gguf",
      capabilities: { can_chat: true, requires_variant: true },
    },
    {
      id: "loaded-model",
      load_id: "loaded-model",
      display_name: "loaded-model",
      size_bytes: 1_132_952_128,
      model_format: "gguf",
      capabilities: { can_chat: true, requires_variant: true },
    },
  ];

  it("lists the target's models and marks the resident one", async () => {
    const app = await build(
      fakeStudio({ listLocalModels: async () => inventory }),
    );
    const body = (await app.inject({ url: "/lab/models" })).json();

    expect(body.target).toBe("local");
    expect(body.models.map((m: { id: string }) => m.id)).toEqual([
      "unsloth/gemma-4-12b-it-GGUF",
      "loaded-model",
    ]);
    // `loadedModel` is the fake's default, and is the only entry a benchmark
    // would actually measure.
    expect(
      body.models.filter((m: { loaded: boolean }) => m.loaded),
    ).toHaveLength(1);
    expect(body.models[1]).toMatchObject({
      loaded: true,
      format: "gguf",
      requiresVariant: true,
      sizeBytes: 1_132_952_128,
    });
  });

  // The form has to stay usable when the inventory cannot be read: a short
  // picker is recoverable, an error that blanks the Lab is not. What is loaded
  // still comes from /v1/models, so the run the form exists for is still
  // offered — and the reason the rest is missing is reported rather than
  // swallowed.
  it("keeps the loaded model, and says why, when the target will not list", async () => {
    const app = await build(
      fakeStudio({
        listLocalModels: async () => {
          throw new Error("studio /api/hub/local responded 500");
        },
      }),
    );
    const res = await app.inject({ url: "/lab/models" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      target: "local",
      models: [{ id: "loaded-model", loaded: true }],
    });
    expect(res.json().inventoryError).toContain("500");
  });

  // The case that blocked benchmarking on Colab: a reachable target with a
  // model loaded, whose disk inventory lists nothing. The picker was empty, the
  // form disabled itself, and the GPU sat there with a model on it.
  it("offers a resident model the inventory never mentions", async () => {
    const app = await build(fakeStudio({ listLocalModels: async () => [] }));
    const body = (await app.inject({ url: "/lab/models" })).json();
    expect(body.models).toMatchObject([{ id: "loaded-model", loaded: true }]);
    expect(body.inventoryError).toBeNull();
  });

  it("marks nothing loaded when the target has nothing resident", async () => {
    const app = await build(
      fakeStudio({
        listLocalModels: async () => inventory,
        loadedModel: async () => null,
      }),
    );
    const body = (await app.inject({ url: "/lab/models" })).json();
    expect(body.models.some((m: { loaded: boolean }) => m.loaded)).toBe(false);
  });

  it("is gated like the rest of the lab surface", async () => {
    const app = await build(fakeStudio(), "secret");
    expect((await app.inject({ url: "/lab/models" })).statusCode).toBe(401);
  });
});

describe("POST /lab/benchmark", () => {
  it("rejects an unknown suite", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/lab/benchmark",
      payload: { model: "q", suite: "made-up" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown_suite");
  });

  it("accepts a personal-suite run", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/lab/benchmark",
      payload: { model: "q", suite: "penumbra-tools-v1", samplesPerTask: 1 },
    });
    expect(res.statusCode).toBe(202);
  });

  // Studio ignores the `model` field and serves whatever is resident, so a run
  // against an empty backend does not error — it scores nothing, or scores
  // whatever answers. Refusing up front is the only place this can be caught.
  it("refuses when the target has no model loaded", async () => {
    const app = await build(fakeStudio({ loadedModel: async () => null }));
    const res = await app.inject({
      method: "POST",
      url: "/lab/benchmark",
      payload: { model: "q", suite: "penumbra-tools-v1", samplesPerTask: 1 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_model_loaded");
    // Nothing was started, so no job row was left behind.
    expect(store.listJobs()).toEqual([]);
  });

  it("records what actually served, and where, not what was typed", async () => {
    fakeModel = startFakeModel();
    const app = await build(
      fakeStudio({ loadedModel: async () => "qwen3-8b" }),
      undefined,
      undefined,
      await fakeModel.listen(),
    );
    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/benchmark",
        payload: {
          model: "whatever-i-typed",
          suite: "penumbra-tools-v1",
          samplesPerTask: 1,
        },
      })
    ).json();
    expect((await settle(jobId))?.state).toBe("done");

    // The typed name is kept as the request, but the scores are attributed to
    // the model that answered — the two differ here precisely because Studio
    // ignores the field.
    expect(store.listScores()[0]).toMatchObject({
      model: "whatever-i-typed",
      servedModel: "qwen3-8b",
      target: "local",
    });
  });

  it("attributes a run to the target the benchmark role points at", async () => {
    fakeModel = startFakeModel();
    const app = await build(
      fakeStudio(),
      undefined,
      fakeStudio({ loadedModel: async () => "big-model" }),
      await fakeModel.listen(),
    );
    configureColab();
    targets.assign("benchmark", "colab");

    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/benchmark",
        payload: { model: "q", suite: "penumbra-tools-v1", samplesPerTask: 1 },
      })
    ).json();
    expect((await settle(jobId))?.state).toBe("done");

    expect(store.listScores()[0]).toMatchObject({
      servedModel: "big-model",
      target: "colab",
    });
  });
});

describe("GET /lab/jobs/:id", () => {
  it("returns the job", async () => {
    const app = await build();
    const job = store.createJob("benchmark");
    expect((await app.inject({ url: `/lab/jobs/${job.id}` })).json().id).toBe(
      job.id,
    );
  });

  it("404s an unknown id", async () => {
    const app = await build();
    expect((await app.inject({ url: "/lab/jobs/nope" })).statusCode).toBe(404);
  });
});

// Studio refuses an absolute dataset path that isn't under one of its own
// dataset roots ("dataset path must be relative or under a dataset root"), and
// our upload root is deliberately somewhere else. Getting this wrong fails the
// run at Studio's door, minutes after the user pressed start.
describe("POST /lab/finetune — local datasets", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "penumbra-ds-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A Studio that records what it was asked to train on. */
  function trainingSpy(over: Partial<StudioClient> = {}) {
    const seen: { uploaded: string[]; start: TrainingStart[] } = {
      uploaded: [],
      start: [],
    };
    const studio = fakeStudio({
      uploadDataset: async (path: string) => {
        seen.uploaded.push(path);
        return "/home/u/.unsloth/studio/assets/datasets/uploads/abc_train.jsonl";
      },
      startTraining: async (body: TrainingStart) => {
        seen.start.push(body);
      },
      async *trainingProgress() {
        yield { event: "complete", data: {} };
      },
      ...over,
    } as Partial<StudioClient>);
    return { studio, seen };
  }

  it("sends a dataset held on this host through Studio and trains from the path it returns", async () => {
    const local = join(dir, "train.jsonl");
    await writeFile(local, '{"text":"hi"}\n');
    const { studio, seen } = trainingSpy();
    const app = await build(studio);

    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/finetune",
        payload: { baseModel: "qwen", dataset: { kind: "local", path: local } },
      })
    ).json();

    expect((await settle(jobId))?.state).toBe("done");
    expect(seen.uploaded).toEqual([local]);
    expect(seen.start[0]?.local_datasets).toEqual([
      "/home/u/.unsloth/studio/assets/datasets/uploads/abc_train.jsonl",
    ]);
  });

  it("passes through a name only Studio can resolve", async () => {
    // A relative dataset name is Studio's to resolve under its own roots; this
    // host has no such file and must not try to upload one.
    const { studio, seen } = trainingSpy();
    const app = await build(studio);

    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/finetune",
        payload: {
          baseModel: "qwen",
          dataset: { kind: "local", path: "uploads/train.jsonl" },
        },
      })
    ).json();

    expect((await settle(jobId))?.state).toBe("done");
    expect(seen.uploaded).toEqual([]);
    expect(seen.start[0]?.local_datasets).toEqual(["uploads/train.jsonl"]);
  });

  it("fails the job with Studio's reason when the dataset is rejected", async () => {
    const local = join(dir, "train.jsonl");
    await writeFile(local, '{"text":"hi"}\n');
    const { studio } = trainingSpy({
      uploadDataset: async () => {
        throw new Error("studio /api/datasets/upload responded 413: too large");
      },
    });
    const app = await build(studio);

    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/finetune",
        payload: { baseModel: "qwen", dataset: { kind: "local", path: local } },
      })
    ).json();

    const job = await settle(jobId);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("413");
  });

  it("leaves an HF dataset alone", async () => {
    const { studio, seen } = trainingSpy();
    const app = await build(studio);

    const { jobId } = (
      await app.inject({
        method: "POST",
        url: "/lab/finetune",
        payload: finetuneBody,
      })
    ).json();

    expect((await settle(jobId))?.state).toBe("done");
    expect(seen.uploaded).toEqual([]);
    expect(seen.start[0]?.hf_dataset).toBe("tatsu-lab/alpaca");
    expect(seen.start[0]?.local_datasets).toBeUndefined();
  });
});

describe("POST /lab/models/plan", () => {
  let uploads: string;
  const saved = process.env.PENUMBRA_UPLOAD_DIR;

  beforeEach(async () => {
    uploads = await mkdtemp(join(tmpdir(), "penumbra-plan-"));
    process.env.PENUMBRA_UPLOAD_DIR = uploads;
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.PENUMBRA_UPLOAD_DIR;
    else process.env.PENUMBRA_UPLOAD_DIR = saved;
    await rm(uploads, { recursive: true, force: true });
  });

  it("names every file when the host holds none of them", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/lab/models/plan",
      payload: {
        name: "Qwen3-1.7B",
        files: [
          { rel: "config.json", size: 100 },
          { rel: "model.safetensors", size: 200 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().need).toEqual(["config.json", "model.safetensors"]);
  });

  it("refuses up front when the model can't fit", async () => {
    // The whole point of the preflight: no chunk is written, so the disk never
    // fills and the client gets a reason instead of a mid-transfer 500.
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/lab/models/plan",
      payload: {
        name: "huge",
        files: [{ rel: "model.safetensors", size: Number.MAX_SAFE_INTEGER }],
      },
    });
    expect(res.statusCode).toBe(507);
    expect(res.json().error).toBe("insufficient_space");
    expect(res.json().free).toBeGreaterThanOrEqual(0);
  });
});

// The handle the routes return is the same orchestration the routes use, not a
// second copy. That matters beyond tidiness: `inFlight` decides what can be
// cancelled and the job rows are what the UI polls, so a lab started from a
// conversation must land in exactly the places the Lab's own screen reads.
describe("the in-process service", () => {
  it("starts runs the HTTP surface then reports", async () => {
    const app = await build();
    const started = await lab.finetune(
      finetuneRequest.parse({
        baseModel: "unsloth/Qwen3-1.7B",
        dataset: { kind: "hf", id: "tatsu-lab/alpaca" },
      }),
    );
    if (!started.ok) throw new Error(started.message);

    const jobs = await app.inject({ method: "GET", url: "/lab/jobs" });
    expect(jobs.json().map((j: { id: string }) => j.id)).toContain(
      started.jobId,
    );
    const runs = await app.inject({ method: "GET", url: "/lab/runs" });
    expect(runs.json().map((r: { id: string }) => r.id)).toContain(
      started.runId,
    );
    // Both readers agree because there is only one store behind them.
    expect(lab.jobs().map((j) => j.id)).toEqual(
      jobs.json().map((j: { id: string }) => j.id),
    );
  });

  // The route requires a model name; the service does not, because Studio
  // serves what is resident whatever the request says. An unnamed one must be
  // filled with what will actually answer, or the scores carry no label at all.
  it("labels an unnamed benchmark with the model that will answer", async () => {
    fakeModel = startFakeModel();
    const baseURL = await fakeModel.listen();
    const app = await build(fakeStudio(), undefined, undefined, baseURL);

    const started = await lab.benchmark({
      suite: "penumbra-tools-v1",
      samplesPerTask: 1,
    });
    if (!started.ok) throw new Error(started.message);

    expect((await settle(started.jobId))?.state).toBe("done");
    const scores = await app.inject({ method: "GET", url: "/lab/scores" });
    expect(scores.json()[0].model).toBe("loaded-model");
    expect(scores.json()[0].servedModel).toBe("loaded-model");
  });

  it("refuses rather than throwing when there is nowhere to run", async () => {
    await build();
    expect(
      await lab.benchmark({ suite: "made-up", samplesPerTask: 1 }),
    ).toEqual({
      ok: false,
      error: "unknown_suite",
      message: 'there is no suite called "made-up"',
    });
  });
});
