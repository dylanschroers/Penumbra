import { z } from "zod";

// Wire contracts for compute targets: which Unsloth Studios the server knows
// about, and which one each part of the app uses.
//
// Shared rather than server-local because the panel that edits these is the
// same one the chat pill opens — the client has to agree with the server about
// role names and target ids or the two drift silently.
//
// Note what is *not* here: the bearer. A target reports `hasKey`, never the key
// (docs/MODEL_LAB.md → Deployment topology: no client-side code ever holds a
// Studio key).

export const targetId = z.enum(["local", "colab"]);

/** Roles a target can be assigned to. Training is absent on purpose: it is
 *  chosen per run in `finetuneRequest.provider`, not set once here. */
export const computeRole = z.enum(["chat", "benchmark"]);

/** Studio readiness, matching StudioReachability on the server. "unauthorized"
 *  (up, wrong key) stays distinct from "stopped" because the two send you to
 *  different places. */
export const targetState = z.enum(["ready", "unauthorized", "stopped"]);

export const computeTarget = z.object({
  id: targetId,
  label: z.string(),
  baseURL: z.string(),
  /** Whether a bearer is set — never which one. */
  hasKey: z.boolean(),
  /** "session" means the configuration dies with the server process, which is
   *  Colab's whole posture: its bearer never touches disk. */
  persistence: z.enum(["persisted", "session"]),
  source: z.enum(["env", "settings"]),
  /** False while no address has been given. */
  configured: z.boolean(),
  state: targetState,
});

export const computeState = z.object({
  targets: z.array(computeTarget),
  /** What the user asked for, per role. */
  assignments: z.record(computeRole, targetId),
  /** What each role actually resolves to. Differs from `assignments` when a
   *  target is assigned but not configured — surfaced rather than hidden so the
   *  UI can say the two have diverged instead of misreporting where answers
   *  come from. */
  effective: z.record(computeRole, targetId),
});

/** Body for setting a target's address and/or bearer. Both optional so a key
 *  can be rotated without restating the URL; the route rejects an empty patch. */
export const targetConfigInput = z.object({
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
});

export const assignInput = z.object({
  role: computeRole,
  target: targetId,
});

/**
 * Body for making a model resident on a target.
 *
 * `variant` is a GGUF quantization label. Optional because a repo names its own
 * default and resolving it server-side keeps the picker to one choice; sent
 * when the caller wants a specific one, which on a small card is the difference
 * between fitting in VRAM and not.
 */
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
