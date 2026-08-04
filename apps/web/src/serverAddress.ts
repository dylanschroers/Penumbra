import {
  migrateStorageKey,
  normalizeBaseUrl,
  STORAGE_NAMESPACE,
} from "@penumbra/shared";

// Where the Penumbra server lives, for everything that talks to it.
//
// This used to be two facts. SyncClient held a runtime-editable copy — the one
// the status pill edits and reports on — while api.ts and RemoteEngine each
// took the build-time VITE_SERVER_URL and never looked again. Pointing the app
// at a different server therefore moved sync and the pill, and silently left
// the Model Lab, the compute panel, the agent prompt, and Tier-1 chat talking
// to the old address. The pill read "Connected" about a server half the app was
// not using.
//
// One owner, read at call time. Callers must not cache the result: the whole
// point is that a change made in the pill's menu takes effect on the next
// request rather than the next reload.
//
// The storage key keeps its `sync.` prefix even though the value is now
// app-wide: renaming a settled key strands the value for no gain (the same rule
// the compute target store follows).
//
// The bearer lives here too, for the same reason the address does. `/sync/*` is
// ungated, but `/agent/*`, `/lab/*`, and `/compute/*` sit behind requireAuth, so
// an address you can change at runtime paired with a credential you cannot is
// half a feature: pointing the app at a second machine reached it and then got
// 401 or 403 from every route that matters, with a rebuild as the only fix.
//
// It is not a downgrade to move the token out of the bundle. VITE_AGENT_TOKEN is
// substituted into the JavaScript at build time and shipped to the browser, so
// it was never secret from anyone who could load the app; stored per device it
// is at least not baked into every copy of the build.

const SERVER_URL_KEY = `${STORAGE_NAMESPACE}.sync.server-url.v1`;
const LEGACY_SERVER_URL_KEY = "penumbra.serverUrl";
const AGENT_TOKEN_KEY = `${STORAGE_NAMESPACE}.server.agent-token.v1`;
const HISTORY_KEY = `${STORAGE_NAMESPACE}.server.history.v1`;

/** How many past servers to keep. A few more than the pill shows, so forgetting
 *  or leaving one still leaves the list populated. */
const HISTORY_MAX = 5;

/** The deployment default, used until an address is set in the UI. */
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

/** The server this client currently talks to. */
export function getServerUrl(): string {
  return serverUrl;
}

/**
 * Point the app at a different server, and remember it.
 *
 * Deliberately does no I/O: testing the new address is the sync client's job
 * (setServerUrl there persists through here and then runs a round whose result
 * flips the status pill).
 */
export function setServerUrlValue(url: string): string {
  serverUrl = normalizeBaseUrl(url);
  try {
    localStorage.setItem(SERVER_URL_KEY, serverUrl);
  } catch {
    // Non-fatal: the choice just won't survive a reload.
  }
  return serverUrl;
}

/** The build-time bearer, used until one is set in the UI. */
const DEFAULT_AGENT_TOKEN: string | undefined =
  import.meta.env.VITE_AGENT_TOKEN || undefined;

function loadToken(): string | undefined {
  try {
    const saved = localStorage.getItem(AGENT_TOKEN_KEY);
    // Absent means "never set", which falls through to the build-time value.
    // Empty means a bearer deliberately cleared — a loopback server runs without
    // one, and that choice has to stick rather than reviving the compiled-in
    // token. (Same distinction the Studio credential store draws.)
    if (saved === null) return DEFAULT_AGENT_TOKEN;
    return saved || undefined;
  } catch {
    return DEFAULT_AGENT_TOKEN;
  }
}

let agentToken: string | undefined = loadToken();

/** The bearer for the gated routes, or undefined when there is none. */
export function getAgentToken(): string | undefined {
  return agentToken;
}

/**
 * Set the bearer. An empty string means "this server needs none" and is kept as
 * such, so it does not fall back to the build-time value.
 *
 * The address is deliberately *not* cleared alongside it, nor the reverse: the
 * two are edited together in the status pill's menu, and silently dropping one
 * when the other changes loses a working credential every time someone toggles
 * between two known servers.
 */
export function setAgentToken(token: string): void {
  agentToken = token || undefined;
  try {
    localStorage.setItem(AGENT_TOKEN_KEY, token);
  } catch {
    // Non-fatal: the choice just won't survive a reload.
  }
}

/**
 * Authorization header for a gated route, or nothing at all.
 *
 * The header is omitted rather than sent empty when there is no bearer: an
 * empty one reads as a malformed credential rather than as no credential, and a
 * loopback server that runs without a token would reject it.
 */
export function authHeaders(): Record<string, string> {
  return agentToken ? { Authorization: `Bearer ${agentToken}` } : {};
}

/**
 * One server the app has connected to before.
 *
 * The token rides along so reconnecting is one click rather than re-pasting a
 * bearer — the address and the token are one fact, the same reason they are
 * edited together in the pill. It is the same class of secret already in this
 * browser, not a new exposure; the UI still never renders it.
 */
export interface ServerHistoryEntry {
  url: string;
  token: string;
  /** When it was last connected to, for ordering and a relative label. */
  at: string;
}

function loadHistory(): ServerHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    // Tolerate a malformed or half-written entry rather than throwing the whole
    // list away: keep only the ones with the shape we wrote.
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
 * Note a server the app just reached. Called on a proven connection, not on a
 * mere address change, so the list is "servers that answered" and holds no
 * typos.
 *
 * Deduped by address, newest first: reconnecting to a known server moves it to
 * the front and refreshes its token rather than adding a second row.
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
  } catch {
    // Non-fatal: history just won't persist.
  }
}

/** Drop one server from the list. The only way an entry leaves before it ages
 *  out — a machine that is gone for good, or a token not worth keeping around. */
export function forgetServer(url: string): void {
  const normalized = normalizeBaseUrl(url);
  const next = loadHistory().filter((e) => e.url !== normalized);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal.
  }
}
