import type {
  AgentEvent,
  AgentStatus,
  ChatMessage,
  Engine,
} from "@penumbra/shared";
import { normalizeBaseUrl, readSseFrames } from "@penumbra/shared";
import { flushSync, requestSync } from "../sync/SyncClient";

// Tier 1: the model runs on a Penumbra server, and so do its tools. This engine is
// pure transport — it holds no tool bindings, because the server owns the
// tools, the prompt, and execution (docs/UNSLOTH_TIER1_PLAN.md §2). That is the
// asymmetry the Engine interface was reshaped for: runAgent takes only
// messages, so there is nothing here to pass and ignore.

const DEFAULT_URL = import.meta.env.VITE_SERVER_URL ?? "http://127.0.0.1:3000";

export interface RemoteEngineConfig {
  baseURL?: string;
  /** Matches the server's PENUMBRA_AGENT_TOKEN; unset works for a loopback server. */
  token?: string;
}

export class RemoteEngine implements Engine {
  private readonly baseURL: string;
  private readonly headers: Record<string, string>;

  constructor(config: RemoteEngineConfig = {}) {
    this.baseURL = normalizeBaseUrl(config.baseURL ?? DEFAULT_URL);
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

    // Default "throw" on a bad frame: a malformed event means the turn is
    // broken, so surfacing it beats silently dropping part of the answer.
    for await (const frame of readSseFrames(res.body)) {
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
