# Penumbra: Architecture

Present tense means it exists in the repo; future work is under
[Planned](#planned) only.

## Guiding principles

1. **Local-first.** Each device holds a full copy of its data and works
   offline. The local store, not the server, is the UI's source of truth.
2. **One headless backend, thin clients.** The server knows nothing about any
   UI. Web and desktop share one API.
3. **Modular monolith.** One server process.
4. **Build for one user, leave the door open for more.** Every owned row carries
   a `user_id`, so multi-user is a query-scoping change, not a migration.
5. **No speculative surface area.** Code without a real consumer gets removed.
   Docs state what exists.

## The two data planes

- **Plane A, owned data** (tasks, settings): the local SQLite store is the
  source of truth, edited offline, reconciled through the server
  ([SYNC.md](SYNC.md)).
- **Plane B, external data** (weather; later calendar, email, banking): truth
  lives elsewhere. Cache the last value for offline reading, but never act on
  stale Plane B data. Weather follows this rule.

## Layout

```
packages/shared/src/   seam between server and clients
  schema/ validation/  Drizzle tables, Zod schemas, sync wire format
  tools/               tool contracts (agentTools, labTools)
  engine/              OpenAiEngine, ResolvingEngine, engine types
  eval/ lab/           eval cases + scoring, Model Lab wire types + suites
  compute/ devices/ identity/ net/
apps/server/src/       Fastify: sync/, store/, agent/, lab/, compute/, devices/, http/
apps/web/src/
  shell/               launcher, desk windowing, dock, file sidebar, status pill
  workspace/           module registry
  modules/             tasks, weather, color (Paint), agent, lab
  db/                  DbApi, migrations, OPFS worker + Tauri backends
  sync/ engine/ agent/ sync client, engine selection, client tool bindings
  fs/ compute/ devices/ color/
apps/desktop/src-tauri/src/
  db.rs fs.rs          native SQLite, filesystem commands
  dropper.rs paint.rs  screen color sampling, PNG save
  lib.rs               app setup, llama-server sidecar
scripts/               fetch-assets, tool-eval
```

## The tool registry

A tool contract (`packages/shared/src/tools`) is a name, description,
permission level, and Zod argument schema. The model-facing JSON Schema is
derived from it (`toToolSpec`), the client and server registries validate every
model-emitted call against it, and the eval harness imports the same contracts,
so all three read one source.

`agentTools` is bound by both tiers. `labTools` (the six Model Lab tools) is
bound by the server only, since it needs the job store and a Studio on that host.
The `permission` field (`read | write | act`) is not enforced yet; it is the hook
for autonomous-mode scopes and an audit log.

## The web shell

- **Module registry** (`workspace/registry.ts`): a module is defined once and
  the dock and desk pick it up.
- **Persistence.** Open modules and window positions persist per device in
  `localStorage` (`shell/session.ts`), as do UI preferences, the server address,
  and the access token. None of it syncs.
- **One `DbApi`, per-platform storage.** All database logic (`db/api.ts`) sits
  on a single "run this SQL, return rows" primitive: sqlite-wasm on OPFS in a
  worker on web, native SQLite over IPC on desktop. There is deliberately no
  silent fallback: a backend that cannot persist fails loudly.
- **Single-tab ownership.** OPFS takes an exclusive lock, so `SingleTabGuard`
  holds a Web Lock: the first tab owns the store, others get a takeover screen.
- **File sidebar** (desktop only) wraps the Tauri `fs_*` commands. The folder
  picker seeds the UI; it is not a capability boundary.

## Planned

1. **Embeddings + retrieval** to ground the embedded model in the user's data.
2. **Sync workspace layout** through the shared schema.
3. **Server modules**: identity/auth (needed before sync faces the internet),
   integrations, notifications, audit log, background worker.
4. **Postgres**, contained to `apps/server/src/db.ts` and a second dialect in
   `packages/shared`.
5. **Mobile** against the same API.

## Security & privacy

- Owned data lives on your devices and your own server.
- Tier 0 inference is fully local. The Server provider sends the conversation to
  your server, and from there to the gateway's upstream providers when
  `PENUMBRA_GATEWAY_*` is set. Without a gateway it goes only to the Studio
  target assigned to chat (your machine, or a Colab you started).
- `get_weather` sends the place name (never the conversation) to Open-Meteo's
  geocoder, then the resulting coordinates to its forecast API. No tool holds a
  third-party credential.
- **Sync has no auth.** Localhost or a trusted LAN only.
- **CORS is an allowlist** (`http/cors.ts`): the app's origins plus
  `PENUMBRA_ALLOWED_ORIGINS`. Reflecting origins would let any visited page
  drive the actuator routes over loopback.
- **Actuator routes are gated** (`http/auth.ts`): `/agent/*`, `/lab/*`,
  `/compute/*` take a per-device token (stored as SHA-256, shown once) or
  `PENUMBRA_AGENT_TOKEN`; with neither, loopback only. Device admin is offered
  in the UI only to loopback callers. Behind a proxy, `PENUMBRA_TRUST_PROXY` is
  required or every request reads as loopback.
- **Studio keys never leave the server.** They are unscoped admin keys; clients
  only learn whether a target has one.
- **The sidebar's filesystem commands are unscoped; the agent's are not.**
  `fs_*` accept any absolute path and only trusted app code calls them. The
  agent's file tools use `agent_fs_*` (`src-tauri/src/agent_fs.rs`), which
  canonicalize every path and refuse anything outside the folders shared in
  the sidebar. Every change waits for the user's approval in the chat, and
  deletes go to the OS trash.
- Permission enforcement, audit logging, and encrypted credential storage are
  planned.
