import type Database from "better-sqlite3";
import { DEFAULT_STUDIO_URL } from "../lab/studio";

// Where compute lives, and which of it each part of the app uses.
//
// This replaces two half-abstractions that did the same job with different
// lifetimes: a persisted credential store for the local Studio, and a
// `let colab: StudioClient | null` held inside the lab routes. Only the first
// was reachable from chat, which was wrong — chat and the lab have always
// shared a Studio, and main.ts already built both from one set of credentials.
//
// Every target is a full Unsloth Studio. The `sk-unsloth-*` key is unscoped and
// works on /api/train/*, /api/export/*, and /v1/* alike (docs/MODEL_LAB.md →
// What Studio guarantees, fact 1), so targets do not differ in what they *can*
// do. They differ in whether their configuration survives a restart.
//
// There is deliberately no change listener. Callers resolve a target at the
// moment they use it, and a StudioClient or an engine is a URL, a key, and some
// bindings — constructing one opens no connection, so there is nothing to keep
// alive and nothing to invalidate. "Training and inference must never end up on
// different Studios" then holds structurally, rather than by every consumer
// remembering to subscribe.

/** The local Studio's stored address/bearer. Unchanged from when this was a
 *  Studio-only credential store: renaming settled keys strands their values for
 *  no gain (packages/shared/src/identity → the same rule for localStorage). */
const KEY_LOCAL_URL = "studio.baseURL";
const KEY_LOCAL_API = "studio.apiKey";
const assignKey = (role: Role): string => `assign.${role}`;

export type TargetId = "local" | "colab";

/**
 * What a target is used *for*.
 *
 * Training is deliberately absent. It is chosen per run, in the finetune
 * request's `provider` field, which is the right granularity: you decide where
 * one job goes, not where all training goes forever. Making it an assignment
 * here would add a second place to say the same thing.
 */
export type Role = "chat" | "benchmark";

export const ROLES: Role[] = ["chat", "benchmark"];

export interface TargetCredentials {
  baseURL: string;
  /** Absent when the target runs without a bearer, which a trusted-LAN Studio
   *  may. Never returned to a client. */
  apiKey?: string;
}

/** A target as the UI sees it — everything except the bearer. */
export interface ComputeTarget {
  id: TargetId;
  label: string;
  baseURL: string;
  /** Reported in place of the key, which is never read back. */
  hasKey: boolean;
  /** Whether the configuration survives a server restart. Colab's does not, by
   *  design: its bearer never touches disk, so it is re-entered each boot. */
  persistence: "persisted" | "session";
  /** Which of the environment and the stored settings is in force. Only
   *  meaningful for a persisted target. */
  source: "env" | "settings";
  /** False while no address has been given. Colab starts this way. */
  configured: boolean;
}

export interface TargetStore {
  list(): ComputeTarget[];
  credentials(id: TargetId): TargetCredentials;
  /** Set one or both fields. The other keeps whatever it resolves to now. */
  set(id: TargetId, input: { baseURL?: string; apiKey?: string }): void;
  /** Forget this target: back to the environment for local, unconfigured for
   *  Colab. */
  clear(id: TargetId): void;

  /** What the user asked for, whether or not it can be honored. */
  assignment(role: Role): TargetId;
  /**
   * What the role actually resolves to — the assignment, unless it names a
   * target with no address, in which case local.
   *
   * The fallback exists because Colab's config dies with the process: without
   * it, a server restart would leave chat permanently pointed at nothing. It is
   * reported alongside `assignment` rather than hidden, so a panel can show that
   * the two have diverged instead of quietly lying about where answers come
   * from.
   */
  effective(role: Role): TargetId;
  /** Credentials for `effective(role)`. */
  resolve(role: Role): TargetCredentials;
  assign(role: Role, target: TargetId): void;
}

export function createTargetStore(
  db: Database.Database,
  env: Record<string, string | undefined> = process.env,
): TargetStore {
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

  const read = (key: string): string | undefined =>
    (readSetting.get(key) as { value: string } | undefined)?.value;

  // Colab lives only in memory: the bearer reaches a tunnel the user pasted in,
  // and writing it down would outlive the session it belongs to.
  let colab: TargetCredentials | null = null;

  function localCredentials(): TargetCredentials {
    const storedKey = read(KEY_LOCAL_API);
    return {
      baseURL:
        read(KEY_LOCAL_URL) ?? env.UNSLOTH_BASE_URL ?? DEFAULT_STUDIO_URL,
      // An empty stored key is a deliberate "no bearer", not a missing value,
      // so it must not fall through to the environment.
      apiKey:
        storedKey === undefined
          ? env.UNSLOTH_API_KEY || undefined
          : storedKey || undefined,
    };
  }

  function credentials(id: TargetId): TargetCredentials {
    // An unconfigured Colab resolves to an empty address rather than throwing:
    // callers check `configured`, and a client built on "" simply fails to
    // reach anything, which is the same answer by a slower route.
    return id === "local" ? localCredentials() : (colab ?? { baseURL: "" });
  }

  const isConfigured = (id: TargetId): boolean =>
    id === "local" || colab !== null;

  function describe(id: TargetId): ComputeTarget {
    const creds = credentials(id);
    const stored =
      id === "local"
        ? read(KEY_LOCAL_URL) !== undefined || read(KEY_LOCAL_API) !== undefined
        : colab !== null;
    return {
      id,
      label: id === "local" ? "Local Studio" : "Colab",
      baseURL: creds.baseURL,
      hasKey: creds.apiKey !== undefined,
      persistence: id === "local" ? "persisted" : "session",
      source: stored ? "settings" : "env",
      configured: isConfigured(id),
    };
  }

  function assignment(role: Role): TargetId {
    // Chat and benchmarks both default to local: it is the only target that is
    // always configured, and the only one that survives a restart.
    return read(assignKey(role)) === "colab" ? "colab" : "local";
  }

  function effective(role: Role): TargetId {
    const want = assignment(role);
    return isConfigured(want) ? want : "local";
  }

  return {
    list: () => [describe("local"), describe("colab")],
    credentials,
    set(id, input) {
      if (id === "colab") {
        const baseURL = input.baseURL ?? colab?.baseURL;
        // Nothing to point at: a key alone does not make a target.
        if (!baseURL) return;
        colab = { baseURL, apiKey: input.apiKey ?? colab?.apiKey };
        return;
      }
      if (input.baseURL !== undefined) {
        writeSetting.run({ key: KEY_LOCAL_URL, value: input.baseURL });
      }
      if (input.apiKey !== undefined) {
        writeSetting.run({ key: KEY_LOCAL_API, value: input.apiKey });
      }
    },
    clear(id) {
      if (id === "colab") {
        colab = null;
        return;
      }
      dropSetting.run(KEY_LOCAL_URL);
      dropSetting.run(KEY_LOCAL_API);
    },
    assignment,
    effective,
    resolve: (role) => credentials(effective(role)),
    assign(role, target) {
      writeSetting.run({ key: assignKey(role), value: target });
    },
  };
}
