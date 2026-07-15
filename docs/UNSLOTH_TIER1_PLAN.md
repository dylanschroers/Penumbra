# Ghost — Tier‑1 Unsloth Agent: Integration Plan

Companion to [AGENT_DESIGN.md](AGENT_DESIGN.md). Same convention: present tense
means it exists in the repo today; everything here is **planned** unless noted.

This plan salvages the useful parts of the `feat/ai-sidebar-unsloth` branch and
lands them on `main` as the **Tier‑1 server‑side agent** (AGENT_DESIGN.md §3),
rather than merging that branch as‑is.

---

## 1. Why not merge the branch directly

`feat/ai-sidebar-unsloth` was written before `main` absorbed the Tier‑0
embedded agent, and it made three choices `main` has since diverged from:

| Branch chose | `main` is | Verdict |
|---|---|---|
| Global pinned **sidebar**, `App.tsx` flex layout | Agent is a **canvas module** (`modules/agent`) | Drop the sidebar |
| **Client‑side** agent, no tools | **Client‑side** Tier‑0 with a full tool loop, tool tests, eval harness | Keep tools; move model server‑side |
| **Anthropic** surface via `unsloth connect claude` + SDK + `<think>` splitter | Seam is **OpenAI‑compatible** `/v1/chat/completions` (AGENT_DESIGN.md §1) | Use the OpenAI seam |

A literal `git merge` would conflict on `main.ts`, `App.tsx`, and Biome
formatting, and would re‑introduce the superseded architecture. Instead we cut a
fresh branch off `main` and port the valuable pieces re‑shaped to Tier‑1.

### Key finding — Unsloth is on the seam

Unsloth Studio exposes OpenAI‑compatible endpoints on the same `:8888` the
branch already used:

- `POST /v1/chat/completions`, `GET /v1/models`, `POST /v1/responses`
- `Authorization: Bearer sk-unsloth-…` (key from `unsloth run` console output or
  Settings → API)
- `/v1/models` returns `{"data":[{"id":…}]}` — the exact shape
  `LocalEngine.getStatus()` already parses
- `tools` / `tool_choice` behave exactly as with OpenAI

**Consequence:** the server‑side Unsloth engine is `LocalEngine`'s request shape
+ a bearer header, pointed at Studio. The branch's `@anthropic-ai/sdk`, the
`unsloth connect claude` handshake, and any OpenAI↔Anthropic translation are all
**unnecessary**. The `<think>` splitter is kept only for the later streaming UI
(AGENT_DESIGN.md §5), not for tool calls.

---

## 2. Tool execution: server‑store (decision)

The model runs server‑side in all cases (GPU placement). The open question is
where a **tool** runs when the model emits a call.

- **Server‑store (chosen default).** The server binds the shared tool contracts
  to its own `createTaskSyncStore(sqlite)` and executes in‑process; the sync
  engine converges effects to clients. The client is not in the turn loop.
- **Proxy‑to‑client (deferred).** The server bounces each tool call to the
  client, which runs it against the browser store and returns the result.

