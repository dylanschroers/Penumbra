import { z } from "zod";

// Wire contracts for the Model Lab (docs/model_lab_plan.md): fine-tuning,
// export, and benchmarking. Shared so the server and the UI cannot disagree
// about a job's shape, and so suite definitions have one home.

export const labJobKind = z.enum(["finetune", "export", "benchmark"]);
export const labJobState = z.enum(["queued", "running", "done", "failed"]);

/** One stage of the pipeline. The job record is the source of truth: an SSE
 *  relay can drop, the server can restart, and the job still says what
 *  happened. */
export const labJob = z.object({
  id: z.string(),
  kind: labJobKind,
  state: labJobState,
  /** 0..1 when the underlying tool reports it, else null. */
  progress: z.number().min(0).max(1).nullable(),
  /** Human-readable current step ("step 40/60, loss 0.82"). */
  detail: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const datasetSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hf"), id: z.string().min(1) }),
  /** A path Studio can read, as returned by its dataset upload. */
  z.object({ kind: z.literal("local"), path: z.string().min(1) }),
]);

/**
 * Deliberately a small subset of Studio's TrainingStartRequest. The server
 * fills the rest with the constraints the GPU host imposes (QLoRA, 4-bit) so a
 * client cannot ask for a configuration the hardware cannot run.
 */
export const finetuneRequest = z.object({
  baseModel: z.string().min(1),
  dataset: datasetSource,
  learningRate: z.number().positive().max(1).default(2e-4),
  maxSteps: z.number().int().positive().max(100_000).default(60),
  loraR: z.number().int().positive().max(256).default(16),
  /** Dataset shape. "auto" lets Studio detect it, which is right for most
   *  public datasets; name it explicitly when detection guesses wrong. */
  format: z
    .enum(["auto", "alpaca", "chatml", "mistral", "raw", "custom", "generic"])
    .default("auto"),
});

export const exportRequest = z.object({
  runId: z.string().min(1),
  quantization: z.string().min(1).default("Q4_K_M"),
});

export const benchmarkRequest = z.object({
  /** Model id as the inference server knows it. */
  model: z.string().min(1),
  suite: z.string().min(1),
  /** Subset size per task. Scores are always labeled with this — a 20-sample
   *  score is not a leaderboard number and must never be shown as one. */
  samplesPerTask: z.number().int().positive().max(10_000).default(20),
});

export const suiteKind = z.enum(["general", "personal"]);

/** One number from one task. Both families reduce to this, which is what lets
 *  a single table hold both and a single view compare them. */
export const taskScore = z.object({
  task: z.string(),
  metric: z.string(),
  value: z.number(),
});

export const benchmarkResult = z.object({
  suite: z.string(),
  suiteKind,
  model: z.string(),
  samplesPerTask: z.number().int(),
  at: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  scores: z.array(taskScore),
});

/** A completed fine-tune, and where its artifacts live. */
export const labRun = z.object({
  id: z.string(),
  jobId: z.string(),
  baseModel: z.string(),
  dataset: z.string(),
  outputDir: z.string().nullable(),
  ggufPath: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export type LabJobKind = z.infer<typeof labJobKind>;
export type LabJobState = z.infer<typeof labJobState>;
export type LabJob = z.infer<typeof labJob>;
export type DatasetSource = z.infer<typeof datasetSource>;
export type FinetuneRequest = z.infer<typeof finetuneRequest>;
export type ExportRequest = z.infer<typeof exportRequest>;
export type BenchmarkRequest = z.infer<typeof benchmarkRequest>;
export type SuiteKind = z.infer<typeof suiteKind>;
export type TaskScore = z.infer<typeof taskScore>;
export type BenchmarkResult = z.infer<typeof benchmarkResult>;
export type LabRun = z.infer<typeof labRun>;
