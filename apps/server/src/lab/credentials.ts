import type Database from "better-sqlite3";
import { DEFAULT_STUDIO_URL } from "./studio";

// Where the local Studio's address and bearer come from, and how they change
// without a restart.
//
// Studio mints a fresh key on reinstall and on every rotation. Until this, a new
// key meant editing apps/server/.env and bouncing the server, because both the
// lab's StudioClient and the inference engine read process.env once at
// construction. A value set here outranks the environment and is remembered, so
// the environment stays the deployment default and the UI is the override.
//
// The key is stored in the server's SQLite file in plain text. That is the same
// posture as the .env it replaces — a secret at rest on the machine that uses
// it, readable by anything that can read the server's files — and not a
// stronger one. It is never returned to a client.

const KEY_URL = "studio.baseURL";
const KEY_API = "studio.apiKey";

export interface StudioCredentials {
  baseURL: string;
  /** Absent when Studio runs without a bearer, which a trusted LAN one may. */
  apiKey?: string;
  /** "settings" once set through the API; "env" while the environment governs.
   *  Shown in the UI so it's clear which of the two is in force. */
  source: "env" | "settings";
}

export interface CredentialStore {
  current(): StudioCredentials;
  /** Set one or both fields. The other keeps whatever it resolves to now. */
  set(input: { baseURL?: string; apiKey?: string }): StudioCredentials;
  /** Forget the stored values and fall back to the environment. */
  clear(): StudioCredentials;
  /** Runs after every change. Clients built from these credentials rebuild
   *  here — training and inference must never end up on different Studios. */
  onChange(fn: (credentials: StudioCredentials) => void): void;
}

export function createCredentialStore(
  db: Database.Database,
  env: Record<string, string | undefined> = process.env,
): CredentialStore {
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
  const dropSettings = db.prepare(
    `DELETE FROM lab_settings WHERE key IN (?, ?)`,
  );

  const read = (key: string): string | undefined =>
    (readSetting.get(key) as { value: string } | undefined)?.value;

  const listeners: ((credentials: StudioCredentials) => void)[] = [];

  function current(): StudioCredentials {
    const storedURL = read(KEY_URL);
    const storedKey = read(KEY_API);
    return {
      baseURL: storedURL ?? env.UNSLOTH_BASE_URL ?? DEFAULT_STUDIO_URL,
      // An empty stored key is a deliberate "no bearer", not a missing value,
      // so it must not fall through to the environment.
      apiKey:
        storedKey === undefined
          ? env.UNSLOTH_API_KEY || undefined
          : storedKey || undefined,
      source:
        storedURL !== undefined || storedKey !== undefined ? "settings" : "env",
    };
  }

  function announce(): StudioCredentials {
    const next = current();
    for (const fn of listeners) fn(next);
    return next;
  }

  return {
    current,
    set(input) {
      if (input.baseURL !== undefined) {
        writeSetting.run({ key: KEY_URL, value: input.baseURL });
      }
      if (input.apiKey !== undefined) {
        writeSetting.run({ key: KEY_API, value: input.apiKey });
      }
      return announce();
    },
    clear() {
      dropSettings.run(KEY_URL, KEY_API);
      return announce();
    },
    onChange(fn) {
      listeners.push(fn);
    },
  };
}
