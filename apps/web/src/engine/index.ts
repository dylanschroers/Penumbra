// Picks the engine the agent module talks to. The embedded model is the only
// one today (Tier 0, no server); a remote engine against a self-hosted Ghost
// server returns with Tier 1 — see docs/AGENT_DESIGN.md → "Deployment tiers" —
// behind this same module, so nothing above here changes when it lands.
//
// This file is the composition root: LocalEngine itself stays free of app
// imports (its tools are injected, which is what keeps it testable), and the
// wiring to the client store happens here instead.

import { AGENT_SYSTEM, runTool, toolSpecs } from "../agent/tools";
import { LocalEngine } from "./LocalEngine";
import type { Engine, ToolBindings } from "./types";

export { LocalEngine, type LocalEngineConfig } from "./LocalEngine";
export type {
  AgentEvent,
  AgentState,
  AgentStatus,
  ChatMessage,
  ChatRole,
  Engine,
  ToolBindings,
} from "./types";

/** Tier 0 runs tools in the browser, against the client's own store. */
const clientBindings: ToolBindings = {
  tools: toolSpecs,
  system: AGENT_SYSTEM,
  runTool,
};

/** Which engine to build. Tier 1 adds "remote" here; auto-detection (probe
 *  Unsloth's /v1/models, fall back to llama-server) is the other candidate and
 *  stays a decision for that phase — docs/UNSLOTH_TIER1_PLAN.md → §6. */
type EngineKind = "local";

function createEngine(): Engine {
  const kind = (import.meta.env.VITE_ENGINE ?? "local") as EngineKind;
  switch (kind) {
    case "local":
      return new LocalEngine({ bindings: clientBindings });
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
