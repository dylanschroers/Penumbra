# Penumbra — Architecture

What is built and why. Everything here in the present tense exists in the repo;
future work lives in [Planned](#planned) and nowhere else. Deep dives:
[SYNC.md](SYNC.md) (delta-sync engine), [AGENT_DESIGN.md](AGENT_DESIGN.md)
(AI/inference), [apps/desktop/SIDECAR.md](../apps/desktop/SIDECAR.md) (bundled
local model).

## Guiding principles

1. **Local-first.** Each device holds a full copy of your data and works
   completely offline. The local store — not the server — is the source of
   truth for the UI; a sync engine reconciles in the background.
2. **One headless backend, many thin clients.** The server knows nothing about
   any specific UI. Web and desktop are clients of the same API today; mobile
   later reuses it unchanged.
3. **Modular monolith, not microservices.** One deployable server process.
   Split a module out only if it actually hits a scaling wall.
4. **TypeScript end-to-end.** One language everywhere, with schema, validation,
   and tool contracts shared through one package.
5. **Build for one user, leave the door open for more.** Every owned row
   carries a `user_id` from day one, so multi-user later is a query-scoping
   change, not a migration.
6. **No speculative surface area.** Code built ahead of a real consumer gets
   removed (it lives in git history). Docs state what exists.

## The two data planes

The most important design decision: not all data can or should be
offline-capable. Data is split by *where truth lives*.

- **Plane A — owned data** (tasks, notes, settings, workspace layout): you
  author it, so the local SQLite store is the source of truth. Edited fully
  offline; the sync engine reconciles devices through the server.
- **Plane B — external data** (calendar, email, bank balances): truth lives in
  someone else's system. Cache the last-known value for offline *reading*, but
  never act on stale Plane B data while offline — the agent must not execute a
  transaction against a balance it can't currently verify.

Today Plane A is fully built for tasks (synced end-to-end). The weather module
is a small Plane B example: fetched live from the provider, with the last
result cached for offline reading — exactly the read-through-cache rule above.
The plane split governs every design decision below.

## What exists

```
   Web (React + Vite)              Desktop (Tauri, wraps the same web UI)
   • sqlite-wasm on OPFS           • native SQLite over IPC (src-tauri/src/db.rs)
     in a Web Worker               • bundled llama-server sidecar (Tier-0 model)
          │                                │
          └───── push/pull delta sync (REST) ─────┐
                                                  ▼
                              Sync server (Fastify + better-sqlite3)
```

- **`packages/shared`** — the seam between server and clients: Drizzle table
  definitions (SQLite dialect), Zod validation and sync wire schemas, and the
  tool contracts. Types are inferred from schemas, so they cannot drift.
- **`apps/web`** — the app. A workspace canvas renders registered modules
  (tasks, weather, color picker, agent chat); a storage-agnostic `DbApi` owns
  all database logic; a sync client runs the push/pull loop; `LocalEngine`
  talks to the local model.
- **`apps/server`** — the sync server: two endpoints per synced table,
  last-write-wins merge authority. See SYNC.md.
- **`apps/desktop`** — a Tauri shell around the web UI. The Rust side owns a
  native SQLite file (webview storage is never trusted with persistence) and
  spawns the bundled `llama-server` at launch. See SIDECAR.md.

### The tool registry

"Universal tool calling" is the core feature, so a capability is defined once
and every consumer derives from that definition. A **tool contract**
(`packages/shared/src/tools`) is a name, description, permission level, and a
Zod argument schema:

- the model-facing JSON Schema is **derived** from the contract (`toToolSpec`),
- the client registry (`apps/web/src/agent/tools.ts`) validates every
  model-emitted call against the same schema before running its bound
  implementation,
- the eval harness (`scripts/tool-eval.ts`) imports the same contracts and
  system prompt, so it measures exactly what ships.

Implementations are deliberately platform-bound: the client binds contracts to
its local store; the server agent later binds the same contracts to its own.
The `permission` field (`read | write | act`) is recorded but not yet enforced
— it is the hook for the planned audit log and autonomous-mode scopes.

### The web shell: workspace canvas + module registry

The web client is a blank canvas, not a fixed-layout app. Features are
**modules** — self-contained cards the user places, drags, and resizes on a
snapping grid.

- **Module registry** (`workspace/registry.ts`): a module is defined once
  (id, title, sizes, component); the canvas, the "add module" menu, and
  persistence pick it up automatically. This is the frontend counterpart of
  the tool registry.
- **Modules** (`modules/<feature>/`) own their data and render only their inner
  content; card chrome (drag bar, close, sizing) belongs to the workspace
  `ModuleFrame`.
- **Layout persistence** is user-authored (Plane A). It currently lives in
  `localStorage` (`workspace/useLayout.ts`) behind an interface shaped so it
  can graduate to the shared SQLite schema without touching the canvas.
- **One `DbApi`, per-platform storage.** All database logic (`db/api.ts`) is
  built on a single "run this SQL, return rows" primitive. Browser: sqlite-wasm
  on OPFS inside a Web Worker. Tauri: native SQLite over IPC. There is
  deliberately **no silent fallback** — a backend that cannot persist fails
  loudly instead of accepting data into a store that dies with the session.
- **Single-tab ownership.** The OPFS VFS takes an exclusive file lock, so
  `SingleTabGuard` gates the app on a Web Locks lock: the first tab owns the
  store, other tabs get a takeover screen. The DB is created lazily so a
  non-owner tab never opens it.

### Sync

A custom pull/push delta-sync over REST — deliberately not PowerSync or
ElectricSQL, which would mean an extra service for a one-user,
last-write-wins problem. The server assigns a monotonic `rev` per accepted
write (the pull cursor), rows carry soft-delete tombstones, conflicts resolve
last-write-wins by `updatedAt`, and a per-database `instance_id` lets clients
detect and survive a replaced server database. Full protocol: SYNC.md.

The server runs on better-sqlite3 today; a later move to Postgres is contained
to `apps/server/src/db.ts` (the shared Zod schema governs the wire format, not
the storage).

### AI

Local-first like everything else: a small model ships with the desktop app and
works with no server and no network. Everything sits behind one
provider-neutral seam — an OpenAI-compatible client configured by
`{ baseURL, model }` — so a self-hosted server or an opt-in cloud provider
drops in without code changes. No hard dependency on any AI vendor, no
LangChain. Model tiers, tool-calling limits, and measured results:
AGENT_DESIGN.md.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript | server + clients; Rust only in the Tauri shell |
| Monorepo | pnpm workspaces + Turborepo | shared schema / types / tool contracts |
| Server | Node + Fastify | sync endpoints |
| Server DB | better-sqlite3 | one file; Postgres later, contained to `db.ts` |
| Client DB | SQLite | sqlite-wasm + OPFS on web; rusqlite via Tauri IPC on desktop |
| ORM | Drizzle | SQLite dialect; the sqlite-proxy driver runs over any exec primitive |
| Sync | custom delta-sync | SYNC.md; swappable behind the `sync/` modules |
| Validation | Zod | one source for API, forms, and tool arguments |
| Web UI | React + Vite | react-grid-layout for the canvas |
| Desktop | Tauri 2 | ~10 MB shell; sidecar + native SQLite |
| Local inference | bundled llama.cpp (`llama-server`) + GGUF | OpenAI-compatible on localhost |

Deliberately absent until a feature forces them: Redis, message queues, vector
databases, secrets vaults, Kubernetes.

## Monorepo layout

```
penumbra/
├── packages/shared/src/
│   ├── schema/          # Drizzle table defs (SQLite dialect)
│   ├── types/           # shared structural types
│   ├── tools/           # tool contracts + JSON-Schema derivation
│   └── validation/      # Zod schemas: task CRUD + sync wire format
├── apps/
│   ├── server/src/      # Fastify sync server (db.ts, sync/tasks.ts)
│   ├── web/src/
│   │   ├── workspace/   # canvas, module registry, layout persistence
│   │   ├── modules/     # tasks · weather · color · agent chat
│   │   ├── db/          # DbApi, migrations, worker (OPFS) + tauriExec backends
│   │   ├── sync/        # sync client + status light
│   │   ├── engine/      # LocalEngine (embedded model)
│   │   └── agent/       # tool registry bindings (client half)
│   └── desktop/src-tauri/  # Tauri shell: native SQLite + llama-server sidecar
├── scripts/             # fetch-assets, tool-eval
└── docs/                # this file, SYNC.md, AGENT_DESIGN.md
```

## Planned

In rough order. Nothing below exists in code yet.

1. **Embeddings + retrieval** — bundle an embedding model and a local index so
   the embedded chat model grounds answers in the user's own data
   (AGENT_DESIGN.md §2).
2. **Workspace layout → shared schema** — graduate layout from `localStorage`
   to the synced SQLite store.
3. **Server agent (Tier 1)** — server-side tool loop against a larger
   self-hosted model; a `RemoteEngine` client behind the same engine surface.
4. **Server modules** — identity/auth (required before sync faces the open
   internet), finance, integrations (OAuth connectors), notifications, audit
   log, and a background worker for scheduled/proactive jobs.
5. **Postgres** — move the server store when multi-table sync makes it worth
   it; add the Postgres dialect beside the SQLite one in `packages/shared`.
6. **Mobile** — Capacitor or React Native against the same API and shared
   package.

## Security & privacy

Current posture, honestly stated:

- All owned data lives on your devices; the sync server sees only what it
  reconciles, and you run it yourself.
- Tier-0 inference is fully local — prompts never leave the machine.
- **Sync v0 has no auth** and reflects any CORS origin: run it on localhost or
  a trusted LAN only (SYNC.md → v0 limitations).
- The agent's tools carry declared permission levels, but enforcement, audit
  logging, OAuth, and encrypted credential storage are all **planned** — they
  arrive with the server modules that need them (identity, integrations,
  audit). Until then Penumbra holds no third-party credentials at all.
