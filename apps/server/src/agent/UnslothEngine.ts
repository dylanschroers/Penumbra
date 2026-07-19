import { OpenAiEngine, type ToolBindings } from "@penumbra/shared";

// Tier 1: the server-side model, an Unsloth Studio instance on the GPU host.
//
// Studio is OpenAI-compatible — same /v1/chat/completions, same /v1/models,
// same tools/tool_choice semantics — so this is @penumbra/shared's OpenAiEngine
// plus an address, a model, and a bearer token. That is the whole engine. The
// branch this work salvages reached Studio through @anthropic-ai/sdk and an
// `unsloth connect claude` handshake; none of that is needed on the OpenAI seam
// (docs/UNSLOTH_TIER1_PLAN.md → "Unsloth is on the seam").
//
// One constraint that is easy to violate by accident: **never send
// `enable_tools` or `mcp_enabled`.** Those ask Studio to run *its own* tool
// loop against its MCP registry. Penumbra executes tools itself, server-side,
// against the sync store (plan §2), and Studio only passes client-supplied
// tools through when neither flag is set — see
// `_explicit_studio_tool_loop_requested` and the `_sf_client_tools` gate in
// studio/backend/routes/inference.py. Setting either would silently take the
// turn away from us. OpenAiEngine sends neither.

/** Studio's default listen address. */
const DEFAULT_BASE_URL = "http://127.0.0.1:8888";
/** Sent as the model id when none is configured; Studio serves whatever it has
 *  loaded, and getStatus() reports the real id. */
const DEFAULT_MODEL = "unsloth";
/** Tier 1 exists for multi-step work and runs a larger model than Tier 0, so it
 *  gets a longer leash than OpenAiEngine's small-model default of 4. */
const DEFAULT_MAX_TOOL_STEPS = 8;
/**
 * Tier 1 is always a network hop — a LAN GPU host at best, a tunnel at worst —
 * where OpenAiEngine's 1.5s default is tuned for probing localhost. Measured
 * ~1s round trip to a Studio behind a Cloudflare tunnel, which leaves almost no
 * margin: a single slow probe reports "stopped" for a perfectly healthy Studio,
 * and the engine resolver then falls back to the embedded model mid-session.
 */
const DEFAULT_STATUS_TIMEOUT_MS = 5000;

export interface UnslothEngineConfig {
  /** Tools, prompt, and executor for every turn. Server-side in Tier 1 — the
   *  client is not in the turn loop (docs/UNSLOTH_TIER1_PLAN.md → §2). */
  bindings: ToolBindings;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  maxToolSteps?: number;
  statusTimeoutMs?: number;
  /** Environment to read defaults from. Injected so tests need not mutate the
   *  real process.env. */
  env?: Record<string, string | undefined>;
}

export class UnslothEngine extends OpenAiEngine {
  constructor(config: UnslothEngineConfig) {
    const env = config.env ?? process.env;
    // Studio issues a key (`unsloth run` console output, or Settings → API),
    // but a LAN instance may run without one — so the header is conditional
    // rather than sent empty, which Studio would reject as malformed.
    const apiKey = config.apiKey ?? env.UNSLOTH_API_KEY;
    super({
      bindings: config.bindings,
      baseURL: config.baseURL ?? env.UNSLOTH_BASE_URL ?? DEFAULT_BASE_URL,
      model: config.model ?? env.UNSLOTH_MODEL ?? DEFAULT_MODEL,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      maxToolSteps: config.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS,
      statusTimeoutMs: config.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS,
      label: "unsloth studio",
    });
  }
}
