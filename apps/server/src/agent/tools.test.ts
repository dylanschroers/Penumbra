import {
  type BenchmarkResult,
  LAB_POLICY,
  type LabJob,
  type LabRun,
  type ToolBindings,
} from "@penumbra/shared";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { LabService } from "../lab/routes";
import { createServerTaskStore, type ServerTaskStore } from "../store/tasks";
import { createTaskSyncStore } from "../sync/store";
import { createServerTools } from "./tools";

// These run against a real in-memory store rather than a mock, so a tool that
// writes a row the sync layer would reject fails here.
let store: ServerTaskStore;
let run: ToolBindings["runTool"];

beforeEach(() => {
  const db = new Database(":memory:");
  store = createServerTaskStore(db, createTaskSyncStore(db));
  run = createServerTools(store).runTool;
});

describe("dispatch", () => {
  it("reports an unknown tool instead of throwing", async () => {
    expect(await run("nope", {})).toBe("Unknown tool: nope");
  });

  // The model sees the failure text and can usually correct itself next step,
  // which is why this is a returned string and not an exception.
  it("returns validation failures as readable text", async () => {
    const result = await run("create_task", {}); // title is required
    expect(result).toContain("Invalid arguments for create_task");
    expect(result).toContain("title");
  });

  it("advertises exactly the shared contracts", () => {
    const { tools } = createServerTools(store);
    expect(tools.map((t) => t.function.name).sort()).toEqual([
      "complete_task",
      "create_task",
      "delete_task",
      "get_weather",
      "list_tasks",
    ]);
  });
});

describe("create_task", () => {
  it("writes a task the store can list", async () => {
    const result = await run("create_task", { title: "buy milk" });
    expect(result).toBe('Created task "buy milk" (medium priority).');
    expect(store.listTasks().map((t) => t.title)).toEqual(["buy milk"]);
  });

  // A live model invented "2023-10-15T12:00:00Z" for a request with no date at
  // all (AGENT_DESIGN.md §7). Garbage must not reach the store's schema.
  it("drops an unparseable date rather than failing the write", async () => {
    await run("create_task", { title: "x", dueAt: "whenever" });
    expect(store.listTasks()[0]?.dueAt).toBeNull();
  });

  it("normalizes a parseable date to ISO", async () => {
    await run("create_task", { title: "x", dueAt: "2026-01-15" });
    expect(store.listTasks()[0]?.dueAt).toBe("2026-01-15T00:00:00.000Z");
  });
});

describe("list_tasks", () => {
  it("summarizes tasks for the model", async () => {
    await run("create_task", { title: "a", priority: "high" });
    expect(await run("list_tasks", {})).toBe("- a [todo, high]");
  });

  it("filters by status", async () => {
    await run("create_task", { title: "a" });
    await run("create_task", { title: "b" });
    await run("complete_task", { title: "a" });
    expect(await run("list_tasks", { status: "done" })).toBe(
      "- a [done, medium]",
    );
  });

  it("says so when there is nothing to report", async () => {
    expect(await run("list_tasks", {})).toBe("No matching tasks.");
  });
});

describe("complete_task and delete_task", () => {
  it("matches a title case-insensitively", async () => {
    await run("create_task", { title: "buy milk" });
    expect(await run("complete_task", { title: "BUY MILK" })).toBe(
      'Marked "buy milk" as done.',
    );
    expect(store.listTasks()[0]?.status).toBe("done");
  });

  it("falls back to a partial title match", async () => {
    await run("create_task", { title: "buy oat milk today" });
    await run("complete_task", { title: "oat milk" });
    expect(store.listTasks()[0]?.status).toBe("done");
  });

  it("reports a miss without touching anything", async () => {
    await run("create_task", { title: "keep" });
    expect(await run("complete_task", { title: "penumbra" })).toBe(
      'No task matching "penumbra".',
    );
    expect(store.listTasks()[0]?.status).toBe("todo");
  });

  it("tombstones on delete so the deletion syncs", async () => {
    await run("create_task", { title: "gone" });
    expect(await run("delete_task", { title: "gone" })).toBe('Deleted "gone".');
    expect(store.listTasks()).toEqual([]);
  });
});

