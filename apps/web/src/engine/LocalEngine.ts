import { OpenAiEngine, type ToolBindings } from "@ghost/shared";

// Tier 0: the embedded model. Talks *directly* to a local OpenAI-compatible
// server (llama.cpp's `llama-server`), with no Ghost server in the path — this
// is what makes guidance work fully offline. On desktop/mobile the app spawns
// and bundles that server (see docs/AGENT_DESIGN.md → "Local model delivery");
// here we only need its address.
//
// The protocol itself lives in @ghost/shared's OpenAiEngine, shared with the
// server's Tier-1 engine. All this class adds is the Vite-side configuration,
// which cannot live in the shared package because that package also runs on the
// server (docs/UNSLOTH_TIER1_PLAN.md → Phase 2).
const DEFAULT_URL =
  import.meta.env.VITE_LOCAL_LLM_URL ?? "http://127.0.0.1:8080";
const DEFAULT_MODEL = import.meta.env.VITE_LOCAL_LLM_MODEL ?? "local";

export interface LocalEngineConfig {
  /** Tools, prompt, and executor for every turn this engine runs. */
  bindings: ToolBindings;
  baseURL?: string;
  model?: string;
  maxToolSteps?: number;
}

export class LocalEngine extends OpenAiEngine {
  constructor(config: LocalEngineConfig) {
    super({
      bindings: config.bindings,
      baseURL: config.baseURL ?? DEFAULT_URL,
      model: config.model ?? DEFAULT_MODEL,
      maxToolSteps: config.maxToolSteps,
      label: "local model",
    });
  }
}
