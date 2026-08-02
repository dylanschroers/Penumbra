import type {
  AgentEvent,
  AgentStatus,
  ChatMessage,
  Engine,
} from "@penumbra/shared";
import { normalizeBaseUrl, readSseFrames } from "@penumbra/shared";
import { authHeaders, getServerUrl } from "../serverAddress";
import { flushSync, requestSync } from "../sync/SyncClient";

// Tier 1: the model runs on a Penumbra server, and so do its tools. This engine is
// pure transport — it holds no tool bindings, because the server owns the
// tools, the prompt, and execution (docs/SYNC.md → Server-side writes). That
// is the asymmetry the Engine interface was reshaped for: runAgent takes only
// messages, so there is nothing here to pass and ignore.

export interface RemoteEngineConfig {
  /** Overrides the app's server address. Tests pass one; the app does not, so
   *  that chat follows the address the status pill edits. */
  baseURL?: string;
  /** Matches the server's PENUMBRA_AGENT_TOKEN; unset works for a loopback
   *  server. Overrides the stored bearer, on the same terms as `baseURL`. */
  token?: string;
}

export class RemoteEngine implements Engine {
  private readonly baseURLOverride?: string;
  private readonly tokenOverride?: string;

  constructor(config: RemoteEngineConfig = {}) {
    this.baseURLOverride = config.baseURL
      ? normalizeBaseUrl(config.baseURL)
      : undefined;
    this.tokenOverride = config.token;
  }

  // Both read per request rather than captured in the constructor. This engine
  // is built once at module load (../engine/index.ts), before the user has
  // touched anything, so a field assigned there would pin chat to whatever the
  // app started with — the exact trap ../serverAddress warns about, and the
  // reason this file used to hold a build-time URL of its own.
  private get baseURL(): string {
    return this.baseURLOverride ?? getServerUrl();
  }

  private get headers(): Record<string, string> {
    return this.tokenOverride
      ? { Authorization: `Bearer ${this.tokenOverride}` }
      : authHeaders();
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
