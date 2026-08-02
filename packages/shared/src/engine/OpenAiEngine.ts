import { normalizeBaseUrl } from "../net";
import { type ModelCatalogEntry, pickLoadedModel } from "./catalog";
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
// (docs/AGENT_DESIGN.md → "Unsloth is on the seam"). So the loop lives
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

/**
 * Emoji, with the modifiers that ride along: skin tones, variation selectors,
 * and the zero-width joiners that fuse multi-part sequences.
 *
 * Stripped from the answer rather than merely forbidden in the prompt, because
 * a 1.7B model does not reliably obey a negative style rule — asked for an
 * enthusiastic greeting it appends 😊 whatever the system prompt says. The
 * prompt still carries the instruction, so a model capable of following it
 * never emits one and this never fires.
 *
 * The cost is that the assistant cannot produce an emoji even when asked for
 * one. That is the intended trade here; deleting this and its use in runAgent
 * restores the model's own output verbatim.
 */
const EMOJI =
  /(?:\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}])+/gu;

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
    this.baseURL = normalizeBaseUrl(config.baseURL);
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
      // A backend that answers but rejects the key is a different fix from one
      // that isn't running — see AgentState. Studio rotates its key on every
      // reinstall, so this is the ordinary case, not an edge one.
      if (res.status === 401 || res.status === 403) {
        return { state: "unauthorized" };
      }
      if (!res.ok) return { state: "stopped" };
      const body = (await res.json()) as { data?: ModelCatalogEntry[] };
      // Which entry is actually servable is a rule with a trap in it; it lives
      // in ./catalog so the benchmark route reads the listing the same way.
      const model = pickLoadedModel(body.data ?? []);

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
      { role: "system", content: await this.systemWithIdentity(system) },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    for (let step = 0; step < this.maxToolSteps; step++) {
      const msg = await this.complete(convo, tools, signal);
      const calls = msg.tool_calls ?? [];

      if (calls.length === 0) {
        // No tool: this is the answer. Strip any <think> block (thinking-off
        // still emits empty tags) so only the reply text shows, then the emoji
        // the prompt asked it not to write. Removing one mid-sentence leaves a
        // double space behind, so runs of spaces collapse after.
        const text = (msg.content ?? "")
          .replace(/<think>[\s\S]*?<\/think>/g, "")
          .replace(EMOJI, "")
          .replace(/[ \t]{2,}/g, " ")
          .replace(/[ \t]+$/gm, "")
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

  /**
   * The bindings' prompt, plus what this turn is actually running on.
   *
   * A model has no way to know which weights are serving it: `this.model` is
   * whatever the caller configured, and for Studio that is the placeholder
   * "unsloth" — Studio ignores the field and serves whatever is resident. Asked
   * what it is, a small model therefore improvises, and the answer looks as
   * confident as a real one. So the served id is read from the backend and
   * stated, which is also the only honest source for it.
   *
   * Costs one `/v1/models` GET per turn, not per token, against a backend the
   * status pill is already polling. When it cannot be resolved the line is left
   * out entirely rather than guessed at, and the prompt's standing instruction
   * to admit ignorance takes over.
   */
  private async systemWithIdentity(system: string): Promise<string> {
    const status = await this.getStatus();
    const model = status.state === "ready" ? status.model : undefined;
    if (!model) return system;
    return `${system}\n\nYou are currently running as the model "${model}", served by the ${this.label} backend. If the user asks which model, backend, or version they are talking to, answer with exactly that and nothing invented.`;
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
