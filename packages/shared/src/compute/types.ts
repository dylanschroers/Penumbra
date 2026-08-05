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

/**
 * Studio readiness, matching StudioReachability on the server.
 *
 * Four states rather than a boolean because each sends you somewhere different:
 * "unauthorized" (up, wrong key) is a key to paste, "not_studio" (a 200 that is
 * not Studio's API — a sign-in page, a proxy, a UI-only port) is an address to
 * change, and "stopped" is a machine to start.
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
  /** Whether a bearer is set — never which one. */
  hasKey: z.boolean(),
  /** Which of the environment and the stored settings is in force. Only local
   *  reads an environment, so Colab is always "settings" once configured. */
  source: z.enum(["env", "settings"]),
  /** False while no address has been given. */
  configured: z.boolean(),
  state: targetState,
  /**
   * What this target is serving right now, or null for nothing.
   *
   * Reported with the state because it is read from the same `/v1/models` call
   * that decides the state, so it costs no extra request and cannot disagree
   * with it. It is also the only value here that changes without anyone
   * touching the app: a model loaded from Studio's own UI on another machine
   * appears on the next poll.
   */
  servedModel: z.string().nullable().default(null),
  /**
   * Whether this target can be *started* from here.
   *
   * True only for the local Studio, only when the server has a launch command
   * configured, and only for a caller on the server's own machine — starting it
   * spawns a process on that host, which cannot be done for a remote target or
   * on behalf of a client on another box. Off-loopback it is always false, so
   * the button never appears where it could not work.
   */
  canLaunch: z.boolean().default(false),
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
