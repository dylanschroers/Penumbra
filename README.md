# Penumbra

Penumbra is a local-first personal assistant for your tasks, finances, and daily
responsibilities, with an AI agent that can act on them for you. Your data lives
on your own devices and works fully offline, then syncs across them when you
reconnect.

## What it does

- Keeps a full copy of your data on every device, so it works offline and syncs
  in the background once you're back online.
- Runs a tool-calling AI assistant entirely on your machine: a small model
  bundled with the desktop app manages your tasks — no cloud, no network. Point
  it at your own server instead for a larger model, with a switch in the chat.
- Fine-tunes and benchmarks those models from inside the app (the Model Lab),
  against a GPU host you run.
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
the stack — plus what's planned around this core (retrieval, integrations,
mobile). The delta-sync engine has its own writeup in
[docs/SYNC.md](docs/SYNC.md), the AI design in
[docs/AGENT_DESIGN.md](docs/AGENT_DESIGN.md), and benchmarking and fine-tuning
in [docs/EVAL.md](docs/EVAL.md).

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
pnpm desktop:build   # native package
```

`bundle.targets` in `apps/desktop/src-tauri/tauri.conf.json` is currently pinned
to `["deb"]`, so a build produces a Debian package on Linux and nothing usable
elsewhere. Widen it there when you need another platform's installer — the
AppImage target needs FUSE tooling that is not always present. Expect roughly
1.2 GB: the bundle ships the GGUF weights and `llama-server` as resources.

To exercise the bundled AI assistant, fetch the model and `llama-server`
first — `pnpm fetch-assets` — otherwise the Assistant module just shows
"Model offline". See [apps/desktop/SIDECAR.md](apps/desktop/SIDECAR.md).

### Sync across devices

Every client keeps its own full SQLite store and works offline; the server only
reconciles them. The quickest way to point a client at another machine is the
status dot in the top-right: click it, enter the host's address, and connect —
the choice is remembered. To set the default at build time instead, copy
`apps/web/.env.example` to `apps/web/.env` and set `VITE_SERVER_URL`, for
example `http://192.168.1.50:3000`. It defaults to `http://localhost:3000`,
which is what you want when everything runs on one machine.

Reaching the agent or Model Lab from another machine additionally needs
`PENUMBRA_AGENT_TOKEN` set on the server (see `apps/server/.env.example`) and
the same value as `VITE_AGENT_TOKEN` on the client; without it those routes
answer loopback only.

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

- [x] Offline v0: web UI and local SQLite store, with tasks and weather working
      on one device.
- [x] Sync: sync server and delta-sync engine, so it works across devices with
      last-write-wins.
- [x] Desktop: the web UI wrapped in Tauri, sharing the same local store.
- [x] Embedded agent: a small model bundled with the desktop app, calling task
      tools fully offline.
- [x] Server-side agent: a larger self-hosted model running the same tool
      contracts, selectable from the chat.
- [x] Model Lab: fine-tune and benchmark models from inside the app.
- [ ] Retrieval: an embedding model and local index, so the small model can
      ground answers in your own data.
- [ ] Integrations: OAuth connectors for calendar, email, and banking.
- [ ] Mobile: reuse the API and shared types.

## Security & privacy

Your data stays on your devices, and the local AI runs entirely on your machine
— prompts never leave it. Choosing the server model sends the conversation to
your own server instead; no third party is involved either way.

The v0 sync server has **no auth** yet, so keep it on localhost or a trusted
LAN. The routes that *act* rather than move data — the agent and the Model Lab
— are gated separately: they serve loopback only until you set
`PENUMBRA_AGENT_TOKEN`. OAuth for integrations, encrypted credentials, and an
append-only audit log of agent actions arrive with the server modules that need
them. Details: the security section of
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
