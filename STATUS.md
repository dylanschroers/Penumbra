# STATUS.md

Current state of the work. Update the relevant entry before you finish a task:
what landed, what's left, and what you could not verify. Delete entries once
merged and cleaned up.

Last updated: 2026-11-12

## main

Merged on 2026-11-12, not yet pushed to origin:

- Paint: rotate the canvas or selection 90°.
- Agent file tools: the assistant can list, read, search, write, move, and
  delete within folders shared in the sidebar, each change approved in chat.
- Server in Docker beside a GPU llama-server (`deploy/compose.yaml`); the
  built server runs under plain `node`; the model's identity line names the
  real serving backend (from `/v1/models` `owned_by`) instead of a fixed label.
- Docs rewritten and trimmed; code comments trimmed; this file and AGENTS.md.

Not verified by hand:

- Agent file tools in the desktop app (desktop-only; unit tests and
  `cargo check` pass).
- Paint rotate in the running app (unit tests pass).
- `docker compose up` (Docker wasn't available; the built server was booted
  and answered `/sync/tasks`).

## Parked

| Branch | What | State |
|---|---|---|
| `feat/claude-loop` | Run the official `claude -p` for planning and review; free models for bulk work | Committed as WIP. Typecheck, tests, `cargo check` pass. Never run against a real `claude` binary or in the app. Based on the pre-merge file tools commit. |

The Model Lab is in main and works, but is parked: no new features.

## Next

Pick finances or server management, write a one-page plan split into small
slices, then build one slice per session.

## Known gaps

- No end-to-end smoke test; "runs in the app" is checked by hand.
- RELEASE BLOCKER: the Tauri bundle `identifier` in
  `apps/desktop/src-tauri/tauri.conf.json` is the placeholder
  `local.placeholder.assistant` (see `packages/shared/src/identity/index.ts`).
- Files changed by the merged branches still have long-form comments; trim
  them when next touched.
