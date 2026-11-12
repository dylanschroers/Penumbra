import {
  AGENT_MAX_TOKENS_MAX,
  AGENT_MAX_TOKENS_MIN,
  AGENT_PERSONA_DEFAULT,
  AGENT_PERSONA_MAX,
  AGENT_POLICY,
} from "@penumbra/shared";
import type Database from "better-sqlite3";

// Server-side, never client-supplied: the prompt drives write tools, so
// accepting it per request would open an instruction channel to anyone who can
// reach the route. Tier 0 reads the same value via GET /agent/prompt.

/** Same settings table as the compute targets. */
const KEY_PERSONA = "agent.persona";
const KEY_MAX_TOKENS = "agent.maxTokens";

export interface PromptState {
  persona: string;
  fallback: string;
  policy: string;
  source: "default" | "settings";
  maxLength: number;
  /**
   * Null lets each tier keep its own default: 512 suits a 1.7B model and cuts a
   * 12B one off mid-sentence.
   */
  maxTokens: number | null;
}

/** A null `maxTokens` clears the override. */
export interface PromptPatch {
  persona?: string;
  maxTokens?: number | null;
}

export type PromptRefusal = "too_long" | "out_of_range";

export type PromptUpdate =
  | { ok: true; state: PromptState }
  | { ok: false; error: PromptRefusal };

export function personaAccepted(persona: string): boolean {
  return persona.length <= AGENT_PERSONA_MAX;
}

export function maxTokensAccepted(value: number | null): boolean {
  return (
    value === null ||
    (Number.isInteger(value) &&
      value >= AGENT_MAX_TOKENS_MIN &&
      value <= AGENT_MAX_TOKENS_MAX)
  );
}

export interface PromptStore {
  current(): PromptState;
  /** Returns null when too long. */
  set(persona: string): PromptState | null;
  /** Returns null when out of range. */
  setMaxTokens(value: number | null): PromptState | null;
  /** Validates every field before writing any, so a refused edit changes nothing. */
  update(patch: PromptPatch): PromptUpdate;
  clear(): PromptState;
}

export function createPromptStore(db: Database.Database): PromptStore {
  db.exec(`
CREATE TABLE IF NOT EXISTS lab_settings (
  key text PRIMARY KEY NOT NULL,
  value text NOT NULL
);`);

  const readSetting = db.prepare(
    "SELECT value FROM lab_settings WHERE key = ?",
  );
  const writeSetting = db.prepare(
    `INSERT INTO lab_settings (key, value) VALUES (@key, @value)
     ON CONFLICT(key) DO UPDATE SET value = @value`,
  );
  const dropSetting = db.prepare("DELETE FROM lab_settings WHERE key = ?");

  function current(): PromptState {
    // An empty stored persona is deliberate, not absent.
    const stored = (
      readSetting.get(KEY_PERSONA) as { value: string } | undefined
    )?.value;
    const cap = (
      readSetting.get(KEY_MAX_TOKENS) as { value: string } | undefined
    )?.value;
    const parsed = cap === undefined ? Number.NaN : Number(cap);
    return {
      persona: stored ?? AGENT_PERSONA_DEFAULT,
      fallback: AGENT_PERSONA_DEFAULT,
      policy: AGENT_POLICY,
      source: stored === undefined ? "default" : "settings",
      maxLength: AGENT_PERSONA_MAX,
      // NaN would reach the wire and cap nothing.
      maxTokens: Number.isFinite(parsed) ? parsed : null,
    };
  }

  function writePersona(persona: string): void {
    writeSetting.run({ key: KEY_PERSONA, value: persona });
  }
  function writeMaxTokens(value: number | null): void {
    if (value === null) dropSetting.run(KEY_MAX_TOKENS);
    else writeSetting.run({ key: KEY_MAX_TOKENS, value: String(value) });
  }

  return {
    current,
    set(persona) {
      if (!personaAccepted(persona)) return null;
      writePersona(persona);
      return current();
    },
    setMaxTokens(value) {
      if (!maxTokensAccepted(value)) return null;
      writeMaxTokens(value);
      return current();
    },
    update(patch) {
      // All checks before any write, so half an edit never lands.
      if (patch.persona !== undefined && !personaAccepted(patch.persona)) {
        return { ok: false, error: "too_long" };
      }
      if (
        patch.maxTokens !== undefined &&
        !maxTokensAccepted(patch.maxTokens)
      ) {
        return { ok: false, error: "out_of_range" };
      }
      if (patch.persona !== undefined) writePersona(patch.persona);
      if (patch.maxTokens !== undefined) writeMaxTokens(patch.maxTokens);
      return { ok: true, state: current() };
    },
    clear() {
      dropSetting.run(KEY_PERSONA);
      return current();
    },
  };
}
