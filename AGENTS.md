# AGENTS.md

Instructions for any AI agent working in this repo. Read this whole file before
doing anything, then read [STATUS.md](STATUS.md).

## What this is

Penumbra is a local-first personal assistant: a web and Tauri desktop client
with full local SQLite, a Fastify sync/agent server, and a Model Lab that drives
Unsloth Studio. Overview: [README.md](README.md). Design: [docs/](docs/).

## Priorities

TODO(owner): the two or three things that matter most right now.

Out of scope unless asked: TODO(owner).

## Before you start

1. Read STATUS.md. If your task touches a branch listed there, read its entry.
2. Restate the task and its done criteria (see below) in a few lines. If the
   done criteria aren't clear, ask before writing code. Ask only questions
   whose answers would change what you build.
3. Work in your own git worktree on your own branch, under
   `../Penumbra-worktrees/<name>`. Never edit a worktree another agent may be
   using, and never commit to `main` directly.

## Commands

```bash
pnpm install          # Node 20+, pnpm 9 (corepack enable)
pnpm dev              # web :5173 + server :3000
pnpm desktop          # Tauri app; needs Rust and `pnpm fetch-assets` once
pnpm lint             # biome; `pnpm format` fixes
pnpm typecheck
pnpm test
pnpm tool-eval        # tool-calling eval against a local model
cargo check --locked  # in apps/desktop/src-tauri, for any Rust change
```

CI runs lint, typecheck, test, build, and `cargo check`.

## Definition of done

A task is done only when all of these hold:

- Its done criteria were written down before the work started, as observable
  behaviour ("in the web app, adding a task with a due date shows it in the
  list after reload"), not as "tests pass".
- Lint, typecheck, tests, and (for Rust changes) `cargo check` pass.
- The behaviour was checked in the running app. For web, use a headless browser
  (e.g. Playwright) and look at the screenshot. Never open visible preview
  windows. If something can't be checked (needs Studio, a GPU, a signed-in
  CLI), say so explicitly.
- Docs describing the changed behaviour are updated.
- STATUS.md is updated: what landed, what's left, and what was not verified.

Tests you wrote for your own change don't count as proof on their own.

## Rules that fail silently if broken

- **Storage identity.** Never rename anything in
  `packages/shared/src/identity/index.ts`, the localStorage keys, or the Tauri
  bundle `identifier`. Renaming orphans user data with no error.
- **Server task writes** go through `TaskSyncStore.push()`. A direct insert
  leaves `rev` NULL and the row never syncs (docs/SYNC.md → The rev trap).
- **Studio keys never reach a client.** Clients talk only to the Penumbra
  server.
- **Tool contracts** live once in `packages/shared/src/tools`; both tiers bind
  them. Keep tools few and shallow: the small model degrades as tools are added.
- **Eval pinning.** `AGENT_POLICY`, `AGENT_SYSTEM`, and `evalCases` are pinned
  to recorded benchmark suites. Changing them means bumping the suite id
  (docs/EVAL.md).
- **Auth.** `/agent/*`, `/lab/*`, `/compute/*` stay behind `requireAuth`. Don't
  add ungated actuator routes.

## Style

- Don't write code comments by default. Add one only for a non-obvious
  constraint or workaround, in as few words as possible. No narration, no
  history ("this used to...").
- Docs state what exists, in present tense. Planned work goes only in a
  "Planned" section.
- Keep changes scoped to the task. No drive-by refactors or speculative
  features.

## Never without asking the owner

- Push to a remote, open PRs, or post anything to GitHub or other services.
- Merge into `main`.
- Delete branches, worktrees, or data.
- Add AI attribution (Co-Authored-By lines etc.) to commits or PRs.
