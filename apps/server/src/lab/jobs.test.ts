import type { BenchmarkResult } from "@penumbra/shared";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createLabStore, type LabStore } from "./jobs";

let store: LabStore;
beforeEach(() => {
  store = createLabStore(new Database(":memory:"));
});

const result = (over: Partial<BenchmarkResult> = {}): BenchmarkResult => ({
  suite: "penumbra-tools-v1",
  suiteKind: "personal",
  model: "qwen",
  servedModel: "qwen",
  target: "local",
  samplesPerTask: 20,
  at: "2026-07-18T12:00:00.000Z",
  durationMs: 1000,
  scores: [
    { task: "tool_selection", metric: "acc", value: 0.96 },
    { task: "false_positives", metric: "rate", value: 0 },
  ],
  ...over,
});

// Old databases predate the provider column; their runs were all local.
describe("schema migration", () => {
  it("adds the provider column to a database that lacks it", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE lab_runs (
      id text PRIMARY KEY NOT NULL,
      job_id text NOT NULL,
      base_model text NOT NULL,
      dataset text NOT NULL,
      output_dir text,
      gguf_path text,
      created_at text NOT NULL
    );
    INSERT INTO lab_runs VALUES
      ('r1','j1','qwen','d','/runs/1',NULL,'2026-07-01T00:00:00.000Z');`);

    const migrated = createLabStore(db);

    expect(migrated.getRun("r1")?.provider).toBe("local");
    const job = migrated.createJob("finetune");
    const fresh = migrated.createRun({
      jobId: job.id,
      baseModel: "qwen",
      dataset: "d",
      outputDir: null,
      ggufPath: null,
      hubRepo: null,
      provider: "colab",
    });
    expect(migrated.getRun(fresh.id)?.provider).toBe("colab");
  });

  it("is safe to open the same database twice", () => {
    const db = new Database(":memory:");
    createLabStore(db);
    expect(() => createLabStore(db)).not.toThrow();
  });
});

describe("jobs", () => {
  it("starts queued and reports back", () => {
    const job = store.createJob("finetune");
    expect(job).toMatchObject({ kind: "finetune", state: "queued" });
    expect(store.getJob(job.id)?.id).toBe(job.id);
  });

  // Progress and detail arrive from different events; neither may blank the
  // other.
  it("leaves omitted fields untouched on partial updates", () => {
    const job = store.createJob("finetune");
    store.updateJob(job.id, { state: "running", detail: "step 1/60" });
    store.updateJob(job.id, { progress: 0.5 });

    expect(store.getJob(job.id)).toMatchObject({
      state: "running",
      detail: "step 1/60",
      progress: 0.5,
    });
  });

  it("records a failure with its message", () => {
    const job = store.createJob("export");
    store.failJob(job.id, new Error("studio said no"));
    expect(store.getJob(job.id)).toMatchObject({
      state: "failed",
      error: "studio said no",
    });
  });

  it("stringifies a non-Error failure rather than losing it", () => {
    const job = store.createJob("export");
    store.failJob(job.id, "plain string");
    expect(store.getJob(job.id)?.error).toBe("plain string");
  });

  it("returns a miss instead of throwing for an unknown id", () => {
    expect(store.getJob("nope")).toBeUndefined();
    expect(store.updateJob("nope", { state: "done" })).toBeUndefined();
  });

  it("lists newest first", () => {
    store.createJob("finetune");
    const second = store.createJob("benchmark");
    expect(store.listJobs()[0]?.id).toBe(second.id);
  });
});

// After a restart, running/queued jobs name a dead process and would block the
// Lab forever, since the form disables itself while a job runs.
describe("orphaned jobs on startup", () => {
  function reopenWith(state: string) {
    const db = new Database(":memory:");
    const first = createLabStore(db);
    const job = first.createJob("benchmark");
    first.updateJob(job.id, { state: state as never, detail: "48%" });
    // A second store over the same file is a restart.
    return { store: createLabStore(db), id: job.id };
  }

  it.each(["running", "queued"])("fails a %s job left behind", (state) => {
    const { store, id } = reopenWith(state);
    const job = store.getJob(id);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("Interrupted");
  });

  it.each(["done", "failed", "cancelled"])("leaves a %s job alone", (state) => {
    const { store, id } = reopenWith(state);
    expect(store.getJob(id)?.state).toBe(state);
  });
});

describe("runs", () => {
  it("records artifacts as each stage produces them", () => {
    const job = store.createJob("finetune");
    const run = store.createRun({
      jobId: job.id,
      baseModel: "qwen",
      dataset: "hf/dataset",
      outputDir: null,
      ggufPath: null,
      hubRepo: null,
      provider: "local",
    });

    store.setRunArtifacts(run.id, { outputDir: "/runs/1" });
    expect(store.getRun(run.id)).toMatchObject({ outputDir: "/runs/1" });

    store.setRunArtifacts(run.id, { ggufPath: "/runs/1/gguf" });
    expect(store.getRun(run.id)).toMatchObject({
      outputDir: "/runs/1",
      ggufPath: "/runs/1/gguf",
    });
  });
});

describe("scores", () => {
  it("round-trips a result through the per-metric rows", () => {
    store.recordScores(result());
    const [stored] = store.listScores();

    expect(stored).toMatchObject({
      suite: "penumbra-tools-v1",
      suiteKind: "personal",
      model: "qwen",
      samplesPerTask: 20,
    });
    expect(stored?.scores).toHaveLength(2);
  });

  it("keeps runs of different families separate", () => {
    store.recordScores(result());
    store.recordScores(
      result({
        suite: "general-v1",
        suiteKind: "general",
        at: "2026-07-18T13:00:00.000Z",
        scores: [{ task: "gsm8k", metric: "exact_match", value: 0.42 }],
      }),
    );

    const all = store.listScores();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.suiteKind).sort()).toEqual(["general", "personal"]);
  });

  it("does not merge two runs of the same suite at different times", () => {
    store.recordScores(result());
    store.recordScores(result({ at: "2026-07-18T14:00:00.000Z" }));
    expect(store.listScores()).toHaveLength(2);
  });

  it("keeps separate models apart within one timestamp", () => {
    store.recordScores(result());
    store.recordScores(result({ model: "llama" }));
    expect(
      store
        .listScores()
        .map((r) => r.model)
        .sort(),
    ).toEqual(["llama", "qwen"]);
  });
});
