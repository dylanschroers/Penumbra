import type {
  AgentEvent,
  AgentStatus,
  ChatMessage,
  Engine,
} from "@ghost/shared";
import { flushSync, requestSync } from "../sync/SyncClient";

// Tier 1: the model runs on a Ghost server, and so do its tools. This engine is
// pure transport — it holds no tool bindings, because the server owns the
// tools, the prompt, and execution (docs/UNSLOTH_TIER1_PLAN.md §2). That is the
// asymmetry the Engine interface was reshaped for: runAgent takes only
// messages, so there is nothing here to pass and ignore.

const DEFAULT_URL = import.meta.env.VITE_SERVER_URL ?? "http://127.0.0.1:3000";

export interface RemoteEngineConfig {
  baseURL?: string;
  /** Matches the server's GHOST_AGENT_TOKEN; unset works for a loopback server. */
  token?: string;
}

/** One `event: <name>\ndata: <json>` frame from the server. */
interface SseFrame {
  event: string;
  data: unknown;
}

/** Split an SSE byte stream into frames. Frames are separated by a blank line
 *  and may arrive split across chunks, so the tail is carried forward. */
async function* readFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (event && data) yield { event, data: JSON.parse(data) };
        split = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class RemoteEngine implements Engine {
  private readonly baseURL: string;
  private readonly headers: Record<string, string>;

  constructor(config: RemoteEngineConfig = {}) {
    this.baseURL = (config.baseURL ?? DEFAULT_URL).replace(/\/+$/, "");
    this.headers = config.token
      ? { Authorization: `Bearer ${config.token}` }
      : {};
  }

  async getStatus(): Promise<AgentStatus> {
    try {
      const res = await fetch(`${this.baseURL}/agent/status`, {
        headers: this.headers,
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return { state: "stopped" };
      return (await res.json()) as AgentStatus;
    } catch {
      return { state: "stopped" };
    }
  }

  async *runAgent(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    // Pre-turn flush: the turn reads the *server's* store, so unpushed local
    // edits would be invisible to the model. Never let a sync failure block the
    // turn — a stale read is better than no answer.
    await flushSync().catch(() => {});

    const res = await fetch(`${this.baseURL}/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify({ messages }),
      signal,
    });
    if (!res.ok) throw new Error(`agent server responded ${res.status}`);
    if (!res.body) throw new Error("agent server sent no stream");

    for await (const frame of readFrames(res.body)) {
      if (frame.event === "error") {
        const { message } = frame.data as { message?: string };
        throw new Error(message ?? "agent turn failed");
      }
      if (frame.event === "done") return;
      if (frame.event !== "agent") continue;

      const ev = frame.data as AgentEvent;
      yield ev;

      // Post-tool nudge: the write landed on the server, so the client sees it
      // only on its next pull — up to INTERVAL_MS away without this. Tier 0
      // gets the equivalent for free from its own local write.
      if (ev.kind === "tool") requestSync();
    }
  }
}
