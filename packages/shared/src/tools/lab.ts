import { z } from "zod";
import { SUITES } from "../lab/suites";
import { benchmarkRequest, finetuneRequest } from "../lab/types";
import type { ToolContract } from "./contract";

// Arguments reuse the route request schemas. Learning rate, LoRA rank, and
// dataset format are deliberately not exposed: each extra slot is one more for
// a small model to fill wrong.

/** z.enum needs a non-empty tuple. */
const SUITE_IDS = SUITES.map((s) => s.id) as [string, ...string[]];

export const listModelsTool = {
  name: "list_models",
  description:
    "List the models the benchmark machine can serve, and say which one is " +
    "loaded. Use before benchmarking, or when asked what models are available.",
  permission: "read",
  args: z.object({}),
} satisfies ToolContract;

export const listDatasetsTool = {
  name: "list_datasets",
  description:
    "List the fine-tuning datasets already on the training host, with the " +
    "path to train each one from.",
  permission: "read",
  args: z.object({}),
} satisfies ToolContract;

export const startFinetuneTool = {
  name: "start_finetune",
  description:
    "Start fine-tuning a base model on a dataset. Returns a job id straight " +
    "away; the training itself takes minutes to hours.",
  permission: "act",
  args: z.object({
    baseModel: finetuneRequest.shape.baseModel.describe(
      "Base model: a HuggingFace id such as 'unsloth/Qwen3-1.7B', or a path on the training host",
    ),
    dataset: z
      .string()
      .min(1)
      .describe(
        "Dataset: a HuggingFace id such as 'tatsu-lab/alpaca', or a path from list_datasets",
      ),
    maxSteps: finetuneRequest.shape.maxSteps.describe("Training steps to run"),
    provider: finetuneRequest.shape.provider.describe(
      "Which trainer to use; omit to choose automatically",
    ),
  }),
} satisfies ToolContract;

export const runBenchmarkTool = {
  name: "run_benchmark",
  description:
    "Benchmark the model loaded on the benchmark machine. Returns a job id " +
    "straight away; the run itself takes minutes to hours.",
  permission: "act",
  args: z.object({
    suite: z.enum(SUITE_IDS).describe("Which benchmark suite to run"),
    samplesPerTask: benchmarkRequest.shape.samplesPerTask.describe(
      "Cases per task. A small number is quick, and is not comparable to a published score",
    ),
    // Studio serves whatever is resident, so this is a label; the server defaults
    // it to the model that will answer.
    model: z
      .string()
      .optional()
      .describe(
        "Name to record the scores against; omit to use the loaded model",
      ),
  }),
} satisfies ToolContract;

export const jobStatusTool = {
  name: "job_status",
  description:
    "Check on Model Lab work: one job by id, or the most recent jobs. Use " +
    "this to report progress on a fine-tune or benchmark already started.",
  permission: "read",
  args: z.object({
    jobId: z
      .string()
      .optional()
      .describe("Job id; omit for the most recent jobs"),
  }),
} satisfies ToolContract;

/**
 * `job_status` rows never carry scores, which live in their own table. One tool
 * with a `what` slot rather than two, to keep the tool count down.
 */
export const labHistoryTool = {
  name: "lab_history",
  description:
    "Look at finished Model Lab work: past fine-tuning runs and where their " +
    "artifacts ended up, or benchmark scores already recorded.",
  permission: "read",
  args: z.object({
    what: z
      // Terse: every description token competes for a 1.7B model's attention.
      .enum(["runs", "scores"])
      .describe(
        "runs = past fine-tunes and their artifacts; " +
          "scores = recorded benchmark results",
      )
      .default("runs"),
  }),
} satisfies ToolContract;

/**
 * Separate from AGENT_POLICY, which is pinned for the eval. Phrased as an
 * extension of AGENT_POLICY's tool scope, not a correction: a small model
 * resolves contradictions at random.
 */
export const LAB_POLICY =
  "This machine also runs a Model Lab that fine-tunes and benchmarks models. " +
  "Its tools count as tools the user asked for whenever they ask about " +
  "models, datasets, training, or benchmarks. Prefer list_models and " +
  "list_datasets over guessing a name. Starting a fine-tune or a benchmark " +
  "returns a job id rather than a result, because the work runs for minutes " +
  "to hours: report the id, and use job_status to say where a run got to. " +
  "Use lab_history for work that already finished — what has been fine-tuned, " +
  "and what a benchmark scored. Only report a score or a finished model that " +
  "job_status or lab_history has shown you.";
