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
 *  - stopped:      nothing answering at the configured address
 *  - unauthorized: answering, but rejecting the key it was given
 *  - no_model:     the backend is up but reports no loaded model
 *  - ready:        /v1/chat/completions will work
 *
 * `unauthorized` is not folded into `stopped` for the same reason
 * StudioReachability keeps them apart: "running with a stale key" and "not
 * running" send you to different places, and Studio mints a fresh key on every
 * rotation, so the first is routine rather than exotic.
 */
export type AgentState = "stopped" | "unauthorized" | "no_model" | "ready";

export interface AgentStatus {
  state: AgentState;
  /** Loaded model id, present only when state is "ready". */
  model?: string;
  /**
   * Which compute target answered, when the backend has more than one to choose
   * from. Absent for Tier 0, which is always the embedded server.
   *
   * Reported with the state rather than fetched separately so the pill can
   * never show one target's name beside another's readiness.
   */
  target?: { id: string; label: string };
}

/** What a tool-using turn emits: each tool run as it happens, then the answer. */
export type AgentEvent =
  | {
      kind: "tool";
      name: string;
      args: Record<string, unknown>;
      result: string;
    }
  | {
      kind: "answer";
      text: string;
      /**
       * The reply stopped because it hit the token cap, not because the model
       * had finished.
       *
       * Carried rather than dropped because a truncated answer is indetectable
       * from the outside: it ends mid-sentence and looks like the assistant
       * chose to stop. The backend says so in `finish_reason`, and that was the
       * one place it was known.
       */
      truncated?: boolean;
    };

/**
 * The tool surface a turn runs against: the specs the model is shown, the
 * system prompt, and how to execute a call.
 *
 * Bound when an engine is *constructed*, not passed per turn. Tier 0 binds the
 * client store; Tier 1's server binds its own. A per-turn parameter would be
 * supplied by a caller that, in the remote case, has no say in any of it
 * (docs/AGENT_DESIGN.md §5).
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
