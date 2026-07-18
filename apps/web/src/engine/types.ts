// Types for talking to a model backend. These lived in @ghost/shared while a
// server-side agent seam was planned; the client is their only consumer today,
// so they live here until a second consumer exists (see docs/AGENT_DESIGN.md →
// "The engine abstraction"). Tier 1 makes the server that second consumer and
// moves them back — docs/UNSLOTH_TIER1_PLAN.md → Phase 5.

import type { ToolSpec } from "@ghost/shared";

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
 * client store (engine/index.ts closes over agent/tools.ts). Tier 1's
 * RemoteEngine binds nothing at all — the server owns the tools, the prompt,
 * and execution — so a per-turn parameter would be handed over and ignored by
 * half the implementations (docs/UNSLOTH_TIER1_PLAN.md → Phase 1).
 */
export interface ToolBindings {
  tools: ToolSpec[];
  system: string;
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}

/**
 * A model backend that can report readiness and run a tool-using turn. Tier 0's
 * LocalEngine talks to an embedded llama-server; Tier 1's RemoteEngine will
 * forward to a Ghost server. The module picks one via createEngine().
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
