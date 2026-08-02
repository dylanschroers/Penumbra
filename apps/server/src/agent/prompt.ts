import {
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
}

export interface PromptStore {
  current(): PromptState;
  /** Store a persona. Returns the new state, or null when it is too long. */
  set(persona: string): PromptState | null;
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
    return {
      persona: stored ?? AGENT_PERSONA_DEFAULT,
      fallback: AGENT_PERSONA_DEFAULT,
      policy: AGENT_POLICY,
      source: stored === undefined ? "default" : "settings",
      maxLength: AGENT_PERSONA_MAX,
    };
  }

  return {
    current,
    set(persona) {
      if (persona.length > AGENT_PERSONA_MAX) return null;
      writeSetting.run({ key: KEY_PERSONA, value: persona });
      return current();
    },
    clear() {
      dropSetting.run(KEY_PERSONA);
      return current();
    },
  };
}
