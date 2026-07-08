import {
  createThinkSplitter,
  type AgentStatus,
  type ChatMessage,
  type InferenceEngine,
  type ReplyChunk,
} from "@ghost/shared";

// Tier 0: the embedded model. Talks *directly* to a local OpenAI-compatible
// server (llama.cpp's `llama-server`), with no Ghost server in the path — this
// is what makes guidance work fully offline. On desktop/mobile the app spawns
// and bundles that server (see docs/AGENT_DESIGN.md → "Local model delivery");
// here we only need its address. Reasoning models emit `<think>…</think>` inline
// in the content stream, so we run deltas through the shared think splitter,
// exactly as the server RemoteEngine path does.
const DEFAULT_URL = import.meta.env.VITE_LOCAL_LLM_URL ?? "http://127.0.0.1:8080";
const DEFAULT_MODEL = import.meta.env.VITE_LOCAL_LLM_MODEL ?? "local";

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
}

/** The default embedded engine: a local llama-server on VITE_LOCAL_LLM_URL. */
export const localEngine = new LocalEngine();
