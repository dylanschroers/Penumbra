// An allowlist, not `origin: true`. Reflecting any origin combined with the
// loopback exemption let any page the user visits drive /agent/* over
// localhost. Callers with no Origin (curl, services) get no allow-origin
// header; ./auth gates them.

const BUILT_IN_ORIGINS = [
  // Tauri v2's custom protocol differs by platform; Windows uses http://.
  "tauri://localhost",
  "http://tauri.localhost",
  // Vite's port is pinned (strictPort) in apps/web/vite.config.ts.
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

/**
 * Extras come from PENUMBRA_ALLOWED_ORIGINS (comma-separated), for a web build
 * served from another host.
 */
export function allowedOrigins(raw: string | undefined): string[] {
  const extra = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...BUILT_IN_ORIGINS, ...extra];
}

/**
 * @fastify/cors defaults to GET/HEAD/POST and drops other verbs from preflight
 * answers. The browser then refuses the request with "Failed to fetch" and
 * nothing reaches the server log; curl ignores CORS, so it looks fine there.
 */
const ALLOWED_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE"];

/** One object so the test registers exactly what the server does. */
export function corsOptions(raw: string | undefined): {
  origin: string[];
  methods: string[];
} {
  return { origin: allowedOrigins(raw), methods: ALLOWED_METHODS };
}
