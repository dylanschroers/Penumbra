import type {
  AgentStatus,
  ChatMessage,
  InferenceEngine,
  ReplyChunk,
} from "@ghost/shared";

// InferenceEngine backed by the Ghost server over HTTP + SSE. The model itself
// lives behind the server (today the local Unsloth backend); this is a thin
// transport that turns the server's `event:`-framed stream back into the shared
// ReplyChunk stream every engine speaks. Swapping in an embedded LocalEngine
// later means implementing the same interface, not touching the UI.
export class RemoteEngine implements InferenceEngine {
  constructor(
    private readonly baseURL: string = import.meta.env.VITE_SERVER_URL ??
      "http://localhost:3000",
  ) {}

  async getStatus(): Promise<AgentStatus> {
    try {
      const res = await fetch(`${this.baseURL}/agent/status`);
      if (res.ok) return (await res.json()) as AgentStatus;
    } catch {
      // fall through to the offline state below
    }
    return { state: "stopped" };
  }

  async *streamReply(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<ReplyChunk> {
    const res = await fetch(`${this.baseURL}/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`server responded ${res.status}`);

    // Parse the SSE stream by hand — small, dependency-free, and enough for our
    // event types (delta, reasoning, error, done). Frames are "\n\n"-separated.
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
        const event = frame.match(/^event: (.*)$/m)?.[1];
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (!data) continue;
        const payload = JSON.parse(data);
        if (event === "delta") yield { kind: "answer", text: payload.text };
        else if (event === "reasoning") yield { kind: "reasoning", text: payload.text };
        else if (event === "error") throw new Error(payload.message);
        // `done` (and anything else) just ends the stream.
      }
    }
  }
}

/** The default engine: the server on VITE_SERVER_URL. */
export const remoteEngine = new RemoteEngine();
