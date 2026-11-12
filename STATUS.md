# STATUS.md

Current state of the work. Update the relevant entry before you finish a task:
what landed, what's left, and what you could not verify. Delete entries once
merged and cleaned up.

Last updated: 2026-11-11

## main

- 4 commits ahead of `origin/main`, not pushed.
- Uncommitted in the main checkout: Paint rotate left/right (+ tests).
  Unit tests and typecheck pass. Not checked in the running app.

## Branches in flight

| Branch | Worktree | Purpose | State | Not verified |
|---|---|---|---|---|
| `feat/agent-file-tools` | `agent-file-tools` | Agent file tools scoped to the sidebar's folders, with approval cards; gateway fixes | 1 commit, clean, not merged | Tests, typecheck, `cargo check`, running app |
| `feat/claude-loop` | `claude-loop` | Run the official `claude -p` for plan/review, free models for bulk work. Builds on agent-file-tools | ~2,600 lines uncommitted (15 new files). TS typecheck and tests pass; wired into server and agent UI | `cargo check` (`agent_exec.rs`), running app, real `claude` binary |
| `docs/trim` | `docs-trim` | Docs rewrite, comment trim, AGENTS.md, STATUS.md | Uncommitted. Lint, typecheck, tests pass; only comments changed in code | `cargo check` on 3 Rust files (comments only) |
| `origin/feat/server-docker` | none | Server in Docker beside a GPU llama-server | 3 commits, 5 weeks old, not merged | Everything; keep or drop? |

## Merge plan

1. Commit Paint rotate on main.
2. Merge `feat/agent-file-tools`.
3. Commit `feat/claude-loop`, merge it.
4. Rebase `docs/trim`, folding in agent-file-tools' two doc paragraphs
   (ARCHITECTURE security note, AGENT_DESIGN file tools), then merge.
5. Decide on `server-docker`.
6. Push, with the owner's go-ahead.

## Cleanup (merged, safe to remove with the owner's OK)

- Worktrees: `gomodel-chat`, `markdown-old-webkit`.
- Local branches: `feat/gomodel-chat`, `fix/markdown-old-webkit`,
  `feat/paint-module`, `feat/macos-native-window`.
- Remote branches: `launch-studio`, `macos-native-window`,
  `model-lab-agent-tools`, `per-device-tokens`, `eval-prefix-sampling`.

## Known gaps

- No end-to-end smoke test. "Runs in the app" is checked by hand or ad hoc.
- RELEASE BLOCKER: the Tauri bundle `identifier` in
  `apps/desktop/src-tauri/tauri.conf.json` is the placeholder
  `local.placeholder.assistant` (see `packages/shared/src/identity/index.ts`).
