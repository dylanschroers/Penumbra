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

**TypeScript end-to-end · React + Tauri clients · Node sync server ·
local-first over SQLite** (server on better-sqlite3 today, Postgres later).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design — the two
data planes, the tool registry, sync, and the reasoning behind the stack — and
[docs/SYNC.md](docs/SYNC.md) for the delta-sync engine.

## Getting started

### Prerequisites

- **Node 20+** and **pnpm 9+** (the repo pins pnpm via `packageManager`; run
  `corepack enable` to use the right version automatically).
- For the **desktop app only**: a stable **Rust** toolchain plus the platform
  webview — WebView2 on Windows (preinstalled on Windows 11), WebKitGTK on
  Linux, WKWebView on macOS. Not needed to run the web app.

### Install

```
pnpm install
```

### Run

Start the web client and the sync server together (Turborepo runs both):

```
pnpm dev          # web → http://localhost:5173 · sync server → http://localhost:3000
```

Or run either half on its own:

```
pnpm --filter @ghost/web dev      # web only — the offline v0, no server needed
pnpm --filter @ghost/server dev   # sync server only
```

Run it as a native desktop app (wraps the same web UI in Tauri):

```
pnpm desktop         # dev window with hot reload
pnpm desktop:build   # native installers (.msi / .exe on Windows)
```

### Sync across devices

Each client keeps a full local SQLite store and works fully offline; the server
just reconciles them. To sync across machines on your LAN, copy
`apps/web/.env.example` to `apps/web/.env` and point `VITE_SERVER_URL` at the
host's address (e.g. `http://192.168.1.50:3000`). It defaults to
`http://localhost:3000`, which is right when everything runs on one machine.

Here's the web client and a fresh desktop client before their first sync — the
web app already has tasks, the desktop store is empty:

![Before sync: the web client has tasks while the newly opened desktop client is still empty](docs/images/sync-before.png)

After one sync round the desktop client mirrors the web client's tasks (note the
green status light on both):

![After sync: the desktop client now shows the same tasks as the web client](docs/images/sync-after.png)

## Roadmap

The ordering ships something useful before tackling the hardest part (sync).

- [x] **Offline v0** — web UI + local SQLite store; tasks, weather, and the
      workspace canvas working on one device
- [x] **Sync** — sync server + delta-sync engine; multi-device, last-write-wins
- [x] **Desktop** — the web UI wrapped in Tauri, sharing the same local store
- [ ] **Agent + integrations** — tool registry and OAuth connectors
      (calendar, email, banking)
- [ ] **Mobile** — reuse the API and shared types

## Security & privacy

OAuth for all third-party integrations, encrypted credentials, and a full
append-only audit log of every agent action. See the security section of
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## License

To be determined.
