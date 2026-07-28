import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "./credentials";
import { createLabStore, type LabStore } from "./jobs";
import { registerLabRoutes } from "./routes";
import { type HubTarget, StudioClient, type TrainingStart } from "./studio";

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
    startTraining: async () => {},
    uploadDataset: async (path: string) => path,
    listRuns: async () => [],
    async *trainingProgress() {},
    loadCheckpoint: async () => {},
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

beforeEach(() => {
  store = createLabStore(new Database(":memory:"));
});
afterEach(() => app?.close());

async function build(
  studio = fakeStudio(),
  token?: string,
  makeColab?: (config: { baseURL: string; apiKey?: string }) => StudioClient,
) {
  app = Fastify();
  registerLabRoutes(app, { store, studio, token, makeColab });
  await app.ready();
  return app;
}

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

const colabConfig = {
  baseURL: "https://tunnel.example",
  apiKey: "colab-secret",
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
  it("reports Studio reachability and the suite catalog", async () => {
    const app = await build();
    const body = (await app.inject({ url: "/lab/status" })).json();

    expect(body.studio).toBe("ready");
    expect(body.suites.map((s: { id: string }) => s.id)).toContain(
      "penumbra-tools-v1",
    );
  });

  it("says so honestly when Studio is down", async () => {
    const app = await build(fakeStudio({ reachable: async () => false }));
    expect((await app.inject({ url: "/lab/status" })).json().studio).toBe(
      "stopped",
    );
  });

  it("distinguishes an unauthorized Studio from a stopped one", async () => {
    const app = await build(
      fakeStudio({ probe: async () => "unauthorized" as const }),
    );
    expect((await app.inject({ url: "/lab/status" })).json().studio).toBe(
      "unauthorized",
    );
  });

  it("reports no Colab fallback until one is configured", async () => {
    const app = await build();
    expect(
      (await app.inject({ url: "/lab/status" })).json().colab,
    ).toMatchObject({ configured: false, baseURL: null });
  });
});

// Rotating Studio's key used to mean editing .env and restarting the server.
describe("POST /lab/provider/local", () => {
  async function buildWithCredentials() {
    const db = new Database(":memory:");
    const credentials = createCredentialStore(db, {
      UNSLOTH_BASE_URL: "http://env:8888",
      UNSLOTH_API_KEY: "env-key",
    });
    app = Fastify();
    registerLabRoutes(app, {
      store,
      credentials,
      studio: new StudioClient(credentials.current()),
    });
    await app.ready();
    return { app, credentials };
  }

  it("stores a rotated key and reports where the running values came from", async () => {
    const { app, credentials } = await buildWithCredentials();

    expect(
      (await app.inject({ url: "/lab/status" })).json().local,
    ).toMatchObject({
      baseURL: "http://env:8888",
      source: "env",
      hasKey: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/lab/provider/local",
      payload: { baseURL: "http://studio.lan:8888", apiKey: "rotated" },
    });

    expect(res.statusCode).toBe(200);
    expect(credentials.current().apiKey).toBe("rotated");
    // The client the lab trains through follows without a restart.
    expect(
      (await app.inject({ url: "/lab/status" })).json().local,
    ).toMatchObject({ baseURL: "http://studio.lan:8888", source: "settings" });
  });

  it("never sends the key back", async () => {
    const { app } = await buildWithCredentials();
    await app.inject({
      method: "POST",
      url: "/lab/provider/local",
      payload: { apiKey: "rotated" },
    });

    const body = (await app.inject({ url: "/lab/status" })).body;
    expect(body).not.toContain("rotated");
    expect(body).not.toContain("env-key");
  });

  it("reverts to the environment on delete", async () => {
    const { app } = await buildWithCredentials();
    await app.inject({
      method: "POST",
      url: "/lab/provider/local",
      payload: { baseURL: "http://studio.lan:8888" },
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/lab/provider/local",
    });

    expect(res.json()).toMatchObject({
      baseURL: "http://env:8888",
      source: "env",
    });
  });

  it("rejects an empty patch and a bad URL", async () => {
    const { app } = await buildWithCredentials();
    for (const payload of [{}, { baseURL: "not-a-url" }]) {
      const res = await app.inject({
        method: "POST",
        url: "/lab/provider/local",
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("Colab provider", () => {
  it("configures a fallback and reflects it in status, never echoing the key", async () => {
    const built = fakeStudio({ baseURL: "https://tunnel.example" });
    const app = await build(fakeStudio(), undefined, () => built);

    const set = await app.inject({
      method: "POST",
      url: "/lab/provider/colab",
      payload: colabConfig,
    });
    expect(set.statusCode).toBe(200);
    // The URL is echoed to confirm the target; the bearer is not.
    expect(JSON.stringify(set.json())).not.toContain("colab-secret");

    const status = (await app.inject({ url: "/lab/status" })).json();
    expect(status.colab).toMatchObject({
      configured: true,
      baseURL: "https://tunnel.example",
      studio: "ready",
    });
  });

  it("rejects a malformed endpoint", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/lab/provider/colab",
      payload: { baseURL: "not-a-url" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("clears the fallback on DELETE", async () => {
    const app = await build(fakeStudio(), undefined, () => fakeStudio());
    await app.inject({
      method: "POST",
      url: "/lab/provider/colab",
      payload: colabConfig,
    });
    await app.inject({ method: "DELETE", url: "/lab/provider/colab" });
    expect(
      (await app.inject({ url: "/lab/status" })).json().colab.configured,
    ).toBe(false);
  });

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
      () => colab,
    );
    await app.inject({
      method: "POST",
      url: "/lab/provider/colab",
      payload: colabConfig,
    });

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

  // Colab resolves an unknown model name against HuggingFace, so a path from
  // this machine comes back as "Repo id must use alphanumeric chars…" minutes
  // later. There is no model-upload endpoint to fix it with, so refuse early.
  it("refuses a local model path when the run would go to Colab", async () => {
    const app = await build(
      fakeStudio({ reachable: async () => false }),
      undefined,
      () => fakeStudio({ baseURL: "https://tunnel.example" }),
    );
    await app.inject({
      method: "POST",
      url: "/lab/provider/colab",
      payload: colabConfig,
    });

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
      () => colab,
    );
    await app.inject({
      method: "POST",
      url: "/lab/provider/colab",
      payload: colabConfig,
    });

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
