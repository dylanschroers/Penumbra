// Picks the engine the agent module talks to — see docs/AGENT_DESIGN.md →
// "Deployment tiers". Nothing above this file knows which backend answered.
//
// This file is the composition root: LocalEngine stays free of app imports (its
// tools are injected, which is what keeps it testable), and the wiring to the
// client store happens here instead.

import type {
  AgentEvent,
  AgentStatus,
  ChatMessage,
  Engine,
  ToolBindings,
} from "@penumbra/shared";
import { AGENT_SYSTEM, runTool, toolSpecs } from "../agent/tools";
import { LocalEngine } from "./LocalEngine";
import { RemoteEngine } from "./RemoteEngine";

// The engine types are shared with the server (docs/UNSLOTH_TIER1_PLAN.md →
// Phase 2); re-exported here so app code keeps importing them from one place.
export type {
  AgentEvent,
  AgentState,
  AgentStatus,
  ChatMessage,
  ChatRole,
  Engine,
  ToolBindings,
} from "@penumbra/shared";
export { LocalEngine, type LocalEngineConfig } from "./LocalEngine";
export { RemoteEngine, type RemoteEngineConfig } from "./RemoteEngine";

/** Tier 0 runs tools in the browser, against the client's own store. Tier 1
 *  binds nothing here — the server owns its own tools. */
const clientBindings: ToolBindings = {
  tools: toolSpecs,
  system: AGENT_SYSTEM,
  runTool,
};

/** The backends the chat can route to (docs/AGENT_DESIGN.md → deployment tiers).
 *  `cloud` is a placeholder until a hosted provider is wired up. */
export type ProviderKind = "local" | "server" | "cloud";

export interface ProviderInfo {
  id: ProviderKind;
  label: string;
  hint: string;
  /** False = not wired up yet; the selector shows it disabled. */
  available: boolean;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "local",
    label: "Local",
    hint: "Embedded llama-server — offline, always available",
    available: true,
  },
  {
    id: "server",
    label: "Server",
    hint: "Unsloth model on your Penumbra server",
    available: true,
  },
  {
    id: "cloud",
    label: "Cloud",
    hint: "Hosted frontier model — coming soon",
    available: false,
  },
];

const PROVIDER_KEY = "penumbra.provider";

/** Delegates every call to whichever provider is currently selected. Switching is
 *  instant — it just flips a pointer; no connection opens until getStatus/runAgent. */
class SwitchableEngine implements Engine {
  private current: ProviderKind;

  constructor(
    private readonly engines: Partial<Record<ProviderKind, Engine>>,
    initial: ProviderKind,
  ) {
    // Fall back to local if the persisted choice isn't wired up (e.g. "cloud").
    this.current = engines[initial] ? initial : "local";
  }

  get provider(): ProviderKind {
    return this.current;
  }

  /** Switch providers (persisted). Unavailable ones (no engine) are ignored. */
  setProvider(kind: ProviderKind): void {
    if (!this.engines[kind]) return;
    this.current = kind;
    try {
      localStorage.setItem(PROVIDER_KEY, kind);
    } catch {
      // Non-fatal: the choice just won't persist across reloads.
    }
  }

  private active(): Engine {
    const active = this.engines[this.current];
    if (!active)
      throw new Error(`Provider "${this.current}" is not available.`);
    return active;
  }

  getStatus(): Promise<AgentStatus> {
    return this.active().getStatus();
  }

  async *runAgent(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    yield* this.active().runAgent(messages, signal);
  }
}

function loadProvider(): ProviderKind {
  try {
    const saved = localStorage.getItem(PROVIDER_KEY);
    if (saved === "local" || saved === "server" || saved === "cloud") {
      return saved;
    }
  } catch {
    // ignore — fall through to the default
  }
  return "local";
}

function createEngine(): SwitchableEngine {
  const local = new LocalEngine({ bindings: clientBindings });
  const server = new RemoteEngine({ token: import.meta.env.VITE_AGENT_TOKEN });
  return new SwitchableEngine({ local, server }, loadProvider());
}

const switchable = createEngine();

/** The engine the agent module uses. Construction is cheap — no connection is
 *  opened until getStatus() or runAgent() is called. */
export const engine: Engine = switchable;

/** The provider the chat is currently routed to. */
export function getProvider(): ProviderKind {
  return switchable.provider;
}

/** Route the chat to a different provider (persisted; unavailable ones no-op). */
export function setProvider(kind: ProviderKind): void {
  switchable.setProvider(kind);
}
