// The embedded model is the only engine today (Tier 0, no server). A remote
// engine against a self-hosted Ghost server returns with Tier 1 — see
// docs/AGENT_DESIGN.md → "Deployment tiers" — behind this same module.
export {
  LocalEngine,
  localEngine,
  type AgentEvent,
  type AgentOptions,
} from "./LocalEngine";
export type { AgentState, AgentStatus, ChatMessage, ChatRole } from "./types";
