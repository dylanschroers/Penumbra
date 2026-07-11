// Types for talking to the embedded model. These lived in @ghost/shared while
// a server-side agent seam was planned; the client is their only consumer
// today, so they live here until a second consumer exists (see
// docs/AGENT_DESIGN.md → "The engine abstraction").

export type ChatRole = "user" | "assistant";

/** One turn in a conversation. Content is plain text. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Readiness of the embedded model, for the status pill:
 *  - stopped:  nothing answering on the local port
 *  - no_model: the server is up but reports no loaded model
 *  - ready:    /v1/chat/completions will work
 */
export type AgentState = "stopped" | "no_model" | "ready";

export interface AgentStatus {
  state: AgentState;
  /** Loaded model id, present only when state is "ready". */
  model?: string;
}
