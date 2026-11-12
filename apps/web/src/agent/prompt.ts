import {
  AGENT_PERSONA_DEFAULT,
  AGENT_PERSONA_MAX,
  AGENT_POLICY,
  migrateStorageKey,
  STORAGE_NAMESPACE,
} from "@penumbra/shared";
import { api } from "../api";

// The server owns the persona so both tiers share it. Tier 0 can't block on a
// server, so it's mirrored in localStorage: synchronous reads, refreshed out of
// band, shipped default on a first offline run.

const PERSONA_KEY = `${STORAGE_NAMESPACE}.agent.persona.v1`;
const LEGACY_PERSONA_KEY = "penumbra.agent.persona";
const MAX_TOKENS_KEY = `${STORAGE_NAMESPACE}.agent.maxTokens.v1`;

export interface PromptState {
  persona: string;
  fallback: string;
  policy: string;
  source: "default" | "settings";
  maxLength: number;
  maxTokens: number | null;
}

/** Null means never fetched; "" means deliberately cleared. */
function storedPersona(): string | null {
  migrateStorageKey(LEGACY_PERSONA_KEY, PERSONA_KEY);
  try {
    return localStorage.getItem(PERSONA_KEY);
  } catch {
    return null;
  }
}

export function cachedPersona(): string {
  return storedPersona() ?? AGENT_PERSONA_DEFAULT;
}

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
 * Built entirely from local state, so it's exactly what the embedded model
 * runs with. The server's answer still wins when reachable, since edits from
 * other devices arrive that way.
 */
export function localPrompt(): PromptState {
  const stored = storedPersona();
  return {
    persona: stored ?? AGENT_PERSONA_DEFAULT,
    fallback: AGENT_PERSONA_DEFAULT,
    policy: AGENT_POLICY,
    // Key presence, not equality with the default.
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
  } catch {}
}

export async function fetchPrompt(): Promise<PromptState> {
  const state = await api<PromptState>("/agent/prompt");
  remember(state);
  return state;
}

/**
 * Mirrors what the server accepted, not what was sent. `maxTokens: null`
 * clears the cap.
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

export async function resetPersona(): Promise<PromptState> {
  const state = await api<PromptState>("/agent/prompt", { method: "DELETE" });
  remember(state);
  return state;
}