| Factor | Server‑store | Proxy |
|---|---|---|
| Autonomous / background mode (§8, no client present) | ✅ works | ❌ deadlocks — no client to run tools |
| Multi‑step latency (Tier‑1's purpose) | in‑process | one client round‑trip per step |
| Acts on user's exact on‑screen state | needs pre‑turn sync flush | ✅ inherently |
| Client‑only state (canvas/UI, "what am I looking at") | ❌ invisible | ✅ reachable |
| Audit / trust co‑location (§8) | ✅ server | split (client executes) |
| New code | server tool runner | bidirectional transport + loop parking |

**Decision:** default **server‑store** for the current task tools — it is the
only model that supports the §8 autonomous roadmap, it is lowest‑latency for the
multi‑step work Tier 1 exists for, it co‑locates audit, and it reuses the sync
engine. Mitigate staleness with a **pre‑turn client→server sync flush**. Add
**proxy** later, narrowly, only for genuinely client‑only tools, gated so
headless turns never depend on it. The `AgentOptions.runTool` callback already
absorbs both: the server supplies it for server‑store; a forwarder supplies it
for proxy — routable per tool.

---

## 3. Major steps

### Phase 1 — Formalize the engine seam (no behavior change)
- Extract an `Engine` interface (`getStatus`, `runAgent`) in
  `apps/web/src/engine/types.ts`; make `LocalEngine implements Engine`.
- Point `modules/agent/useAgent.ts` at an `engine` chosen by a factory in
  `engine/index.ts` (default `local`). Nothing observable changes — safe
  scaffolding, its own commit.

### Phase 2 — Server‑side Unsloth engine (OpenAI seam)
- Server agent loop = `LocalEngine`'s `/v1/chat/completions` request shape +
  `Authorization: Bearer`, with `baseURL` / key / model from env, pointed at the
  server's Studio.
- Drop `@anthropic-ai/sdk`, the `unsloth connect claude` handshake, and any tool
  translation. Keep only a trivial `/v1/models` status probe.

### Phase 3 — Server‑side tool runner (the real net‑new work)
- Bind the shared contracts (`createTaskTool`, `listTasksTool`, …) to
  `createTaskSyncStore(sqlite)` — the server mirror of `apps/web/src/agent/tools.ts`.
  Contracts are already shared, so this is small and clean
  (`packages/shared/src/tools/contract.ts` predicted it).
- Add the pre‑turn sync flush.

### Phase 4 — Client `RemoteEngine` behind the existing module
- `RemoteEngine implements Engine` forwards `runAgent` / `getStatus` to the
  server's `/agent/*` (SSE). The existing `AgentModule` + `useAgent` render it
  unchanged — this replaces the branch's bespoke sidebar.
- Wire `/agent/chat` and `/agent/status` into `main`'s current `apps/server/src/main.ts`
  shape (top‑level `await app.register`, `createTaskSyncStore`), not the branch's
  stale copy.

### Phase 5 — Reconcile types & status
- One `AgentStatus` in the shared location (server + client are now both
  consumers — the "second consumer" `engine/types.ts` was waiting for). Fold in
  the branch's richer states (`not_installed`, etc.); the server can detect them
  and §5 sanctions richer readiness.

### Phase 6 — Drop the superseded branch code
- `AgentSidebar.tsx`, the top‑level `useAgent.ts`, the `App.tsx` flex `.layout`
  and `.agent*` CSS, `packages/shared/src/validation/agent.ts`, and the SSE‑only
  `loop.ts` design.
- Optionally shelve the `<think>` splitter behind a `// planned: streaming` note
  — the one client artifact worth keeping for the later streaming UI.

### Phase 7 — Guardrails (all before PR)
- **Biome** format + lint every new file (CI enforces it — the most likely CI
  failure).
- `pnpm typecheck` across `apps/web`, `apps/server`, `packages/shared`.
- Add a `RemoteEngine` test mirroring `engine/LocalEngine.test.ts` and a
  server‑tool‑runner test; run the full Vitest suite.
- `pnpm tool-eval` against the Unsloth model; record the numbers as §7 did.
- Verify the round trip end‑to‑end: status pill → chat → tool call → task
  appears on the client via sync.

### Phase 8 — PR
- Open against `main` with small commits following Phases 1→7 so it reviews
  cleanly.

**Effort concentration:** Phases 3 (server tool runner) and 4 (RemoteEngine +
routes) are ~all the real work; 1, 5, 6 are mechanical; 2 shrank to near‑nothing
once Unsloth turned out to be OpenAI‑compatible.

---

## 4. Salvage ledger

| From `feat/ai-sidebar-unsloth` | Disposition |
|---|---|
| The idea: Unsloth as a stronger server‑side agent | **Keep** — becomes Tier 1 |
| `<think>` streaming splitter (`agent/loop.ts`) | **Shelve** for the streaming UI |
| Richer `AgentStatus` states | **Fold** into the shared status type |
| `unsloth connect claude` handshake (`agent/unsloth.ts`) | **Drop** — Studio has a plain key + `/v1/models` |
| `@anthropic-ai/sdk`, Anthropic message loop | **Drop** — off the OpenAI seam |
| `AgentSidebar.tsx`, top‑level `useAgent.ts`, `App.tsx` layout, sidebar CSS | **Drop** — superseded by the canvas module |
| `validation/agent.ts` in `@ghost/shared` | **Drop** — reconcile into the shared status type |

---

## 5. Open decisions

- **Engine selection** — env var (`VITE_ENGINE` / server config) vs. auto‑detect
  (prefer Unsloth when its `/v1/models` answers, else Tier‑0 llama‑server).
- **Studio credentials on the server** — env (`UNSLOTH_BASE_URL`,
  `UNSLOTH_API_KEY`, `UNSLOTH_MODEL`) is the v0 answer; revisit if the server
  ever manages multiple Studio instances.
- **Finetuning / benchmarking pipeline** — orthogonal to this seam; it
  co‑locates on the same GPU host and reuses `scripts/tool-eval.ts` + the shared
  contracts as its evaluation target. Tracked separately.
