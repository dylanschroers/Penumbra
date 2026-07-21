export {
  type ReadSseOptions,
  readSseFrames,
  type SseFrame,
} from "./sse";

/**
 * Normalize a configured base URL: ensure a scheme, drop trailing slashes.
 *
 * A scheme-less value like `192.168.1.50:3000` is an easy thing to put in a
 * .env, and it fails in the worst possible way: `${base}/sync/tasks` becomes a
 * *relative* path, the dev server answers it with its SPA fallback, and the
 * caller gets `200 OK` full of HTML instead of a connection error. Sync then
 * fails on JSON parsing and reports itself merely "disconnected". Assume http
 * for a bare host so the request at least reaches the right machine.
 */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
}
