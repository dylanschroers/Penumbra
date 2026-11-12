import { z } from "zod";

// Targets report `hasKey`, never the key: no client ever holds a Studio key.

export const targetId = z.enum(["local", "colab"]);

/** Training is chosen per run (`finetuneRequest.provider`), not assigned here. */
export const computeRole = z.enum(["chat", "benchmark"]);

/**
 * "unauthorized": up, wrong key. "not_studio": a 200 that isn't Studio's API
 * (sign-in page, proxy, UI-only port).
 */
export const targetState = z.enum([
  "ready",
  "unauthorized",
  "not_studio",
  "stopped",
]);

export const computeTarget = z.object({
  id: targetId,
  label: z.string(),
  baseURL: z.string(),
  hasKey: z.boolean(),
  source: z.enum(["env", "settings"]),
  configured: z.boolean(),
  state: targetState,
  /** Read from the same `/v1/models` call that decides `state`. */
  servedModel: z.string().nullable().default(null),
  /**
   * Local Studio only, with a launch command set, and only for loopback callers:
   * it spawns a process on the server host.
   */
  canLaunch: z.boolean().default(false),
  /** Same conditions as `canLaunch`, against the stop command. */
  canStop: z.boolean().default(false),
});

export const computeState = z.object({
  targets: z.array(computeTarget),
  assignments: z.record(computeRole, targetId),
  /** Differs from `assignments` when the assigned target isn't configured. */
  effective: z.record(computeRole, targetId),
});

/** The route rejects an empty patch. */
export const targetConfigInput = z.object({
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
});

export const assignInput = z.object({
  role: computeRole,
  target: targetId,
});

/** GGUF quantization label. Omitted: the server resolves the repo's default. */
export const loadModelInput = z.object({
  model: z.string().min(1),
  variant: z.string().optional(),
});

export type TargetId = z.infer<typeof targetId>;
export type ComputeRole = z.infer<typeof computeRole>;
export type TargetState = z.infer<typeof targetState>;
export type ComputeTarget = z.infer<typeof computeTarget>;
export type ComputeState = z.infer<typeof computeState>;
export type TargetConfigInput = z.infer<typeof targetConfigInput>;
export type AssignInput = z.infer<typeof assignInput>;
export type LoadModelInput = z.infer<typeof loadModelInput>;
