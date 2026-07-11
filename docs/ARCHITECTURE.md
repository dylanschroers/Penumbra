# Ghost — Architecture

## Guiding principles

1. **Local-first.** Each device holds a full local copy of your data and works
   completely offline. A sync engine reconciles with the server in the
   background and pushes changes when you reconnect. The local store — not the
   server — is the source of truth for the UI.
2. **One headless backend, many thin clients.** The backend knows nothing about
   any specific UI. Web, desktop, and mobile are all clients of the same API and
   sync stream. This is what makes the eventual mobile port cheap instead of a
   rewrite.
3. **Modular monolith, not microservices.** One deployable server process with
   clean internal module boundaries. A module gets split into its own service
   only if it ever actually hits a scaling wall — not preemptively.
4. **TypeScript end-to-end.** One language across server and every client, with
   shared types, schema, and tool definitions. The best local-first sync tooling
   lives in this ecosystem, and the clients all run JS anyway.
5. **Build for one user, leave the door open for more.** Every owned row carries
   a `user_id` and all queries are scoped by it from day one. Multi-user later
   becomes a config change, not a migration.

---

## The two data planes

The single most important design decision in Ghost is recognizing that not all
data can or should be offline-capable. Data is split by *where truth lives*.

```
┌──────────────────────────── ON DEVICE ────────────────────────────┐
│                                                                    │
│  PLANE A — Owned data  (local-first, synced)                       │
│  tasks · notes · budgets · manual finance entries · settings       │
│    • SQLite is the source of truth for the UI                      │
│    • edited fully offline                                          │
│    • sync engine reconciles with the server on reconnect          │
│                                                                    │
│  PLANE B — External data  (online-only, read-through cache)        │
│  live bank balances · emails · calendar · agent actions            │
│    • truth lives in Google or your bank (their systems)           │
│    • cache last-known value for offline *reading* only            │
│    • writes & agent actions queue as intents, execute on reconnect│
└────────────────────────────────────────────────────────────────────┘
                    │ sync (Plane A) + fetch (Plane B)
          ┌─────────▼─────────┐
          │   Server (Node)   │
          └───────────────────┘
```

