// Which browser origins may talk to this server.
//
// This used to be `origin: true`, which reflects whatever Origin the caller
// sends. Paired with the loopback rule in ./auth that is a hole, and not the one
// the old comment described ("lock this down before the server ever faces the
// open internet"). The threat is not the internet reaching in — it is the
// browser already on this machine reaching out. Any page the user visits while
// the server is running can POST to http://localhost:3000/agent/chat, and
// because the browser dials from 127.0.0.1 the loopback check waves it through:
//
//     OPTIONS /agent/chat  Origin: https://evil.example  -> 204, ACAO reflected
//     POST    /agent/chat  Origin: https://evil.example  -> 200, body readable
//
// So a random site could drive the model and its write tools, start training,
// repoint compute, and read every answer. An allowlist closes it, because an
// origin the user never configured is now simply not reflected.
//
// This is a defence for the *unauthenticated* case, which is the default. With
// PENUMBRA_AGENT_TOKEN set the bearer already stops the request; the allowlist
// then just means a hostile page cannot read replies it could not authenticate
// for anyway.
//
// A plain list is the whole policy — @fastify/cors compares an array of origins
// by string equality, so there is nothing left for a predicate to decide. A
// caller that sends no Origin at all (curl, a native fetch, another service) is
// served either way and simply gets no allow-origin header back, that header
// being something only a browser reads. ./auth is what stands in front of those.

/** The app's own origins. */
const BUILT_IN_ORIGINS = [
  // Desktop, release build. Tauri v2 serves the bundle from a custom protocol,
  // which differs by platform: Windows uses an http:// form.
  "tauri://localhost",
  "http://tauri.localhost",
  // Desktop in `tauri dev`, and the plain web build, both from Vite. The port
  // is pinned in apps/web/vite.config.ts (strictPort), so it is this or nothing.
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

/**
 * Every origin allowed to read this server's responses: the app's own, plus
 * whatever `raw` names — comma-separated, from PENUMBRA_ALLOWED_ORIGINS.
 *
 * The extras exist because the server is meant to be reachable from another
 * machine: that is the whole point of the runtime address field in the status
 * pill. The client's origin is then whatever host serves it, which no built-in
 * list can predict. Naming those origins is a deliberate act, which is exactly
 * the property `origin: true` gave away for free.
 */
export function allowedOrigins(raw: string | undefined): string[] {
  const extra = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...BUILT_IN_ORIGINS, ...extra];
}

/**
 * The methods the app actually uses.
 *
 * Spelled out because @fastify/cors defaults to `GET,HEAD,POST` — the three
 * "simple" methods — and answers a preflight for anything else by simply
 * leaving it out of `access-control-allow-methods`. The browser then refuses
 * the request before it is sent, which reaches the user as "Failed to fetch"
 * and leaves *nothing* in the server log, because no request was ever made.
 *
 * That took out every write the app makes with a verb other than POST: saving
 * and resetting the system prompt, forgetting a compute target, and revoking a
 * device. All four worked from curl, which ignores CORS, which is the trap —
 * the failure is invisible from the side you would naturally test from.
 */
const ALLOWED_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE"];

/**
 * The whole CORS policy, as @fastify/cors takes it.
 *
 * One object rather than options assembled at the registration site, because
 * the test used to mirror that site by hand — and so faithfully reproduced the
 * missing `methods` while proving the origin rules worked. A policy worth
 * testing has to be the same value the server registers.
 */
export function corsOptions(raw: string | undefined): {
  origin: string[];
  methods: string[];
} {
  return { origin: allowedOrigins(raw), methods: ALLOWED_METHODS };
}
