import { z } from "zod";
import { targetId } from "../compute/types";

export const labJobKind = z.enum(["finetune", "export", "benchmark"]);
/**
 * Cancelled is not failed: a deliberate stop and a breakage need different
 * reactions.
 */
export const labJobState = z.enum([
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
]);

/** The job row, not the SSE relay, is the source of truth. */
export const labJob = z.object({
  id: z.string(),
  kind: labJobKind,
  state: labJobState,
  progress: z.number().min(0).max(1).nullable(),
  detail: z.string().nullable(),
  error: z.string().nullable(),
  /** The run an export acts on. Null for a finetune, which creates its run. */
  runId: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const datasetSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hf"), id: z.string().min(1) }),
  z.object({ kind: z.literal("local"), path: z.string().min(1) }),
]);

/**
 * A subset of Studio's TrainingStartRequest; the server fills in the GPU
 * host's constraints (QLoRA, 4-bit).
 */
export const finetuneRequest = z.object({
  baseModel: z.string().min(1),
  dataset: datasetSource,
  learningRate: z.number().positive().max(1).default(2e-4),
  maxSteps: z.number().int().positive().max(100_000).default(60),
  loraR: z.number().int().positive().max(256).default(16),
  format: z
    .enum(["auto", "alpaca", "chatml", "mistral", "raw", "custom", "generic"])
    .default("auto"),
  /** "auto" prefers local and falls back to a reachable Colab. */
  provider: z.enum(["auto", "local", "colab"]).optional(),
});

/** Configured through the server so the key is never read back by a client. */
export const colabProviderConfig = z.object({
  baseURL: z.string().url(),
  apiKey: z.string().min(1).optional(),
});

/** An empty `apiKey` means no bearer. */
export const studioCredentialsInput = z.object({
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
});

export const exportRequest = z.object({
  runId: z.string().min(1),
  quantization: z.string().min(1).default("Q4_K_M"),
  /** The only way to get weights off an ephemeral trainer like Colab. */
  repoId: z.string().min(1).optional(),
  private: z.boolean().optional(),
  /** Used for this call only, never stored. */
  hfToken: z.string().min(1).optional(),
});

export const benchmarkRequest = z.object({
  model: z.string().min(1),
  suite: z.string().min(1),
  /** A subset score is not a leaderboard number and must never be shown as one. */
  samplesPerTask: z.number().int().positive().max(10_000).default(20),
});

export const suiteKind = z.enum(["general", "personal"]);

export const taskScore = z.object({
  task: z.string(),
  metric: z.string(),
  value: z.number(),
});

export const benchmarkResult = z.object({
  suite: z.string(),
  suiteKind,
  /** What the run asked for. Studio serves whatever is loaded, so this is a label. */
  model: z.string(),
  /** What actually answered, read from `/v1/models` at run time. Null on old rows. */
  servedModel: z.string().nullable().default(null),
  /** Two targets can hold different weights under the same name. */
  target: targetId.default("local"),
  samplesPerTask: z.number().int(),
  at: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  scores: z.array(taskScore),
});

export const labRun = z.object({
  id: z.string(),
  jobId: z.string(),
  baseModel: z.string(),
  dataset: z.string(),
  outputDir: z.string().nullable(),
  ggufPath: z.string().nullable(),
  /** For an ephemeral trainer, the only durable record of where the weights went. */
  hubRepo: z.string().nullable().default(null),
  /** `outputDir` is a path on that trainer, so export must go back to it. */
  provider: z.enum(["local", "colab"]).default("local"),
  createdAt: z.string().datetime(),
});

/**
 * Studio ignores the request's `model` and serves whatever is resident, so a
 * typo'd id silently scores another model. `loaded` says which one a run would
 * measure.
 */
export const availableModel = z.object({
  id: z.string(),
  label: z.string(),
  format: z.string(),
  sizeBytes: z.number(),
  requiresVariant: z.boolean(),
  loaded: z.boolean(),
});

export type AvailableModel = z.infer<typeof availableModel>;
export type LabJobKind = z.infer<typeof labJobKind>;
export type LabJobState = z.infer<typeof labJobState>;
export type LabJob = z.infer<typeof labJob>;
export type DatasetSource = z.infer<typeof datasetSource>;
export type FinetuneRequest = z.infer<typeof finetuneRequest>;
export type ColabProviderConfig = z.infer<typeof colabProviderConfig>;
export type StudioCredentialsInput = z.infer<typeof studioCredentialsInput>;
export type ExportRequest = z.infer<typeof exportRequest>;
export type BenchmarkRequest = z.infer<typeof benchmarkRequest>;
export type SuiteKind = z.infer<typeof suiteKind>;
export type TaskScore = z.infer<typeof taskScore>;
export type BenchmarkResult = z.infer<typeof benchmarkResult>;
export type LabRun = z.infer<typeof labRun>;
