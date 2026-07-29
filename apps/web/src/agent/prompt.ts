import {
  AGENT_PERSONA_DEFAULT,
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

/** The persona to run with right now. Synchronous by design — see above. */
export function cachedPersona(): string {
  migrateStorageKey(LEGACY_PERSONA_KEY, PERSONA_KEY);
  try {
    // Null means "never fetched", which is different from an empty persona
    // deliberately stored to mean "no style guidance".
    return localStorage.getItem(PERSONA_KEY) ?? AGENT_PERSONA_DEFAULT;
  } catch {
    return AGENT_PERSONA_DEFAULT;
  }
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
