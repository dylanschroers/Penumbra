import { z } from "zod";

// The agent's wire contract — the single seam between the web sidebar and the
// server's agent loop, the same way validation/task.ts is the seam for tasks.
// The server validates an incoming request against `chatRequest`; the client
// infers its types from the very same schemas so the two can never drift.

export const chatRole = z.enum(["user", "assistant"]);

/** One turn in a conversation. Content is plain text for v0 (no tools yet). */
export const chatMessage = z.object({
  role: chatRole,
  content: z.string().min(1).max(100_000),
});

/** What the sidebar POSTs to /agent/chat to continue a conversation. */
export const chatRequest = z.object({
  messages: z.array(chatMessage).min(1).max(200),
});

export type ChatRole = z.infer<typeof chatRole>;
export type ChatMessage = z.infer<typeof chatMessage>;
export type ChatRequest = z.infer<typeof chatRequest>;

/**
 * State of the local Unsloth backend, surfaced by GET /agent/status so the
 * sidebar can render an honest pill instead of failing a chat blindly:
 *  - not_installed: the `unsloth` CLI isn't on the server's PATH
 *  - stopped:       installed, but no Studio answering on UNSLOTH_STUDIO_URL
 *  - no_model:      Studio is up but has no model loaded to infer with
 *  - ready:         a model is loaded and /agent/chat will work
 */
export type AgentState = "not_installed" | "stopped" | "no_model" | "ready";

export interface AgentStatus {
  state: AgentState;
  /** Loaded model id, present only when state is "ready". */
  model?: string;
  /** Whether this Studio install is inference-only (no training). */
  chatOnly?: boolean;
}
