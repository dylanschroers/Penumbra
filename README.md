# Penumbra

Penumbra is a local-first personal assistant for your tasks, finances, and daily
responsibilities, with an AI agent that can act on them for you. Your data lives
on your own devices and works fully offline, then syncs across them when you
reconnect.

## What it does

- Keeps a full copy of your data on every device, so it works offline and syncs
  in the background once you're back online.
- Runs a tool-calling AI assistant entirely on your machine: a small model
  bundled with the desktop app manages your tasks — no cloud, no network.
- The goal from here: calendar, email, and banking integrations, so one agent
  can act across all of it (see the roadmap below).

## How it's built

One headless backend serves thin clients that share its types and sync
protocol:

```
   Web · Desktop                   (each with a local store, works offline;
            │                       desktop also bundles the local model)
            │  REST push/pull sync
            ▼
      Sync server (Node)
```

The stack is TypeScript throughout: React and Tauri on the clients, a Node sync
server, and local-first storage on SQLite. The server runs on better-sqlite3 for
now and will move to Postgres later.

For the full design, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), which
covers the two data planes, the tool registry, sync, and the reasoning behind
the stack — plus what's planned around this core (integrations, server-side
agent, mobile). The delta-sync engine has its own writeup in
[docs/SYNC.md](docs/SYNC.md) and the AI design in
[docs/AGENT_DESIGN.md](docs/AGENT_DESIGN.md).

## Getting started

### Prerequisites

- Node 20 or newer and pnpm 9 or newer. The repo pins pnpm through the
  `packageManager` field, so `corepack enable` picks up the right version
  automatically.
- Only for the desktop app: a stable Rust toolchain and the platform webview
  (WebView2 on Windows, preinstalled on Windows 11; WebKitGTK on Linux;
  WKWebView on macOS). The web app does not need these.

### Install

```
pnpm install
```

### Run

Start the web client and the sync server together (Turborepo runs both):

```
pnpm dev          # web on :5173, sync server on :3000
```

Run either half on its own:

```
pnpm --filter @penumbra/web dev      # web only, the offline v0 with no server
pnpm --filter @penumbra/server dev   # sync server only
```

Run it as a native desktop app, which wraps the same web UI in Tauri:

```
pnpm desktop         # dev window with hot reload
pnpm desktop:build   # native installers (.msi and .exe on Windows)
```

To exercise the bundled AI assistant, fetch the model and `llama-server`
first — `pnpm fetch-assets` — otherwise the Assistant module just shows
"Model offline". See [apps/desktop/SIDECAR.md](apps/desktop/SIDECAR.md).

### Sync across devices

Every client keeps its own full SQLite store and works offline; the server only
reconciles them. To sync across machines on your LAN, copy
`apps/web/.env.example` to `apps/web/.env` and set `VITE_SERVER_URL` to the
host's address, for example `http://192.168.1.50:3000`. It defaults to
`http://localhost:3000`, which is what you want when everything runs on one
machine.

The screenshot below shows the web client next to a freshly opened desktop
client before their first sync. The web app already has tasks; the desktop store
is still empty.

![Web client with tasks next to an empty desktop client before syncing](docs/images/sync-before.png)

After one sync round the desktop client has the same tasks as the web client,
and both status lights are green.

![Desktop client showing the same tasks as the web client after syncing](docs/images/sync-after.png)

## Roadmap

The ordering shipped something useful before taking on the hardest part
(sync); what's left builds outward from that core.

- [x] Offline v0: web UI and local SQLite store, with tasks, weather, and the
      workspace canvas working on one device.
- [x] Sync: sync server and delta-sync engine, so it works across devices with
      last-write-wins.
- [x] Desktop: the web UI wrapped in Tauri, sharing the same local store.
- [x] Embedded agent: a small model bundled with the desktop app, calling task
      tools fully offline.
- [ ] Integrations: OAuth connectors for calendar, email, and banking, plus the
      server-side agent that orchestrates them.
- [ ] Mobile: reuse the API and shared types.

## Security & privacy

Your data stays on your devices, and the AI runs entirely locally — prompts
never leave the machine. The v0 sync server has **no auth** yet, so keep it on
localhost or a trusted LAN. OAuth for integrations, encrypted credentials, and
an append-only audit log of agent actions arrive with the server modules that
need them. Details: the security section of
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
