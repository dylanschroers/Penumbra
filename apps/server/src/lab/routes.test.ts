import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLabStore, type LabStore } from "./jobs";
import { registerLabRoutes } from "./routes";
import type { StudioClient } from "./studio";

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

/** A finished fine-tune with a checkpoint on disk, ready to export. */
function seedRun(store: LabStore, outputDir: string) {
  const job = store.createJob("finetune");
  return store.createRun({
    jobId: job.id,
    baseModel: "q",
    dataset: "d",
    outputDir,
    ggufPath: null,
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

describe("Colab provider", () => {
  const colabConfig = {
    baseURL: "https://tunnel.example",
    apiKey: "colab-secret",
  };

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
    const job = store.createJob("finetune");
    const run = store.createRun({
      jobId: job.id,
      baseModel: "q",
      dataset: "d",
      outputDir: null,
      ggufPath: null,
    });

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
    const job = store.createJob("finetune");
    const run = store.createRun({
      jobId: job.id,
      baseModel: "q",
      dataset: "d",
      outputDir: "/runs/7",
      ggufPath: null,
    });

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
