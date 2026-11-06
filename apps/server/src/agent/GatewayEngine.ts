import {
  AGENT_MAX_TOKENS_SERVER,
  AGENT_MAX_TOOL_STEPS_SERVER,
  type AgentStatus,
  OpenAiEngine,
  type ToolBindings,
} from "@penumbra/shared";

// A model gateway (GoModel, or anything else OpenAI-compatible that routes a
// model name to upstream providers with its own failover). Penumbra sends every
// turn to one route on it, so which provider and model answer is the gateway's
// decision, not ours.

export const GATEWAY_TARGET_ID = "gateway";

export interface GatewayConfig {
  baseURL: string;
  /** The route every turn is sent to, e.g. a GoModel virtual model. */
  model: string;
  apiKey?: string;
  /** Shown in the status pill and named in the identity line. */
  label: string;
}

/** The gateway the environment describes, or undefined when chat should not
 *  use one. Both the address and the route are required: a gateway without a
 *  route would send turns to whatever model id the request happened to carry. */
export function gatewayConfigFromEnv(
  env: Record<string, string | undefined>,
): GatewayConfig | undefined {
  const baseURL = env.PENUMBRA_GATEWAY_URL?.trim();
  const model = env.PENUMBRA_GATEWAY_MODEL?.trim();
  if (!baseURL || !model) return undefined;
  return {
    baseURL,
    model,
    apiKey: env.PENUMBRA_GATEWAY_KEY?.trim() || undefined,
    label: env.PENUMBRA_GATEWAY_LABEL?.trim() || "Gateway",
  };
}

export interface GatewayEngineConfig extends GatewayConfig {
  bindings: ToolBindings;
  maxTokens?: number;
}

export class GatewayEngine extends OpenAiEngine {
  private readonly target: { id: string; label: string };

  constructor(config: GatewayEngineConfig) {
    super({
      bindings: config.bindings,
      baseURL: config.baseURL,
      model: config.model,
      routed: true,
      headers: config.apiKey
        ? { Authorization: `Bearer ${config.apiKey}` }
        : {},
      maxToolSteps: AGENT_MAX_TOOL_STEPS_SERVER,
      maxTokens: config.maxTokens ?? AGENT_MAX_TOKENS_SERVER,
      label: config.label,
    });
    this.target = { id: GATEWAY_TARGET_ID, label: config.label };
  }

  /** Carries its own target, so /agent/status reports the gateway rather than
   *  the Studio the chat role happens to be assigned to. */
  override async getStatus(): Promise<AgentStatus> {
    return { ...(await super.getStatus()), target: this.target };
  }
}
