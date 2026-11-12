export {
  type ReadSseOptions,
  readSseFrames,
  type SseFrame,
} from "./sse";

/**
 * Adds a scheme to a bare `host:port`: without one, `${base}/sync/tasks` becomes
 * a relative path and the dev server's SPA fallback answers 200 with HTML.
 */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
}
