import {
  AGENT_PERSONA_DEFAULT,
  AGENT_PERSONA_MAX,
  AGENT_POLICY,
  migrateStorageKey,
  STORAGE_NAMESPACE,
} from "@penumbra/shared";
import { api } from "../api";

// The persona the *embedded* engine runs with.
//
// The server owns the value (../../../server/src/agent/prompt): one prompt for
// both tiers, or an edit made while chatting to the server would leave the
// browser's own model on the old one — the divergence the compute refactor
// fixed for Studio credentials.
//
// But Tier 0's whole promise is "offline, always available", so it cannot block
// a turn on a server round trip. The value is therefore mirrored into
// localStorage: reads are synchronous and always answer, refreshes happen out of
// band, and a server that is unreachable simply leaves the last known persona in
// place. A first run with no server falls back to the shipped default.

const PERSONA_KEY = `${STORAGE_NAMESPACE}.agent.persona.v1`;
const LEGACY_PERSONA_KEY = "penumbra.agent.persona";
/** The reply-length cap, mirrored for the same reason the persona is: Tier 0
 *  must be able to read it with no server in reach. */
const MAX_TOKENS_KEY = `${STORAGE_NAMESPACE}.agent.maxTokens.v1`;

/** The server's view of the prompt. Mirrors PromptState on the server. */
export interface PromptState {
  persona: string;
  fallback: string;
  policy: string;
  source: "default" | "settings";
  maxLength: number;
  /** Reply-length cap, or null to let each tier use its own default. */
  maxTokens: number | null;
}

/** The mirrored persona, or null when the server has never been reached. Null is
 *  distinct from an empty string, which is a persona deliberately cleared to
 *  mean "no style guidance". */
function storedPersona(): string | null {
  migrateStorageKey(LEGACY_PERSONA_KEY, PERSONA_KEY);
  try {
    return localStorage.getItem(PERSONA_KEY);
  } catch {
    return null;
  }
}

/** The persona to run with right now. Synchronous by design — see above. */
export function cachedPersona(): string {
  return storedPersona() ?? AGENT_PERSONA_DEFAULT;
}

/** The mirrored reply cap, or null when none is set. Synchronous for the same
 *  reason as the persona: the embedded engine reads it mid-turn. */
export function cachedMaxTokens(): number | null {
  try {
    const raw = localStorage.getItem(MAX_TOKENS_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The whole prompt, assembled from what the client already holds.
 *
 * Every field of PromptState exists locally: the policy and the bounds are
 * constants compiled into the bundle, and the persona is the mirror the engine
 * itself reads. So this is not a degraded stand-in for the server's answer — for
 * the embedded model it is the *more* truthful one, being exactly what
 * composeSystem() will be handed on the next turn (../engine/index.ts).
 *
 * It is still worth asking the server when one is reachable: the mirror is
 * last-known, and an edit made from another device while this client was offline
 * has not arrived here yet.
 */
export function localPrompt(): PromptState {
  const stored = storedPersona();
  return {
    persona: stored ?? AGENT_PERSONA_DEFAULT,
    fallback: AGENT_PERSONA_DEFAULT,
    policy: AGENT_POLICY,
    // Read from the key's presence rather than by comparing against the
    // default, so a persona deliberately set to the default text still reports
    // as an override.
    source: stored === null ? "default" : "settings",
    maxLength: AGENT_PERSONA_MAX,
    maxTokens: cachedMaxTokens(),
  };
}

function remember(state: PromptState): void {
  try {
    localStorage.setItem(PERSONA_KEY, state.persona);
    if (state.maxTokens === null) localStorage.removeItem(MAX_TOKENS_KEY);
    else localStorage.setItem(MAX_TOKENS_KEY, String(state.maxTokens));
  } catch {
    // Non-fatal: the settings just won't survive a reload.
  }
}

/** Read the prompt from the server and mirror it locally. */
export async function fetchPrompt(): Promise<PromptState> {
  const state = await api<PromptState>("/agent/prompt");
  remember(state);
  return state;
}

/**
 * Save the editable settings, then mirror what the server accepted — not what
 * was sent.
 *
 * Both travel together because they are one form. `maxTokens: null` clears the
 * cap; omitting a field leaves it as it was.
 */
export async function savePrompt(patch: {
  persona?: string;
  maxTokens?: number | null;
}): Promise<PromptState> {
  const state = await api<PromptState>("/agent/prompt", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  remember(state);
  return state;
}

/** Drop the override and go back to the shipped default. */
export async function resetPersona(): Promise<PromptState> {
  const state = await api<PromptState>("/agent/prompt", { method: "DELETE" });
  remember(state);
  return state;
}
