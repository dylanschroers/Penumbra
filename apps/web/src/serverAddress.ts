import {
  migrateStorageKey,
  normalizeBaseUrl,
  STORAGE_NAMESPACE,
} from "@penumbra/shared";

// The one owner of the server address and bearer, read at call time. Never
// cache the result: pill changes must apply on the next request. The key keeps
// its `sync.` prefix because renaming would strand stored values.
// VITE_AGENT_TOKEN is only the default; it ships in the bundle, so it was
// never secret.

const SERVER_URL_KEY = `${STORAGE_NAMESPACE}.sync.server-url.v1`;
const LEGACY_SERVER_URL_KEY = "penumbra.serverUrl";
const AGENT_TOKEN_KEY = `${STORAGE_NAMESPACE}.server.agent-token.v1`;
const HISTORY_KEY = `${STORAGE_NAMESPACE}.server.history.v1`;

const HISTORY_MAX = 5;

export const DEFAULT_SERVER_URL: string = normalizeBaseUrl(
  import.meta.env.VITE_SERVER_URL ?? "http://localhost:3000",
);

function load(): string {
  migrateStorageKey(LEGACY_SERVER_URL_KEY, SERVER_URL_KEY);
  try {
    const saved = localStorage.getItem(SERVER_URL_KEY);
    return saved ? normalizeBaseUrl(saved) : DEFAULT_SERVER_URL;
  } catch {
    return DEFAULT_SERVER_URL;
  }
}

let serverUrl: string = load();

export function getServerUrl(): string {
  return serverUrl;
}

/** No I/O: the sync client tests the new address. */
export function setServerUrlValue(url: string): string {
  serverUrl = normalizeBaseUrl(url);
  try {
    localStorage.setItem(SERVER_URL_KEY, serverUrl);
  } catch {}
  return serverUrl;
}

const DEFAULT_AGENT_TOKEN: string | undefined =
  import.meta.env.VITE_AGENT_TOKEN || undefined;

function loadToken(): string | undefined {
  try {
    const saved = localStorage.getItem(AGENT_TOKEN_KEY);
    // Null falls back to the build-time token; "" is a deliberately cleared
    // bearer and must stick.
    if (saved === null) return DEFAULT_AGENT_TOKEN;
    return saved || undefined;
  } catch {
    return DEFAULT_AGENT_TOKEN;
  }
}

let agentToken: string | undefined = loadToken();

export function getAgentToken(): string | undefined {
  return agentToken;
}

/**
 * "" means no bearer and sticks. Changing the token never clears the address,
 * or vice versa.
 */
export function setAgentToken(token: string): void {
  agentToken = token || undefined;
  try {
    localStorage.setItem(AGENT_TOKEN_KEY, token);
  } catch {}
}

/** Omitted rather than empty: an empty bearer reads as malformed. */
export function authHeaders(): Record<string, string> {
  return agentToken ? { Authorization: `Bearer ${agentToken}` } : {};
}

/**
 * The token rides along so reconnecting needs no re-paste; it is never
 * rendered.
 */
export interface ServerHistoryEntry {
  url: string;
  token: string;
  at: string;
}

function loadHistory(): ServerHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    // Keep well-formed entries rather than discarding the whole list.
    return parsed.filter(
      (e): e is ServerHistoryEntry =>
        !!e &&
        typeof e.url === "string" &&
        typeof e.token === "string" &&
        typeof e.at === "string",
    );
  } catch {
    return [];
  }
}

export function getServerHistory(): ServerHistoryEntry[] {
  return loadHistory();
}

/**
 * Called only on a proven connection, so the list holds no typos. Deduped by
 * address, newest first.
 */
export function recordConnection(url: string, token: string): void {
  const normalized = normalizeBaseUrl(url);
  const rest = loadHistory().filter((e) => e.url !== normalized);
  const next: ServerHistoryEntry[] = [
    { url: normalized, token, at: new Date().toISOString() },
    ...rest,
  ].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {}
}

export function forgetServer(url: string): void {
  const normalized = normalizeBaseUrl(url);
  const next = loadHistory().filter((e) => e.url !== normalized);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {}
}
