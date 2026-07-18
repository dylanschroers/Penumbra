// Picks the engine the agent module talks to — see docs/AGENT_DESIGN.md →
// "Deployment tiers". Nothing above this file knows which backend answered.
//
// This file is the composition root: LocalEngine stays free of app imports (its
// tools are injected, which is what keeps it testable), and the wiring to the
// client store happens here instead.

import {
  type Engine,
  ResolvingEngine,
  type ToolBindings,
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

/**
 * `auto` (the default) prefers the server when one is reachable and falls back
 * to the embedded model, so a laptop with no server still works offline and the
 * same build uses the stronger backend when it is there. `local` and `remote`
 * pin one, which is mostly useful for development and tests.
 */
type EngineKind = "auto" | "local" | "remote";

function createEngine(): Engine {
  const local = new LocalEngine({ bindings: clientBindings });
  const remote = new RemoteEngine({ token: import.meta.env.VITE_AGENT_TOKEN });
  const kind = (import.meta.env.VITE_ENGINE ?? "auto") as EngineKind;

  switch (kind) {
    case "local":
      return local;
    case "remote":
      return remote;
    case "auto":
      return new ResolvingEngine([
        { name: "remote", engine: remote },
        { name: "local", engine: local },
      ]);
    default: {
      // Exhaustive today; keeps the switch honest as kinds are added.
      const unknown: never = kind;
      throw new Error(`Unknown engine: ${String(unknown)}`);
    }
  }
}

/** The engine the agent module uses. Construction is cheap — no connection is
 *  opened until getStatus() or runAgent() is called. */
export const engine: Engine = createEngine();
