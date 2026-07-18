import { OpenAiEngine, type ToolBindings } from "@ghost/shared";

// Tier 1: the server-side model, an Unsloth Studio instance on the GPU host.
//
// Studio is OpenAI-compatible — same /v1/chat/completions, same /v1/models,
// same tools/tool_choice semantics — so this is @ghost/shared's OpenAiEngine
// plus an address, a model, and a bearer token. That is the whole engine. The
// branch this work salvages reached Studio through @anthropic-ai/sdk and an
// `unsloth connect claude` handshake; none of that is needed on the OpenAI seam
// (docs/UNSLOTH_TIER1_PLAN.md → "Unsloth is on the seam").

/** Studio's default listen address. */
const DEFAULT_BASE_URL = "http://127.0.0.1:8888";
/** Sent as the model id when none is configured; Studio serves whatever it has
 *  loaded, and getStatus() reports the real id. */
const DEFAULT_MODEL = "unsloth";
/** Tier 1 exists for multi-step work and runs a larger model than Tier 0, so it
 *  gets a longer leash than OpenAiEngine's small-model default of 4. */
const DEFAULT_MAX_TOOL_STEPS = 8;

export interface UnslothEngineConfig {
  /** Tools, prompt, and executor for every turn. Server-side in Tier 1 — the
   *  client is not in the turn loop (docs/UNSLOTH_TIER1_PLAN.md → §2). */
  bindings: ToolBindings;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  maxToolSteps?: number;
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
      label: "unsloth studio",
    });
  }
}
