import type {
  AgentEvent,
  AgentStatus,
  ChatMessage,
  Engine,
  ToolBindings,
} from "./types";

// The OpenAI-compatible protocol both tiers speak. llama.cpp's `llama-server`
// (Tier 0) and Unsloth Studio (Tier 1) expose the same `/v1/chat/completions`
// and `/v1/models`, with identical `tools` / `tool_choice` semantics — the
// finding that collapsed Tier 1's engine work to configuration
// (docs/UNSLOTH_TIER1_PLAN.md → "Unsloth is on the seam"). So the loop lives
// here once and each tier supplies an address, a model, and headers.
//
// This module is deliberately environment-free: no import.meta.env, no
// process.env. It runs in a browser and in Node, and each side's factory reads
// its own configuration and passes it in.

/** Cap generation so a small model can't run away (Qwen3 thinking can
 *  otherwise emit thousands of tokens). */
const DEFAULT_MAX_TOKENS = 512;
/** How many tool rounds one turn may take, unless a tier raises it. */
const DEFAULT_MAX_TOOL_STEPS = 4;
/** The status probe is a liveness check, so it fails fast. */
const DEFAULT_STATUS_TIMEOUT_MS = 1500;

export interface OpenAiEngineConfig {
  /** Tools, prompt, and executor for every turn this engine runs. */
  bindings: ToolBindings;
  /** Origin of the OpenAI-compatible server, no trailing slash. */
  baseURL: string;
  /** Model id sent with each request. */
  model: string;
  /** Extra headers on every request — Tier 1 sends `Authorization: Bearer`. */
  headers?: Record<string, string>;
  /** Names this backend in error messages ("local model responded 500"). */
  label?: string;
  maxToolSteps?: number;
  maxTokens?: number;
  statusTimeoutMs?: number;
}

/** One OpenAI chat message as it goes over the wire, including the tool roles
 *  that ChatMessage (a UI type) has no need to model. */
interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export class OpenAiEngine implements Engine {
  protected readonly bindings: ToolBindings;
  protected readonly baseURL: string;
  protected readonly model: string;
  protected readonly headers: Record<string, string>;
  protected readonly label: string;
  protected readonly maxToolSteps: number;
  protected readonly maxTokens: number;
  protected readonly statusTimeoutMs: number;

  constructor(config: OpenAiEngineConfig) {
    this.bindings = config.bindings;
    this.baseURL = config.baseURL.replace(/\/+$/, "");
    this.model = config.model;
    this.headers = config.headers ?? {};
    this.label = config.label ?? "model";
    this.maxToolSteps = config.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.statusTimeoutMs = config.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
  }

  /** Backend readiness for the status pill. Never throws; reports a state. */
  async getStatus(): Promise<AgentStatus> {
    try {
      const res = await fetch(`${this.baseURL}/v1/models`, {
        headers: this.headers,
        signal: AbortSignal.timeout(this.statusTimeoutMs),
      });
      if (!res.ok) return { state: "stopped" };
      const body = (await res.json()) as {
        data?: Array<{ id?: string; loaded?: boolean }>;
      };
      const entries = body.data ?? [];

      // The two backends list different things. llama-server advertises only
      // what it has resident and omits `loaded` entirely, so the first entry is
      // servable. Unsloth Studio also lists models that are merely downloaded,
      // marking each `loaded: true|false` — taking entries[0] there would
      // report "ready" off a model sitting on disk, and the next completion
      // would fail against a backend with nothing loaded. (Verified against
      // studio/backend/routes/inference.py → _openai_catalog_objects.)
      const loaded = entries.find((m) => m.loaded === true);
      const marksLoaded = entries.some((m) => typeof m.loaded === "boolean");
      const model = loaded?.id ?? (marksLoaded ? undefined : entries[0]?.id);

      return model ? { state: "ready", model } : { state: "no_model" };
    } catch {
      return { state: "stopped" };
    }
  }

  // A tool-using turn: call the model with tools, run any tool calls it emits,
  // feed the results back, and repeat until it answers (bounded). Non-streaming
  // — tool turns are short, and streamed tool-call parsing isn't worth it yet.
  // Tools touch app state rather than the engine, so execution stays with the
  // bindings this engine was constructed with.
  async *runAgent(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const { tools, system, runTool } = this.bindings;
    const convo: WireMessage[] = [
      { role: "system", content: system },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    for (let step = 0; step < this.maxToolSteps; step++) {
      const msg = await this.complete(convo, tools, signal);
      const calls = msg.tool_calls ?? [];

      if (calls.length === 0) {
        // No tool: this is the answer. Strip any <think> block (thinking-off
        // still emits empty tags) so only the reply text shows.
        const text = (msg.content ?? "")
          .replace(/<think>[\s\S]*?<\/think>/g, "")
          .trim();
        yield { kind: "answer", text };
        return;
      }

      convo.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: calls,
      });
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // leave args empty; runTool reports the failure
        }
        const result = await runTool(call.function.name, args);
        yield { kind: "tool", name: call.function.name, args, result };
        convo.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    yield {
      kind: "answer",
      text: "I hit the tool-step limit before finishing.",
    };
  }

  /** One `/v1/chat/completions` round trip, returning the assistant message. */
  private async complete(
    convo: WireMessage[],
    tools: ToolBindings["tools"],
    signal?: AbortSignal,
  ): Promise<{ content?: string | null; tool_calls?: ToolCall[] }> {
    const res = await fetch(`${this.baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify({
        model: this.model,
        messages: convo,
        tools,
        tool_choice: "auto",
        max_tokens: this.maxTokens,
        temperature: 0,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`${this.label} responded ${res.status}`);
    const body = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: ToolCall[] };
      }>;
    };
    return body.choices?.[0]?.message ?? {};
  }
}
