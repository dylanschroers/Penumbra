import type { BenchmarkResult } from "@ghost/shared";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createLabStore, type LabStore } from "./jobs";

let store: LabStore;
beforeEach(() => {
  store = createLabStore(new Database(":memory:"));
});

const result = (over: Partial<BenchmarkResult> = {}): BenchmarkResult => ({
  suite: "ghost-tools-v1",
  suiteKind: "personal",
  model: "qwen",
  samplesPerTask: 20,
  at: "2026-07-18T12:00:00.000Z",
  durationMs: 1000,
  scores: [
    { task: "tool_selection", metric: "acc", value: 0.96 },
    { task: "false_positives", metric: "rate", value: 0 },
  ],
  ...over,
});

describe("jobs", () => {
  it("starts queued and reports back", () => {
    const job = store.createJob("finetune");
    expect(job).toMatchObject({ kind: "finetune", state: "queued" });
    expect(store.getJob(job.id)?.id).toBe(job.id);
  });

  // A progress tick must not wipe the detail line, and vice versa — the UI
  // reads both, and they arrive from different events.
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

describe("runs", () => {
  it("records artifacts as each stage produces them", () => {
    const job = store.createJob("finetune");
    const run = store.createRun({
      jobId: job.id,
      baseModel: "qwen",
      dataset: "hf/dataset",
      outputDir: null,
      ggufPath: null,
    });

    store.setRunArtifacts(run.id, { outputDir: "/runs/1" });
    expect(store.getRun(run.id)).toMatchObject({ outputDir: "/runs/1" });

    // Export lands later and must not blank the training output.
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
      suite: "ghost-tools-v1",
      suiteKind: "personal",
      model: "qwen",
      samplesPerTask: 20,
    });
    expect(stored?.scores).toHaveLength(2);
  });

  // The two families must stay distinguishable, or a general score gets
  // compared against a personal one and the comparison is meaningless.
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
