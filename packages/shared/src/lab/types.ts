import { z } from "zod";
import { targetId } from "../compute/types";

// Wire contracts for the Model Lab (docs/MODEL_LAB.md): fine-tuning,
// export, and benchmarking. Shared so the server and the UI cannot disagree
// about a job's shape, and so suite definitions have one home.

export const labJobKind = z.enum(["finetune", "export", "benchmark"]);
/**
 * "cancelled" is deliberately not "failed". A run stopped on purpose and a run
 * that broke need different reactions — one is noise to be ignored, the other
 * is a bug to chase — and collapsing them would leave the job list unable to
 * say which happened. Studio's own download jobs draw the same line.
 */
export const labJobState = z.enum([
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
]);

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
  /** The run this job acts on, for jobs that act on one (export). Lets the UI
   *  show progress against the row you pressed the button on instead of only
   *  in a global list. Null for a finetune, which *creates* its run. */
  runId: z.string().nullable().default(null),
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
  /** Which compute to train on. "auto" prefers the local Studio and falls back
   *  to a configured Colab endpoint when it is unreachable; "local"/"colab"
   *  force one. Omit for "auto". */
  provider: z.enum(["auto", "local", "colab"]).optional(),
});

/**
 * A user-supplied fallback trainer: a Colab notebook running Unsloth Studio,
 * exposed through a tunnel (ngrok/Cloudflare) and guarded by a bearer token.
 *
 * It is configured *through the server* rather than baked into client code so
 * the key obeys the same rule as the local Studio bearer — the browser sends it
 * once to set it and never reads it back (docs/MODEL_LAB.md → Deployment
 * topology). The URL is not secret and may be echoed; the key never is.
 */
export const colabProviderConfig = z.object({
  baseURL: z.string().url(),
  apiKey: z.string().min(1).optional(),
});

/**
 * The local Studio's address and bearer, settable at runtime.
 *
 * Studio mints a new key on reinstall and whenever the user rotates one, and
 * until now matching it meant editing apps/server/.env and restarting the
 * server. Both fields are optional so a caller can change one without knowing
 * the other; an empty `apiKey` means "no bearer", which a trusted-LAN Studio
 * legitimately runs without.
 */
export const studioCredentialsInput = z.object({
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
});

export const exportRequest = z.object({
  runId: z.string().min(1),
  quantization: z.string().min(1).default("Q4_K_M"),
  /**
   * Also push the artifact to the HuggingFace Hub. The one supported way to get
   * weights off an ephemeral trainer: a Colab VM's disk goes away with the
   * session, and Studio serves no artifact for download.
   */
  repoId: z.string().min(1).optional(),
  private: z.boolean().optional(),
  /** Write token for `repoId`. Used for this one call and never stored: it is
   *  the user's Hub credential, not the lab's. */
  hfToken: z.string().min(1).optional(),
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
  /** What the run *asked* for. Studio ignores the `model` field and serves
   *  whatever it has loaded, so this is a label, not evidence. */
  model: z.string(),
  /**
   * What actually answered, read from the target's `/v1/models` at run time.
   *
   * This is the model the scores describe. When it differs from `model` the run
   * measured something other than what was requested — which produces no error
   * anywhere, so it has to be recorded to be noticed. Null on rows written
   * before this was captured.
   */
  servedModel: z.string().nullable().default(null),
  /** Which compute target served it. Two targets can hold different weights
   *  under the same name, so a score without this cannot be compared to one
   *  from the other machine. Rows written before this read as "local". */
  target: targetId.default("local"),
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
  /** HuggingFace repo an export was pushed to, when one was. The artifact
   *  itself lands on the trainer's disk, so for an ephemeral trainer this is
   *  the only durable record of where the weights actually ended up. */
  hubRepo: z.string().nullable().default(null),
  /** Which trainer produced it. `outputDir` is a path on *that* machine, so
   *  exporting the run means going back to the same one — a Colab checkpoint is
   *  meaningless to the local Studio. Rows written before this was recorded
   *  read as "local", which is what they were. */
  provider: z.enum(["local", "colab"]).default("local"),
  createdAt: z.string().datetime(),
});

/**
 * A model the benchmark target can serve, as the picker needs it.
 *
 * Reported by the server from the target's own inventory rather than typed by
 * hand. Studio ignores the `model` field of a request and answers with whatever
 * is resident, so a mistyped id does not fail — it returns a complete score
 * attributed to some other model. The list is the fix for the typo; `loaded`
 * is the fix for the rest, because it says which of these is the one a run
 * would actually measure.
 */
export const availableModel = z.object({
  /** The string to send back as `model`, and to load with. */
  id: z.string(),
  label: z.string(),
  /** "gguf" | "safetensors" | "unknown" as the target reports it. */
  format: z.string(),
  sizeBytes: z.number(),
  /** GGUF repos hold several quants; one must be named to load. */
  requiresVariant: z.boolean(),
  /** Resident right now, and therefore what a benchmark would really score. */
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
