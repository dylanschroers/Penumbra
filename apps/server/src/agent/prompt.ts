import {
  AGENT_MAX_TOKENS_MAX,
  AGENT_MAX_TOKENS_MIN,
  AGENT_PERSONA_DEFAULT,
  AGENT_PERSONA_MAX,
  AGENT_POLICY,
} from "@penumbra/shared";
import type Database from "better-sqlite3";

// Where the editable half of the system prompt lives.
//
// Server-side, and deliberately not client-supplied. The prompt is the
// highest-privilege text in a turn, and this server's agent executes write and
// delete tools in-process (../http/auth → "an actuator rather than data"), so a
// prompt arriving with each request would be a tool-running instruction channel
// open to anything that can reach the route. RemoteEngine already states the
// other half of this rule: it holds no bindings because the server owns the
// tools, the prompt, and execution.
//
// The browser's embedded engine reads the same value through GET /agent/prompt
// and caches it, so both tiers run one prompt rather than drifting apart — the
// failure the compute refactor fixed for Studio credentials.

/** Same table the compute targets use: one settings store, not two. */
const KEY_PERSONA = "agent.persona";
/** The reply-length cap. Stored beside the persona because it is the same kind
 *  of setting — how a turn runs, edited from the same panel, read fresh per
 *  turn — and a second store for one integer would be two places to look. */
const KEY_MAX_TOKENS = "agent.maxTokens";

export interface PromptState {
  /** The persona in force, stored or default. */
  persona: string;
  /** The shipped default, so the UI can offer a reset and show a diff. */
  fallback: string;
  /** The fixed half, shown read-only: "see the system prompt" means all of it. */
  policy: string;
  /** Which of the two is in force. Mirrors ComputeTarget.source. */
  source: "default" | "settings";
  /** Longest persona the route will accept. */
  maxLength: number;
  /**
   * Reply-length cap, or null to let each tier use its own default.
   *
   * Null rather than a number, because the two tiers do not want the same
   * ceiling: 512 keeps a 1.7B model from running away on thinking tokens, and
   * would cut a 12B model off mid-sentence. One shared override with no value
   * means "each tier knows best", which is the right default and the only one
   * that does not silently re-break the truncation this came from.
   */
  maxTokens: number | null;
}

export interface PromptStore {
  current(): PromptState;
  /** Store a persona. Returns the new state, or null when it is too long. */
  set(persona: string): PromptState | null;
  /** Store a reply-length cap, or null to go back to each tier's own default.
   *  Returns null when the value is out of range. */
  setMaxTokens(value: number | null): PromptState | null;
  /** Forget the override and fall back to the shipped default. */
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
    // An empty stored persona is a deliberate "no style guidance", the same
    // distinction targets.ts draws for a deliberately keyless Studio, so it must
    // not read as absent and fall back to the default.
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
      // A row that is missing or unreadable reads as "no override" rather than
      // as a cap of NaN, which would reach the wire and cap nothing.
      maxTokens: Number.isFinite(parsed) ? parsed : null,
    };
  }

  return {
    current,
    set(persona) {
      if (persona.length > AGENT_PERSONA_MAX) return null;
      writeSetting.run({ key: KEY_PERSONA, value: persona });
      return current();
    },
    setMaxTokens(value) {
      if (value === null) {
        dropSetting.run(KEY_MAX_TOKENS);
        return current();
      }
      if (
        !Number.isInteger(value) ||
        value < AGENT_MAX_TOKENS_MIN ||
        value > AGENT_MAX_TOKENS_MAX
      ) {
        return null;
      }
      writeSetting.run({ key: KEY_MAX_TOKENS, value: String(value) });
      return current();
    },
    clear() {
      dropSetting.run(KEY_PERSONA);
      return current();
    },
  };
}
