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
│    • truth lives in Google / your bank / the model provider       │
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

The agent itself calls the model provider directly via the Anthropic TS SDK — no
LangChain. For a single-agent tool loop, a framework adds indirection without
buying much.

---

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
| Client DB | SQLite | local source of truth |
| ORM | Drizzle | one schema → Postgres + SQLite dialects |
| Sync | PowerSync or ElectricSQL | Postgres ↔ SQLite |
| Validation | Zod | API, forms, and tool args from one source |
| Web UI | React + Vite | built first |
| Desktop | Tauri | wraps the web UI (~10 MB vs Electron ~150 MB) |
| Mobile (later) | Capacitor or React Native / Expo | backend unchanged |
| Agent | Anthropic TS SDK + custom tool registry | no LangChain |
| Background jobs | a dedicated worker process | scheduling, integration polling |
| Auth | start with local sessions; add a provider only if/when multi-user lands |

Deferred until a feature forces them: Redis / message queues, vector DBs,
secrets vaults, Kubernetes. A single-user assistant does not need any of these on
day one.

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
│   │   │   ├── features/     # dashboard · tasks · finance · agent
│   │   │   ├── data/         # local SQLite + sync client
│   │   │   └── lib/
│   │   └── index.html
│   │
│   ├── desktop/              # Tauri shell around web
│   └── mobile/               # added later (Capacitor or RN)
│
└── docs/
    ├── ARCHITECTURE.md
    ├── AGENT_DESIGN.md       # to write: tool registry + execution model
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
4. **Agent + integrations** — tool registry, Google / email / banking OAuth
   connectors, online-only (Plane B).
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
- `user_id` scoping on every owned row from day one.
```
