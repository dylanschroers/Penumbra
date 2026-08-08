import { z } from "zod";
import { SUITES } from "../lab/suites";
import { benchmarkRequest, finetuneRequest } from "../lab/types";
import type { ToolContract } from "./contract";

// Contracts for driving the Model Lab from a conversation (docs/MODEL_LAB.md).
// Assembled into `labTools` by ./registry.ts, which is also where the reason
// they are a separate list from `agentTools` is written down.
//
// Argument schemas reuse the fields of the request schemas the HTTP routes
// already validate against, so the limits and defaults the model is shown are
// the ones a run actually gets. What is deliberately *not* exposed is the rest of
// `finetuneRequest` — learning rate, LoRA rank, dataset format. Those have
// defaults that are right almost always, and every extra slot is one more for a
// model to fill wrong (docs/AGENT_DESIGN.md §7: keep the tools few and shallow).

/** Suite ids as an enum, so the grammar can only emit one that exists. z.enum
 *  needs a non-empty tuple; SUITES is a non-empty constant. */
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
    // Studio answers with whatever is resident whatever this says, so it is a
    // label on the scores rather than a choice of model — hence optional, and
    // defaulted server-side to the model that will actually answer.
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
 * What the lab has already finished, as opposed to what it is doing now.
 *
 * `job_status` reads job rows, and a job row is a progress line: on a finished
 * benchmark it says "done" over whatever the harness last printed, never the
 * scores, which are written to their own table. Without this the policy below
 * asks the model to gate on evidence no tool could hand it.
 *
 * Two views on one tool rather than two tools, because §7 of
 * docs/AGENT_DESIGN.md is a rule about tool *count*: a small model does better
 * choosing a slot on a tool it has already picked than choosing between two
 * whose descriptions both begin "list past". The pair also overlaps in the way
 * that costs most — a run and the score of that run are one question to a user
 * and two tables here.
 */
export const labHistoryTool = {
  name: "lab_history",
  description:
    "Look at finished Model Lab work: past fine-tuning runs and where their " +
    "artifacts ended up, or benchmark scores already recorded.",
  permission: "read",
  args: z.object({
    what: z
      // Terse on purpose. Every token of tool description competes with the
      // ones already there on a 1.7B model, and these two words are the whole
      // distinction.
      .enum(["runs", "scores"])
      .describe(
        "runs = past fine-tunes and their artifacts; " +
          "scores = recorded benchmark results",
      )
      // The slot is filled reliably when the question is specific, so the
      // default only has to cover the vague "what has this lab done" — which is
      // a question about runs.
      .default("runs"),
  }),
} satisfies ToolContract;

/**
 * The tool policy for the tier that has a Model Lab, appended to AGENT_POLICY
 * by `composeSystem`.
 *
 * Separate from AGENT_POLICY rather than folded into it because that constant
 * is pinned: the eval harness and the personal benchmark suite both run the
 * shipped Tier-0 prompt, and editing it would make every historical score
 * incomparable with nothing in the row saying why (docs/MODEL_LAB.md → Suites).
 *
 * It reads as an extension of the sentence that scopes the tools rather than a
 * correction of it. A policy that said "only tasks and weather" and then
 * offered six lab tools would be a contradiction, and a small model resolves
 * those by picking one at random.
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
