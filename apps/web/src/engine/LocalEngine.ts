import {
  createThinkSplitter,
  type AgentStatus,
  type ChatMessage,
  type InferenceEngine,
  type ReplyChunk,
} from "@ghost/shared";
import type { ToolSpec } from "../agent/tools";

/** What a tool-using turn emits: each tool run as it happens, then the answer. */
export type AgentEvent =
  | { kind: "tool"; name: string; args: Record<string, unknown>; result: string }
  | { kind: "answer"; text: string };

/** Options for a tool-using turn: the tools, the system prompt, and how to run
 *  a call (the caller owns execution, since tools touch app state). */
export interface AgentOptions {
  tools: ToolSpec[];
  system: string;
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}

const MAX_TOOL_STEPS = 4;

// Tier 0: the embedded model. Talks *directly* to a local OpenAI-compatible
// server (llama.cpp's `llama-server`), with no Ghost server in the path — this
// is what makes guidance work fully offline. On desktop/mobile the app spawns
// and bundles that server (see docs/AGENT_DESIGN.md → "Local model delivery");
// here we only need its address. Reasoning models emit `<think>…</think>` inline
// in the content stream, so we run deltas through the shared think splitter,
// exactly as the server RemoteEngine path does.
const DEFAULT_URL = import.meta.env.VITE_LOCAL_LLM_URL ?? "http://127.0.0.1:8080";
const DEFAULT_MODEL = import.meta.env.VITE_LOCAL_LLM_MODEL ?? "local";
// Cap generation so a small model can't run away (Qwen3 thinking can otherwise
// emit thousands of tokens). Mirrors the server loop's MAX_TOKENS.
const MAX_TOKENS = 512;

export class LocalEngine implements InferenceEngine {
  constructor(
    private readonly baseURL: string = DEFAULT_URL,
    private readonly model: string = DEFAULT_MODEL,
  ) {}

  async getStatus(): Promise<AgentStatus> {
    try {
      const res = await fetch(`${this.baseURL}/v1/models`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return { state: "stopped" };
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const model = body.data?.[0]?.id;
      return model ? { state: "ready", model } : { state: "no_model" };
    } catch {
      return { state: "stopped" };
    }
  }

  async *streamReply(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<ReplyChunk> {
    const res = await fetch(`${this.baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        max_tokens: MAX_TOKENS,
      }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`local model responded ${res.status}`);

    // OpenAI-style SSE: `data: {json}` frames separated by "\n\n", terminated by
    // a literal `data: [DONE]`. Answer text arrives in choices[0].delta.content.
    const splitter = createThinkSplitter();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (!data) continue;
        if (data === "[DONE]") {
          for (const chunk of splitter.flush()) yield chunk;
          return;
        }
        const payload = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const text = payload.choices?.[0]?.delta?.content;
        if (text) for (const chunk of splitter.push(text)) yield chunk;
      }
    }
    for (const chunk of splitter.flush()) yield chunk;
  }

  // A tool-using turn: call the model with tools, run any tool calls it emits,
  // feed the results back, and repeat until it answers (bounded). Non-streaming
  // — tool turns are short, and streamed tool-call parsing isn't worth it yet.
  // The caller supplies runTool because tools touch app state, not the engine.
  async *runAgent(
    messages: ChatMessage[],
    opts: AgentOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    type OaiMsg = {
      role: string;
      content: string | null;
      tool_calls?: unknown[];
      tool_call_id?: string;
    };
    const convo: OaiMsg[] = [
      { role: "system", content: opts.system },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      const res = await fetch(`${this.baseURL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: convo,
          tools: opts.tools,
          tool_choice: "auto",
          max_tokens: MAX_TOKENS,
          temperature: 0,
        }),
        signal,
      });
      if (!res.ok) throw new Error(`local model responded ${res.status}`);
      const body = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              function: { name: string; arguments: string };
            }>;
          };
        }>;
      };
      const msg = body.choices?.[0]?.message ?? {};
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

      convo.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // leave args empty; runTool reports the failure
        }
        const result = await opts.runTool(call.function.name, args);
        yield { kind: "tool", name: call.function.name, args, result };
        convo.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    yield { kind: "answer", text: "I hit the tool-step limit before finishing." };
  }
}

/** The default embedded engine: a local llama-server on VITE_LOCAL_LLM_URL. */
export const localEngine = new LocalEngine();
