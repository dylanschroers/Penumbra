import { OpenAiEngine, type ToolBindings } from "@penumbra/shared";

// Tier 0: talks directly to a local llama-server, no Penumbra server in the
// path. The protocol lives in OpenAiEngine; this adds Vite-side config the
// shared package can't read.
const DEFAULT_URL =
  import.meta.env.VITE_LOCAL_LLM_URL ?? "http://127.0.0.1:8080";
const DEFAULT_MODEL = import.meta.env.VITE_LOCAL_LLM_MODEL ?? "local";

export interface LocalEngineConfig {
  bindings: ToolBindings;
  baseURL?: string;
  model?: string;
  maxToolSteps?: number;
  /**
   * A function is read per turn, so prompt-panel edits reach this long-lived
   * engine.
   */
  maxTokens?: number | (() => number);
}

export class LocalEngine extends OpenAiEngine {
  constructor(config: LocalEngineConfig) {
    super({
      bindings: config.bindings,
      baseURL: config.baseURL ?? DEFAULT_URL,
      model: config.model ?? DEFAULT_MODEL,
      maxToolSteps: config.maxToolSteps,
      maxTokens: config.maxTokens,
      label: "local model",
    });
  }
}
