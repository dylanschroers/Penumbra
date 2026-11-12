import type Database from "better-sqlite3";
import { DEFAULT_STUDIO_URL } from "../lab/studio";

// Targets are resolved at use time; clients and engines are just a URL, key,
// and bindings, so there is nothing to subscribe to or invalidate. Local has an
// env default; Colab has an address only once a tunnel is pasted.

/** Key names predate this store; renaming them would strand stored values. */
const KEY_LOCAL_URL = "studio.baseURL";
const KEY_LOCAL_API = "studio.apiKey";
/**
 * Kept across restarts even though tunnels die: a stale address the panel
 * shows as "not answering" beats re-pasting.
 */
const KEY_COLAB_URL = "colab.baseURL";
const KEY_COLAB_API = "colab.apiKey";
const assignKey = (role: Role): string => `assign.${role}`;

export type TargetId = "local" | "colab";

/** Training is chosen per run, not assigned. */
export type Role = "chat" | "benchmark";

export const ROLES: Role[] = ["chat", "benchmark"];

export interface TargetCredentials {
  baseURL: string;
  /** Never returned to a client. */
  apiKey?: string;
}

export interface ComputeTarget {
  id: TargetId;
  label: string;
  baseURL: string;
  hasKey: boolean;
  source: "env" | "settings";
  configured: boolean;
}

export interface TargetStore {
  list(): ComputeTarget[];
  credentials(id: TargetId): TargetCredentials;
  set(id: TargetId, input: { baseURL?: string; apiKey?: string }): void;
  /** Back to env for local, unconfigured for Colab. */
  clear(id: TargetId): void;

  assignment(role: Role): TargetId;
  /**
   * The assignment, unless it names a target with no address, then local. A
   * dead tunnel still resolves to Colab: this sees configuration, not
   * reachability.
   */
  effective(role: Role): TargetId;
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

  function localCredentials(): TargetCredentials {
    const storedKey = read(KEY_LOCAL_API);
    return {
      baseURL:
        read(KEY_LOCAL_URL) ?? env.UNSLOTH_BASE_URL ?? DEFAULT_STUDIO_URL,
      // An empty stored key means "no bearer", not missing.
      apiKey:
        storedKey === undefined
          ? env.UNSLOTH_API_KEY || undefined
          : storedKey || undefined,
    };
  }

  // No env fallback: tunnels are minted per notebook.
  function colabCredentials(): TargetCredentials {
    return {
      baseURL: read(KEY_COLAB_URL) ?? "",
      apiKey: read(KEY_COLAB_API) || undefined,
    };
  }

  function credentials(id: TargetId): TargetCredentials {
    // Empty address rather than throwing; callers check `configured`.
    return id === "local" ? localCredentials() : colabCredentials();
  }

  const isConfigured = (id: TargetId): boolean =>
    id === "local" || colabCredentials().baseURL !== "";

  function describe(id: TargetId): ComputeTarget {
    const creds = credentials(id);
    const stored =
      id === "local"
        ? read(KEY_LOCAL_URL) !== undefined || read(KEY_LOCAL_API) !== undefined
        : isConfigured("colab");
    return {
      id,
      label: id === "local" ? "Local Studio" : "Colab",
      baseURL: creds.baseURL,
      hasKey: creds.apiKey !== undefined,
      source: stored ? "settings" : "env",
      configured: isConfigured(id),
    };
  }

  function assignment(role: Role): TargetId {
    // Local is the only target always configured.
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
        const baseURL = input.baseURL ?? read(KEY_COLAB_URL);
        if (!baseURL) return;
        writeSetting.run({ key: KEY_COLAB_URL, value: baseURL });
        if (input.apiKey !== undefined) {
          writeSetting.run({ key: KEY_COLAB_API, value: input.apiKey });
        }
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
        dropSetting.run(KEY_COLAB_URL);
        dropSetting.run(KEY_COLAB_API);
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