**Rule of thumb:** if you author it, it's Plane A and works offline. If it lives
in someone else's system, it's Plane B — cache it for reading, but never let the
app act on stale Plane B data while offline (e.g. the agent must not execute a
transaction from a balance it can't currently verify).

---

## System overview

```
        ┌──────────────────────────────────────────────┐
        │                  CLIENTS                       │
        │                                                │
        │   Web (React + Vite)  ── build first           │
        │        │                                       │
        │        ├─ Desktop  = wrap web in Tauri         │
        │        └─ Mobile   = Capacitor / React Native  │
        │                                                │
        │   each client embeds:                          │
        │     • local SQLite store (Plane A truth)       │
        │     • sync client                              │
        └───────────────┬────────────────────────────────┘
                        │  REST (commands/queries)
                        │  + sync stream (Plane A)
                        │  + WebSocket (live Plane B push)
        ┌───────────────▼────────────────────────────────┐
        │            SERVER  (modular monolith)           │
        │                                                 │
        │  Identity · Tasks · Finance · Agent             │
        │  Integrations · Notifications · Audit           │
        │                                                 │
        │  ┌───────────┐   ┌──────────────────────────┐   │
        │  │ Postgres  │   │ Worker (scheduler/poller)│   │
        │  └───────────┘   └──────────────────────────┘   │
        └───────────────┬─────────────────────────────────┘
                        │  OAuth + REST
        ┌───────────────▼─────────────────────────────────┐
        │   External services                              │
        │   Google (Calendar/Gmail) · banking · model API  │
        └──────────────────────────────────────────────────┘
```

---

## Backend modules

One process. Each module owns its tables and exposes a typed internal interface;
they call each other in-process, not over the network.

| Module | Responsibility |
|---|---|
| **Identity** | auth, sessions, device registration, per-device sync state |
| **Tasks** | task CRUD, recurrence, priorities, deadlines, categories |
| **Finance** | accounts, transactions, budgets, balance snapshots |
| **Agent** | LLM orchestration, the tool registry, tool execution |
| **Integrations** | OAuth connectors behind one uniform adapter interface |
| **Notifications** | one interface, swappable transports (push / email / in-app) |
| **Audit** | append-only log of every agent action — required for the finance side |
| **Scheduler/Worker** | separate process: fires reminders, polls integrations, runs recurring jobs |

### The tool registry is the spine

Because "universal tool calling" is the core feature, the tool registry is a
first-class part of the backend, not something bolted onto the agent. Each
capability — `createTask`, `readCalendar`, `fetchBalance` — is registered once
as a tool with:

- a **typed argument schema** (Zod),
- a **permission level**,
- an **audit hook**,
- a single **implementation**.

Both the REST API and the agent invoke the *same* tool implementations. The API
is "a human pulled this trigger"; the agent is "the model pulled this trigger."
This is what makes the agent trustworthy and keeps behavior consistent across
the two entry points.

The agent talks to its model through a single provider-neutral seam — an
OpenAI-compatible client — so any local server, self-hosted endpoint, or opt-in
cloud provider drops in behind the same `{ baseURL, model }` config. No
LangChain: for a single-agent tool loop, a framework adds indirection without
buying much.

---

## AI & inference

AI in Ghost is **local-first, like the rest of the app**: a small model ships
embedded in the client and works with no server and no network. A self-hosted
server or an opt-in cloud provider are *optional escalations*, never a hard
dependency — nothing here is welded to any single vendor. See AGENT_DESIGN.md for
the full model.

### Capabilities, not model sizes

"Agentic" work is not one big model doing everything; it is a router dispatching
each request to the cheapest thing that can handle it. The capability types:

| Capability | Handled by | Where |
|---|---|---|
| **Route / classify** intent | a tiny classifier, rules, or embeddings (often no LLM) | on device |
| **Retrieve / search / memory** | an **embedding model** + a vector index over local SQLite | on device |
| **Generate / converse / guide** | the embedded chat model | on device |
| **Orchestrate tools, multi-step** | a larger model (self-hosted or opt-in cloud) | server / cloud |
| **Proactive / background** | the same larger model, run autonomously | Worker |

The embedding model is a distinct artifact from the chat model, and it is what
keeps a small on-device model useful: it grounds answers in the user's own data
instead of leaning on raw parameter count.

### Deployment tiers

All three tiers sit behind the one provider-neutral seam above.

- **Tier 0 — Embedded (default).** A small model bundled with the app. Guidance,
  Q&A, and *light* local tool calls (e.g. `createTask`), constrained to valid
  JSON. Zero download, fully offline, private.
- **Tier 1 — Self-hosted (optional).** The user runs the Ghost server with a
  larger model for the full tool registry and multi-step agent work, plus sync.
- **Opt-in cloud.** The user may point the same seam at a cloud provider for
  maximum capability. Never required, never assumed.

### Guidance vs. agent

Two roles with opposite needs, kept deliberately separate. **Guidance** (Tier 0)
is small, always-on, and does not need the tool loop. The **agent** (Tier 1)
orchestrates the tool registry and wants capability. One bundled small model is a
good guide and a poor multi-step agent, which is why they are not the same model.
Small on-device tool calling is viable but bounded — reliable for a *few*
well-described tools in a single step with constrained decoding, degrading with
many tools or long multi-hop loops.

---

## The web shell: workspace canvas + module registry

The web client is a **blank workspace canvas**, not a fixed-layout app. Features
live as **modules** — self-contained cards (tasks today; weather, notes, agent
chat later) that the user places, drags, and resizes on a snapping grid.

- **Module registry** (`workspace/registry.ts`) — the frontend counterpart to the
  backend tool registry. A module is *defined once* (`id`, `title`, default/min
  size, its React component); the canvas can then place, render, and persist any
  module without knowing its internals. Adding a feature is one registry entry
  plus its component — the canvas, the "add module" menu, and persistence pick it
  up automatically.
- **Modules** (`modules/<feature>/`) own their data and render only their inner
  content. The surrounding card chrome (title bar, drag handle, close, sizing)
  belongs to the workspace `ModuleFrame`, never the module.
- **Canvas** (`workspace/Workspace.tsx`) lays modules out on a snapping grid via
  `react-grid-layout` (v1.5, the React-18-stable line; `compactType={null}` for
  free placement). Positions/sizes are stored in grid units, not pixels.
- **Layout persistence** is user-authored data, so it's **Plane A**. It currently
  persists to `localStorage` (`workspace/useLayout.ts`); the hook's interface is
  shaped so it can graduate to the shared SQLite schema — and sync across devices
  — without touching the canvas. Module data itself (e.g. tasks) already lives in
  the local SQLite store.
- **Storage backends, one DbApi.** All database logic (CRUD, sync bookkeeping,
  migrations) is storage-agnostic (`db/api.ts`), built on a single "run this
  SQL, return rows" primitive. In the **browser** that primitive is sqlite-wasm
  against OPFS inside a Web Worker (`db/worker.ts`). In **Tauri** it is native
  SQLite in the Rust process against an ordinary file in the app data dir
  (`db/tauriExec.ts` → `src-tauri/src/db.rs`) — desktop persistence never
  depends on webview storage. There is deliberately **no silent fallback**: if a
  backend cannot persist, it fails loudly rather than accepting data into an
  in-memory store that dies with the session. Mobile later follows the same
  pattern with a native SQLite plugin.
- **Single-tab ownership.** The browser's OPFS `SAHPool` VFS takes an
  *exclusive* lock on its files — a second tab opening it throws
  `NoModificationAllowedError`. `SingleTabGuard` (`src/SingleTabGuard.tsx`) gates
  the app on a Web Locks (`navigator.locks`) exclusive lock: the first tab owns the
  store; other tabs render a takeover screen instead. The DB backend is created
  lazily (`db/client.ts` `getDb()`) so a non-owner tab never opens the store, and
  an owner hands off by closing the DB (freeing the handles) before releasing the
  lock. Multi-tab concurrency would instead need a `SharedWorker`; deferred since
  the app is desktop-first (Tauri is a single window).

> Status: the canvas, registry, `ModuleFrame`, grid movement, and localStorage
> persistence are implemented with the Tasks module. Graduating the layout to the
> shared SQLite schema, plus the weather and agent-chat modules, are still to do.

## Sync

- **Server DB:** Postgres.
- **Client DB:** SQLite (one per device).
- **Engine:** PowerSync or ElectricSQL — both do Postgres ↔ SQLite replication
  and support web + mobile. The choice is swappable; treat it as a dependency
  behind the data layer, not a foundation everything is welded to.
- **Conflict strategy:** last-write-wins per row. Because Ghost is one user
  across their own devices, true simultaneous edits are rare, so CRDTs
  (Yjs / Automerge) are unnecessary. Reach for them only if real-time
  collaborative editing is ever added.
- **Schema sharing:** Drizzle defines each table once in `packages/shared` and
  emits both the Postgres (server) and SQLite (client) dialects, so the two
  halves of the local-first store never drift.

---

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript | server + every client |
| Monorepo | pnpm workspaces + Turborepo | shared schema / types / tool defs |
| Server | Node + Fastify (or Hono) | headless API |
| Server DB | PostgreSQL | single DB, modules own tables |
| Client DB | SQLite | local source of truth; sqlite-wasm + OPFS on web, native file via Tauri IPC on desktop |
| ORM | Drizzle | one schema → Postgres + SQLite dialects |
| Sync | PowerSync or ElectricSQL | Postgres ↔ SQLite |
| Validation | Zod | API, forms, and tool args from one source |
| Web UI | React + Vite | built first |
| Desktop | Tauri | wraps the web UI (~10 MB vs Electron ~150 MB) |
| Mobile (later) | Capacitor or React Native / Expo | backend unchanged |
| Agent | OpenAI-compatible client + custom tool registry | provider-neutral; local by default, self-hosted / cloud optional; no LangChain |
| Local inference | bundled llama.cpp (GGUF) + a small embedding model | Tier 0, offline; exposed as a local OpenAI-compatible endpoint |
| Background jobs | a dedicated worker process | scheduling, integration polling |
| Auth | start with local sessions; add a provider only if/when multi-user lands |

Deferred until a feature forces them: Redis / message queues, *server-side*
vector databases, secrets vaults, Kubernetes. (On-device semantic search uses a
lightweight local index, not a hosted vector DB.) A single-user assistant does
not need any of these on day one.

---

## Monorepo layout

```
ghost/
├── packages/
│   └── shared/              # the seam between server and clients
│       ├── schema/          # Drizzle table defs (→ Postgres + SQLite)
│       ├── types/           # shared TS types
│       ├── tools/           # tool registry definitions + Zod arg schemas
│       └── validation/      # shared Zod schemas
│
├── apps/
│   ├── server/
│   │   ├── modules/
│   │   │   ├── identity/
│   │   │   ├── tasks/
│   │   │   ├── finance/
│   │   │   ├── agent/        # orchestrator + tool execution
│   │   │   ├── integrations/ # email · calendar · banking adapters
│   │   │   ├── notifications/
│   │   │   └── audit/
│   │   ├── worker/           # scheduler + integration pollers
│   │   └── main.ts
│   │
│   ├── web/                  # React + Vite — build first
│   │   ├── src/
│   │   │   ├── workspace/    # the canvas shell + module registry
│   │   │   ├── modules/      # self-contained feature modules (tasks · …)
│   │   │   ├── db/           # local SQLite (worker + Drizzle) + sync client
│   │   │   └── lib/
│   │   └── index.html
│   │
│   ├── desktop/              # Tauri shell around web
│   └── mobile/               # added later (Capacitor or RN)
│
└── docs/
    ├── ARCHITECTURE.md
    ├── AGENT_DESIGN.md       # inference tiers, tool registry + execution model
    └── SYNC.md               # to write: sync engine choice + conflict rules
```

---

## Roadmap (de-risks sync by deferring it)

The ordering deliberately ships something useful *before* tackling the hardest
part (sync), so you only invest in syncing an app you already know is worth it.

1. **Offline-only v0** — web UI + local SQLite, **no server**. Tasks and
   scheduling fully working on one device. Proves the app is useful.
2. **Server + sync** — stand up Postgres + the sync engine; wire Plane A.
   Now it's multi-device.
3. **Desktop** — wrap the web UI in Tauri. Near-zero new code.
4. **Agent + integrations** — tool registry and the agent loop (local-first, on
   the embedded model), plus Google / email / banking OAuth connectors, which are
   online-only (Plane B).
5. **Mobile** — Capacitor or React Native, reusing the API + shared types.

---

## Security & privacy

- OAuth for all third-party integrations; never store raw third-party passwords.
- Encryption in transit (TLS) and at rest for credentials.
- Append-only audit log for every agent action, with timestamp and the
  triggering actor (human vs agent).
- Per-tool permission levels; the agent cannot exceed the permissions of its
  registered tools.
- Treat Plane B as untrusted while offline: never act on stale external data.
- AI is local-first: Tier 0 keeps prompts and data on device. Cloud inference is
  opt-in, and when enabled is treated as Plane B (external, untrusted offline).
- `user_id` scoping on every owned row from day one.
```
