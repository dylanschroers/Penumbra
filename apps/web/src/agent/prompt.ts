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

/** The server's view of the prompt. Mirrors PromptState on the server. */
export interface PromptState {
  persona: string;
  fallback: string;
  policy: string;
  source: "default" | "settings";
  maxLength: number;
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
  };
}

function remember(persona: string): void {
  try {
    localStorage.setItem(PERSONA_KEY, persona);
  } catch {
    // Non-fatal: the persona just won't survive a reload.
  }
}

/** Read the prompt from the server and mirror it locally. */
export async function fetchPrompt(): Promise<PromptState> {
  const state = await api<PromptState>("/agent/prompt");
  remember(state.persona);
  return state;
}

/** Save a persona, then mirror what the server accepted — not what was sent. */
export async function savePersona(persona: string): Promise<PromptState> {
  const state = await api<PromptState>("/agent/prompt", {
    method: "PUT",
    body: JSON.stringify({ persona }),
  });
  remember(state.persona);
  return state;
}

/** Drop the override and go back to the shipped default. */
export async function resetPersona(): Promise<PromptState> {
  const state = await api<PromptState>("/agent/prompt", { method: "DELETE" });
  remember(state.persona);
  return state;
}