// The Model Lab half, which only this tier can run. A fake Lab rather than a
// live one: what is under test here is the binding — argument mapping, the
// wording handed back to the model, and that a refusal is relayed rather than
// thrown — not the orchestration behind it, which ../lab/routes.test.ts covers.
function fakeLab(over: Partial<LabService> = {}): LabService {
  return {
    models: async () => ({ target: "local", models: [], inventoryError: null }),
    datasets: async () => [],
    finetune: async () => ({ ok: true, jobId: "job-1", runId: "run-1" }),
    benchmark: async () => ({ ok: true, jobId: "job-2" }),
    jobs: () => [],
    job: () => undefined,
    runs: () => [],
    scores: () => [],
    ...over,
  };
}

const trained = (over: Partial<LabRun> = {}): LabRun => ({
  id: "1f0a2b3c-dead-beef-0000-000000000000",
  jobId: "job-1",
  baseModel: "unsloth/Qwen3-1.7B",
  dataset: "/uploads/datasets/train.jsonl",
  outputDir: "/studio/runs/1",
  ggufPath: null,
  hubRepo: null,
  provider: "local",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const score = (over: Partial<BenchmarkResult> = {}): BenchmarkResult => ({
  suite: "penumbra-tools-v1",
  suiteKind: "personal",
  model: "qwen3-1.7b",
  servedModel: "qwen3-1.7b",
  target: "local",
  samplesPerTask: 20,
  at: "2026-01-02T00:00:00.000Z",
  durationMs: 1000,
  scores: [{ task: "tool_selection", metric: "acc", value: 0.923456 }],
  ...over,
});

function labRun(lab: LabService = fakeLab()): ToolBindings["runTool"] {
  return createServerTools(store, lab).runTool;
}

const job = (over: Partial<LabJob> = {}): LabJob => ({
  id: "job-1",
  kind: "finetune",
  state: "running",
  progress: 0.5,
  detail: "step 30/60",
  error: null,
  runId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("lab tools", () => {
  // The lab tools and the prompt that says when to use them travel together: a
  // tier advertising the tools with no policy behind them has six actuators
  // and nothing telling the model they are in scope.
  it("advertises them, with their policy, only when a lab is wired", () => {
    const withLab = createServerTools(store, fakeLab());
    expect(withLab.tools.map((t) => t.function.name)).toEqual([
      "create_task",
      "list_tasks",
      "complete_task",
      "delete_task",
      "get_weather",
      "list_models",
      "list_datasets",
      "start_finetune",
      "run_benchmark",
      "job_status",
      "lab_history",
    ]);
    expect(withLab.system).toContain(LAB_POLICY);

    const without = createServerTools(store);
    expect(without.tools).toHaveLength(5);
    expect(without.system).not.toContain(LAB_POLICY);
  });

  it("marks which model is loaded, since that is the one a run would score", async () => {
    const result = await labRun(
      fakeLab({
        models: async () => ({
          target: "colab",
          inventoryError: null,
          models: [
            {
              id: "a",
              label: "a",
              format: "gguf",
              sizeBytes: 2e9,
              requiresVariant: false,
              loaded: false,
            },
            {
              id: "b",
              label: "b",
              format: "safetensors",
              sizeBytes: 0,
              requiresVariant: false,
              loaded: true,
            },
          ],
        }),
      }),
    )("list_models", {});

    expect(result).toBe(
      "Models on colab:\n- a [gguf, 2.0 GB]\n- b [safetensors, size unknown] — loaded",
    );
  });

  // "nothing is there" and "we could not ask" look identical as an empty list
  // and need different fixes, so the model must be told which it got.
  it("reports an inventory failure instead of an empty shelf", async () => {
    const result = await labRun(
      fakeLab({
        models: async () => ({
          target: "local",
          models: [],
          inventoryError: "connection refused",
        }),
      }),
    )("list_models", {});
    expect(result).toContain("connection refused");
  });

  it("gives datasets with the path a run trains from", async () => {
    const lab = fakeLab({
      datasets: async () => [
        {
          name: "train.jsonl",
          path: "/uploads/datasets/train.jsonl",
          size: 3e6,
        },
      ],
    });
    expect(await labRun(lab)("list_datasets", {})).toBe(
      "- train.jsonl (3 MB) — /uploads/datasets/train.jsonl",
    );
    expect(await labRun()("list_datasets", {})).toContain("No datasets");
  });

  // Getting this wrong sends a path to Studio as a HuggingFace repo id, and the
  // run fails minutes later with an opaque error from the other side.
  it("classifies the dataset and fills the run's defaults", async () => {
    let seen: Parameters<LabService["finetune"]>[0] | undefined;
    const lab = fakeLab({
      finetune: async (input) => {
        seen = input;
        return { ok: true, jobId: "job-1", runId: "run-1" };
      },
    });

    const result = await labRun(lab)("start_finetune", {
      baseModel: "unsloth/Qwen3-1.7B",
      dataset: "/uploads/datasets/train.jsonl",
    });

    expect(seen?.dataset).toEqual({
      kind: "local",
      path: "/uploads/datasets/train.jsonl",
    });
    // Not restated in the tool contract, so they can only have come from the
    // wire schema the form goes through.
    expect(seen?.maxSteps).toBe(60);
    expect(seen?.loraR).toBe(16);
    expect(seen?.format).toBe("auto");
    // The id, not a result: training outlives the turn.
    expect(result).toContain("job-1");
    expect(result).toContain("job_status");

    await labRun(lab)("start_finetune", {
      baseModel: "m",
      dataset: "tatsu-lab/alpaca",
    });
    expect(seen?.dataset).toEqual({ kind: "hf", id: "tatsu-lab/alpaca" });
  });

  // A Studio that is down is an ordinary outcome to pass on, not an exception.
  it("relays a refusal as something the model can say", async () => {
    const result = await labRun(
      fakeLab({
        finetune: async () => ({
          ok: false,
          error: "no_trainer",
          message: "the local Studio is not answering",
        }),
      }),
    )("start_finetune", { baseModel: "m", dataset: "d" });
    expect(result).toBe(
      "Cannot start fine-tuning: the local Studio is not answering.",
    );
  });

  it("leaves the benchmark model unnamed so the loaded one is what gets labeled", async () => {
    let seen: Parameters<LabService["benchmark"]>[0] | undefined;
    const lab = fakeLab({
      benchmark: async (input) => {
        seen = input;
        return { ok: true, jobId: "job-2" };
      },
    });
    await labRun(lab)("run_benchmark", { suite: "penumbra-tools-v1" });
    expect(seen).toEqual({
      suite: "penumbra-tools-v1",
      samplesPerTask: 20,
      model: undefined,
    });
  });

  // The suite is an enum derived from SUITES, so a wrong one cannot be emitted
  // under a grammar — but the validation still has to hold for anything else.
  it("rejects a suite that does not exist", async () => {
    const result = await labRun()("run_benchmark", { suite: "made-up" });
    expect(result).toContain("Invalid arguments for run_benchmark");
  });

  it("reports one job's progress, or the recent ones", async () => {
    const lab = fakeLab({
      job: (id) => (id === "job-1" ? job() : undefined),
      jobs: () => [job({ state: "failed", progress: null, error: "OOM" })],
    });
    expect(await labRun(lab)("job_status", { jobId: "job-1" })).toBe(
      "finetune job-1: running 50% — step 30/60",
    );
    expect(await labRun(lab)("job_status", { jobId: "nope" })).toContain(
      "no job with id nope",
    );
    expect(await labRun(lab)("job_status", {})).toBe(
      "finetune job-1: failed — OOM",
    );
    expect(await labRun()("job_status", {})).toContain("No Model Lab jobs");
  });

  // A settled job keeps whatever progress it last reported, and runJob writes 1
  // on success — so an unguarded percentage says "failed 60%" about a run that
  // did not finish, and "cancelled 100%" about one that was stopped.
  it("drops the percentage once a job has settled", async () => {
    const lab = fakeLab({
      jobs: () => [
        job({ id: "a", state: "failed", progress: 0.6, error: "OOM" }),
        job({ id: "b", state: "done", progress: 1, detail: "step 60/60" }),
        job({ id: "c", state: "queued", progress: null, detail: null }),
      ],
    });
    expect(await labRun(lab)("job_status", {})).toBe(
      [
        "finetune a: failed — OOM",
        "finetune b: done — step 60/60",
        "finetune c: queued",
      ].join("\n"),
    );
  });

  // The detail line is written by the benchmark harness, and a tqdm frame
  // carries carriage returns. One of those in a multi-job answer breaks the
  // list it is part of.
  it("flattens a progress frame so it stays one line", async () => {
    const lab = fakeLab({
      job: () => job({ detail: "case 3/20:\r  30%|███  | 3/20\n" }),
    });
    expect(await labRun(lab)("job_status", { jobId: "job-1" })).toBe(
      "finetune job-1: running 50% — case 3/20: 30%|███ | 3/20",
    );
  });

  // Nothing resident means a benchmark would measure nothing, which the absence
  // of a "loaded" marker states only by implication.
  it("says when no model is loaded", async () => {
    const lab = fakeLab({
      models: async () => ({
        target: "local",
        inventoryError: null,
        models: [
          {
            id: "a",
            label: "a",
            format: "gguf",
            sizeBytes: 2e9,
            requiresVariant: false,
            loaded: false,
          },
        ],
      }),
    });
    expect(await labRun(lab)("list_models", {})).toContain(
      "Nothing is loaded, so a benchmark cannot run yet.",
    );
  });

  // The result goes back into the conversation, where it competes with the
  // thread for context. A cut list has to say it was cut.
  it("caps a long list and says what it dropped", async () => {
    const lab = fakeLab({
      datasets: async () =>
        Array.from({ length: 12 }, (_, i) => ({
          name: `d${i}.jsonl`,
          path: `/uploads/datasets/d${i}.jsonl`,
          size: 1e6,
        })),
    });
    const result = await labRun(lab)("list_datasets", {});
    expect(result.split("\n")).toHaveLength(9);
    expect(result).toContain("(showing 8 of 12)");
  });

  // What a run left behind is the only reason to ask about it: a checkpoint can
  // be exported, an export can be benchmarked, and neither is true of a run
  // that produced no output dir.
  it("says what each fine-tune left behind", async () => {
    const lab = fakeLab({
      runs: () => [
        trained({ ggufPath: "/studio/runs/1/gguf", hubRepo: "me/qwen-tools" }),
        trained({
          id: "22222222-x",
          ggufPath: "/studio/runs/2/model-Q4_K_M.gguf",
        }),
        trained({ id: "33333333-x", outputDir: null, provider: "colab" }),
        trained({ id: "44444444-x" }),
      ],
    });
    expect(await labRun(lab)("lab_history", { what: "runs" })).toBe(
      [
        // A path ending in the literal word "gguf" is the save directory, and
        // "exported to gguf" would say nothing.
        "- 1f0a2b3c: unsloth/Qwen3-1.7B on train.jsonl — exported, pushed to me/qwen-tools (local)",
        "- 22222222: unsloth/Qwen3-1.7B on train.jsonl — exported to model-Q4_K_M.gguf (local)",
        "- 33333333: unsloth/Qwen3-1.7B on train.jsonl — no checkpoint (colab)",
        "- 44444444: unsloth/Qwen3-1.7B on train.jsonl — trained, not exported (local)",
      ].join("\n"),
    );
    expect(await labRun()("lab_history", {})).toContain(
      "No fine-tuning runs have finished yet",
    );
  });

  // Studio answers with whatever is resident whatever the request named, so a
  // score reported under the requested id alone reads as measuring weights that
  // never ran. And a 20-sample subset is not a leaderboard number.
  it("reports scores against what actually answered, with the caveat", async () => {
    const lab = fakeLab({
      scores: () => [score({ servedModel: "qwen3-4b" }), score()],
    });
    const result = await labRun(lab)("lab_history", { what: "scores" });
    expect(result).toBe(
      [
        "- penumbra-tools-v1 on qwen3-4b (requested qwen3-1.7b) @ local, 20 samples, 2026-01-02: tool_selection acc 0.923",
        "- penumbra-tools-v1 on qwen3-1.7b @ local, 20 samples, 2026-01-02: tool_selection acc 0.923",
        "Scores are subset runs at the sample count shown, not full-suite results.",
      ].join("\n"),
    );
    expect(await labRun()("lab_history", { what: "scores" })).toContain(
      "No benchmark scores have been recorded yet",
    );
  });
});
