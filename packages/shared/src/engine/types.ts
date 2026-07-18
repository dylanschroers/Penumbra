// The seam between the app and whatever model backend answers it.
//
// These types lived in apps/web/src/engine while the client was their only
// consumer. Tier 1 makes the server the second consumer — it implements the
// same Engine against Unsloth Studio — so they move here, which is where the
// original note in that file said they belonged once this happened
// (docs/AGENT_DESIGN.md → "The engine abstraction").

import type { ToolSpec } from "../tools";

export type ChatRole = "user" | "assistant";

/** One turn in a conversation. Content is plain text. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Readiness of the model backend, for the status pill:
 *  - stopped:  nothing answering at the configured address
 *  - no_model: the backend is up but reports no loaded model
 *  - ready:    /v1/chat/completions will work
 */
export type AgentState = "stopped" | "no_model" | "ready";

export interface AgentStatus {
  state: AgentState;
  /** Loaded model id, present only when state is "ready". */
  model?: string;
}

/** What a tool-using turn emits: each tool run as it happens, then the answer. */
export type AgentEvent =
  | {
      kind: "tool";
      name: string;
      args: Record<string, unknown>;
      result: string;
    }
  | { kind: "answer"; text: string };

/**
 * The tool surface a turn runs against: the specs the model is shown, the
 * system prompt, and how to execute a call.
 *
 * Bound when an engine is *constructed*, not passed per turn. Tier 0 binds the
 * client store; Tier 1's server binds its own. A per-turn parameter would be
 * supplied by a caller that, in the remote case, has no say in any of it
 * (docs/UNSLOTH_TIER1_PLAN.md → Phase 1).
 */
export interface ToolBindings {
  tools: ToolSpec[];
  system: string;
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}

/**
 * A model backend that can report readiness and run a tool-using turn. Tier 0's
 * LocalEngine talks to an embedded llama-server; Tier 1's UnslothEngine talks
 * to Unsloth Studio. Both are OpenAiEngine underneath — see ./OpenAiEngine.
 */
export interface Engine {
  /** Backend readiness for the status pill. Never throws; reports a state. */
  getStatus(): Promise<AgentStatus>;
  /** One turn: tool runs stream as they happen, then the answer. */
  runAgent(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent>;
}
