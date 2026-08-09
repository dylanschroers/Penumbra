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
 *  otherwise emit thousands of tokens). Tier 0's default, and the floor the
 *  whole setting is calibrated against. */
export const AGENT_MAX_TOKENS_LOCAL = 512;

/** Tier 1's default. A larger model, the full tool registry, and questions
 *  whose honest answer runs to a paragraph per tool — 512 truncated those
 *  mid-word. */
export const AGENT_MAX_TOKENS_SERVER = 2048;

/** What the setting will accept. The floor is low enough to be a deliberate
 *  "keep it terse" and high enough to finish a sentence; the ceiling exists
 *  because this is a *runaway* guard first, and an unbounded one guards
 *  nothing. */
export const AGENT_MAX_TOKENS_MIN = 128;
export const AGENT_MAX_TOKENS_MAX = 8192;

/**
 * Hold a cap inside the range before it becomes a request.
 *
 * The server range-checks an edit and refuses one that is out of bounds, which
 * is right for something a person just typed. This is the other half: the value
 * also arrives from places no one is checking at the time it is used — a
 * client's localStorage mirror, written by an older build or edited by hand —
 * and Tier 0 hands it straight to `max_tokens`. A ceiling that only some paths
 * respect is not a runaway guard, so it is applied where the number is spent
 * rather than at each place it can come from.
 */
export function clampMaxTokens(value: number): number {
  if (!Number.isFinite(value)) return AGENT_MAX_TOKENS_LOCAL;
  return Math.min(
    AGENT_MAX_TOKENS_MAX,
    Math.max(AGENT_MAX_TOKENS_MIN, Math.round(value)),
  );
}
/** How many tool rounds one turn may take, unless a tier raises it. */
const DEFAULT_MAX_TOOL_STEPS = 4;
/** The status probe is a liveness check, so it fails fast. */
const DEFAULT_STATUS_TIMEOUT_MS = 1500;

/**
 * How long one completion may take before the turn is failed.
 *
 * Generous, because this is not a latency budget: a 12B model on an older card
 * genuinely takes tens of seconds, and cutting a working answer short is worse
 * than waiting. It exists because the alternative is unbounded — a backend that
 * accepts the connection and then never answers (its GPU busy training, its
 * weights being evicted) leaves `fetch` pending forever, and a UI whose only
 * signal is "still working" cannot tell that from a slow reply. Every hang of
 * that shape reached the user as a permanently frozen chat with nothing in it
 * to report.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

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
  /**
   * Reply-length cap, or a function returning it.
   *
   * A function because the value is user-editable and this engine may be built
   * once and used for the rest of the session (Tier 0 is), so a number captured
   * at construction would pin the cap to whatever it was at page load. Same
   * reason `ToolBindings.system` is read through a getter.
   */
  maxTokens?: number | (() => number);
  statusTimeoutMs?: number;
  /** Ceiling on one completion. Raise it for a slow backend; it is a deadlock
   *  guard, not a latency target. */
  requestTimeoutMs?: number;
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
  private readonly resolveMaxTokens: () => number;
  protected readonly statusTimeoutMs: number;
  protected readonly requestTimeoutMs: number;

  constructor(config: OpenAiEngineConfig) {
    this.bindings = config.bindings;
    this.baseURL = normalizeBaseUrl(config.baseURL);
    this.model = config.model;
    this.headers = config.headers ?? {};
    this.label = config.label ?? "model";
    this.maxToolSteps = config.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS;
    const cap = config.maxTokens ?? AGENT_MAX_TOKENS_LOCAL;
    this.resolveMaxTokens = typeof cap === "function" ? cap : () => cap;
    this.statusTimeoutMs = config.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
    this.requestTimeoutMs =
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** The cap in force for the next request. Resolved per call, so an edit
   *  reaches the next turn without rebuilding anything, and clamped here
   *  because a resolver reads a store this class does not control. */
  protected get maxTokens(): number {
    return clampMaxTokens(this.resolveMaxTokens());
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
      const { finish, ...msg } = await this.complete(convo, tools, signal);
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
        // "length" means the cap cut it off mid-thought. Passed on so the UI can
        // say so: the text itself just ends, which reads as a finished answer.
        yield finish === "length"
          ? { kind: "answer", text, truncated: true }
          : { kind: "answer", text };
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
  ): Promise<{
    content?: string | null;
    tool_calls?: ToolCall[];
    /** Why generation stopped — "length" when the cap truncated it. */
    finish?: string;
  }> {
    // The caller's abort and our own deadline, composed by hand rather than with
    // AbortSignal.any: this runs in the OS webview too, and WebKitGTK is exactly
    // the platform where that is missing. Which of the two fired has to be
    // remembered, because both surface as the same AbortError and they mean
    // opposite things — one is the user leaving, the other is the failure worth
    // reporting.
    const controller = new AbortController();
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      controller.abort();
    }, this.requestTimeoutMs);
    const relay = () => controller.abort();
    signal?.addEventListener("abort", relay, { once: true });
    // An abort that already happened fires no event. Without this a Stop
    // pressed between two steps of a tool loop was dropped, and the next
    // request ran to its full deadline against a caller that had already left.
    if (signal?.aborted) relay();

    // The deadline has to outlive the fetch itself. `fetch` settles on headers,
    // so releasing it there left the body read unguarded — and a backend that
    // answers 200 and then stalls mid-body is the same wedge this exists to
    // catch, only one step later. Reading the body is inside the guard for the
    // same reason: `controller` owns that stream too, so it is what a Stop
    // pressed while the reply is arriving actually cancels.
    try {
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
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${this.label} responded ${res.status}`);
      const body = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string | null; tool_calls?: ToolCall[] };
          finish_reason?: string;
        }>;
      };
      const choice = body.choices?.[0];
      return { ...choice?.message, finish: choice?.finish_reason };
    } catch (err) {
      if (expired) {
        throw new Error(
          `the ${this.label} backend did not respond within ${Math.round(
            this.requestTimeoutMs / 1000,
          )}s — it may be loading a model, busy training, or wedged`,
        );
      }
      throw err;
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", relay);
    }
  }
}
