# Ghost

**A local-first personal assistant that manages your tasks, finances, and daily
responsibilities — and can act on them through an AI agent.** Your data lives on
your devices and works fully offline, syncing across them when you reconnect.

## What makes Ghost different

- **Local-first** — every device holds a full copy of your data, works
  completely offline, and syncs in the background when reconnected.
- **Agentic** — a tool-calling AI that can actually *do* things on your behalf
  (create tasks, read your calendar, check balances), not just chat.
- **Unified** — tasks, scheduling, finances, and third-party integrations in one
  place instead of five apps.

## How it's built

One headless backend, with thin clients that share its types and sync stream:

```
   Web · Desktop · Mobile          (each with a local store, works offline)
            │
            │  REST + sync stream
            ▼
     Headless server               (modular monolith)
            │  OAuth + REST
            ▼
   Google · banking · model API
```

**TypeScript end-to-end · React + Tauri clients · Node + Postgres server ·
local-first sync over SQLite.**

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design — the two
data planes, the tool registry, sync, and the reasoning behind the stack.

## Getting started

> Prerequisites and run instructions will land with the offline v0 (see
> [Roadmap](#roadmap)).

```
# prerequisites — TBD
# install       — TBD
# run           — TBD
```

## Roadmap

The ordering ships something useful before tackling the hardest part (sync).

- [ ] **Offline v0** — web UI + local store, no server; tasks and scheduling
      working fully on one device
- [ ] **Sync** — server + sync engine; multi-device
- [ ] **Desktop** — wrap the web UI in Tauri
- [ ] **Agent + integrations** — tool registry and OAuth connectors
      (calendar, email, banking)
- [ ] **Mobile** — reuse the API and shared types

## Security & privacy

OAuth for all third-party integrations, encrypted credentials, and a full
append-only audit log of every agent action. See the security section of
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## License

To be determined.
