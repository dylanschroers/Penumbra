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

Because the branch is **not** merged, none of its files ever land on `main`.
There is no "delete the superseded code" step — the sidebar, the top‑level
`useAgent.ts`, `validation/agent.ts`, and the Anthropic loop are simply never
ported. The salvage ledger (§5) is the complete account of what crosses over.

### Key finding — Unsloth is on the seam (verified against Studio's source)

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

**Confirmed by reading `studio/backend` in the Unsloth checkout** (rather than
taken on trust): `/v1/models` and `/v1/chat/completions` mount at
`main.py → app.include_router(inference_router, prefix="/v1")`, auth is
`HTTPBearer()` validating `sk-unsloth-…` keys, and `tools` / `tool_choice`
follow OpenAI semantics including forced‑function objects and `"none"`. Two
details that the OpenAI seam does *not* imply, and that cost correctness:

1. **`/v1/models` lists unloaded models too.** `_openai_catalog_objects()`
   returns loaded models *plus* every downloaded GGUF, distinguished only by a
   `loaded: true|false` flag. llama‑server, by contrast, omits the flag and
   lists only what is resident. Reading `data[0].id` — correct for Tier 0 —
   reports `ready` on Studio off a model sitting on disk, and the next
   completion then fails. `getStatus()` now prefers a `loaded: true` entry and
   falls back to `data[0]` only when no entry carries the flag.
2. **Never send `enable_tools` or `mcp_enabled`.** Those ask Studio to run *its
   own* tool loop against its MCP registry. Studio passes client‑supplied tools
   through only while both are absent (`_explicit_studio_tool_loop_requested`,
   and the `_sf_client_tools` gate). Setting either would silently take the turn
   away from Ghost's server‑side tools — a direct conflict with §2. A test pins
   their absence from the request body.

**Verified live against a real model.** Studio itself still has not answered —
the checkout has no Python stack installed and this machine's GPU is a 3 GB
Maxwell card — but the seam was exercised end to end against the bundled
`llama-server` + Qwen2.5‑1.5B GGUF, which speaks the identical protocol. Status
probe, tool call, tool result fed back, final answer, and the full Tier‑1 round
trip (`/agent/chat` → server‑side tool → rev‑stamped row → `/sync/tasks`) all
work. Two things that surfaced only by running it:

- `/v1/models` on llama‑server carries **no** `loaded` flag, confirming the
  fallback branch added for Studio's flagged catalog.
- The 1.5B model called `create_task` **twice** for one request, creating a
  duplicate task. The loop is correct; the model is weak. This is an argument
  for Tier 1, and it is invisible to a single‑turn eval (docs/EVAL.md §4).

---

## 2. Tool execution: server‑store (decision)

The model runs server‑side in all cases (GPU placement). The open question is
where a **tool** runs when the model emits a call.

- **Server‑store (chosen default).** The server binds the shared tool contracts
  to its own task store and executes in‑process; the sync engine converges
  effects to clients. The client is not in the turn loop.
- **Proxy‑to‑client (deferred).** The server bounces each tool call to the
  client, which runs it against the browser store and returns the result.

| Factor | Server‑store | Proxy |
|---|---|---|
| Autonomous / background mode (§8, no client present) | ✅ works | ❌ deadlocks — no client to run tools |
| Multi‑step latency (Tier‑1's purpose) | in‑process | one client round‑trip per step |
| Acts on user's exact on‑screen state | needs pre‑turn sync flush | ✅ inherently |
| Client‑only state (canvas/UI, "what am I looking at") | ❌ invisible | ✅ reachable |
| Audit / trust co‑location (§8) | ✅ server | split (client executes) |
| New code | server task store + tool runner | bidirectional transport + loop parking |

**Decision:** default **server‑store** for the current task tools — it is the
only model that supports the §8 autonomous roadmap, it is lowest‑latency for the
multi‑step work Tier 1 exists for, it co‑locates audit, and it reuses the sync
engine. Add **proxy** later, narrowly, only for genuinely client‑only tools,
gated so headless turns never depend on it.

### Convergence is two‑way, and both directions need a nudge

Server‑store means the turn reads and writes the *server's* database, while the
user is looking at the *client's*. Sync closes the gap in both directions, but
only on its 15s interval (`INTERVAL_MS`, `apps/web/src/sync/SyncClient.ts`), so
each direction needs an explicit prod:

- **Pre‑turn flush (client → server).** Before the turn starts, the client
  pushes pending edits and the server applies them, so the model reasons about
  what the user actually sees rather than up‑to‑15s‑stale state.
- **Post‑tool nudge (server → client).** After each tool event, the client
  pulls, so a created task appears immediately. Tier 0 gets this for free —
  `runTool` calls `notifyDataChanged()` (`apps/web/src/agent/tools.ts`) because
  it wrote to the local store. Tier 1 has no such local write, so `RemoteEngine`
  must call `requestSync()` on every tool event. **Without this the round trip
  looks broken** — the answer arrives and the task shows up fifteen seconds
  later.

---

## 3. The server has no task CRUD — this is the real work

The single largest under‑estimate to avoid. It is tempting to describe the
server tool runner as "the mirror of `apps/web/src/agent/tools.ts`, with the
contracts already shared." The contracts *are* shared, but the **store beneath
them is not**, and the two sides are not the same shape:

| | Client | Server |
|---|---|---|
| Surface | `DbApi` — `listTasks`/`createTask`/`updateTask`/`deleteTask` (`apps/web/src/db/api.ts`) | `TaskSyncStore` — `pull(since)` / `push(rows)` only (`apps/server/src/sync/store.ts`) |
| Driver | Drizzle | better‑sqlite3 direct |
| Validation | `createTaskInput` / `updateTaskInput` Zod parse | none — `push` trusts `SyncTask` rows |

`TaskSyncStore` is a *replication* interface, not a CRUD one. There is nothing
to bind the contracts to yet, so Phase 3 must build a server‑side task store
first. Four traps live in that build:

1. **The `rev` trap — silent data loss.** `pull` selects `WHERE rev > ?` and
   revs are assigned **only** inside `applyPush`. A tool that inserts a row
   directly leaves `rev` NULL, and that task is invisible to every client
   forever, with no error anywhere. Server writes **must** go through the
   rev‑stamping path. Assume this one will be hit if it is not designed for.
2. **`userId` has no server‑side source.** The client stamps
   `LOCAL_USER_ID = "local"` (`apps/web/src/db/api.ts`); the server has no user
   identity at all, and `tasks.user_id` is `NOT NULL`. The server store adopts
   the same constant, from a shared definition, until auth exists.
3. **`listTasks` is not `pull`.** `pull` returns rev‑ordered rows *including
   tombstones*. The `list_tasks` tool needs live rows only (`deleted_at IS
   NULL`) ordered by `created_at desc`, matching what the user sees.
4. **Validation must be reused, not re‑typed.** The server binds the same
   `createTaskInput` / `updateTaskInput` schemas from `@ghost/shared`, so
   defaults (e.g. `priority`) fill identically on both sides.

Budget Phase 3 accordingly: it is the project, not a mechanical mirror.

---

## 4. Major steps

### Phase 1 — Formalize the engine seam ✅ done
- Extract an `Engine` interface (`getStatus`, `runAgent`); make
  `LocalEngine implements Engine`.
- **Shape the interface for both implementations, not just the one that
  exists.** Today `runAgent(messages, opts, signal)` takes
  `opts = { tools, system, runTool }`. For `RemoteEngine` all three are
  server‑owned, so a client passing `toolSpecs` / `AGENT_SYSTEM` / `runTool`
  would hand over arguments the engine ignores — the shape that ages badly.
  Instead: **`runAgent(messages, signal)`**, with tools, system prompt, and
  `runTool` bound at **construction**. `LocalEngine`'s factory closes over the
  client bindings; `RemoteEngine` closes over nothing. This makes Phase 1 a
  slightly larger refactor and Phase 4 nearly free.
- `MAX_TOOL_STEPS` moves from a module constant to engine‑owned config for the
  same reason: 4 is a small‑model budget, and Tier 1 exists *for* multi‑step
  work.
- Point `modules/agent/useAgent.ts` at an `engine` chosen by a factory in
  `engine/index.ts` (default `local`). Behavior is unchanged; the call site and
  the interface shape are not. Its own commit.

### Phase 2 — Server‑side Unsloth engine (OpenAI seam) ✅ done
- **Absorbed Phase 5.** The engine types had to move to `@ghost/shared` first:
  `apps/server` cannot import from `apps/web`, and the server engine is exactly
  the second consumer the types were waiting for. `packages/shared/src/engine`
  now holds `Engine`, `AgentStatus`, `AgentEvent`, and `ToolBindings`.
- **Extracted `OpenAiEngine` rather than copying the loop.** Both tiers speak
  the same protocol, and after Phase 1 the only difference left was
  configuration — so the ~70 lines of tool‑call accumulation, malformed‑JSON
  handling, step budget, and `<think>` stripping live in `@ghost/shared` once.
  `LocalEngine` and `UnslothEngine` are thin config wrappers. The shared module
  is deliberately environment‑free (no `import.meta.env`, no `process.env`);
  each side's wrapper reads its own configuration and passes it in.
- `UnslothEngine` (`apps/server/src/agent`) adds `UNSLOTH_BASE_URL` /
  `UNSLOTH_API_KEY` / `UNSLOTH_MODEL`, a conditional `Authorization: Bearer`
  (Studio on a trusted LAN may run keyless, and an empty bearer is rejected as
  malformed), and a tool‑step budget of 8 against Tier 0's 4.
- Dropped, as planned: `@anthropic-ai/sdk`, the `unsloth connect claude`
  handshake, all tool translation. Status is a plain `/v1/models` probe.
- `packages/shared` gained the `DOM` lib for the standard
  `fetch`/`Response`/`AbortSignal` family, and `apps/server` gained Vitest —
  which Phase 3's store tests need anyway.

**Not yet exercised against a live Studio.** `UnslothEngine` is unit‑tested
(config resolution, headers, step budget), the protocol is covered by the shared
`OpenAiEngine` tests, and an integration test drives a real turn over HTTP
against a fake Studio — which catches our bugs but cannot validate our reading
of Studio, since the fake encodes the same assumptions. The wire contract was
instead checked against Studio's source (§1), which is what surfaced the
`loaded`‑flag bug. First live run happens in Phase 3, when it has tools to call.

### Phase 3 — Server task store + tool runner ✅ done
- Build the server‑side task store described in §3, routing every write through
  rev stamping and reusing the shared Zod schemas.
- Bind the shared contracts (`createTaskTool`, `listTasksTool`, …) to it,
  mirroring the *structure* of `apps/web/src/agent/tools.ts` — same
  `bind`/registry/`safeParse` discipline, different backing store.
- Add the pre‑turn sync flush (§2).
- Tests: rev assignment (a tool‑created task is pullable by a client at
  `since = 0`), tombstone filtering, and schema‑default parity with the client.

### Phase 4 — Client `RemoteEngine`, routes, and auth ✅ done
- `RemoteEngine implements Engine` forwards `runAgent` / `getStatus` to the
  server's `/agent/*` (SSE), and calls `requestSync()` on each tool event (§2).
  The existing `AgentModule` + `useAgent` render it unchanged.
- Wire `/agent/chat` and `/agent/status` into `main`'s current
  `apps/server/src/main.ts` shape (top‑level `await app.register`,
  `createTaskSyncStore`), not the branch's stale copy.
- **Auth — new requirement, not inherited.** The server today has no auth and
  reflects any origin (`main.ts`; deliberate for v0 per docs/SYNC.md). That
  posture is defensible for sync endpoints, which move task data. `/agent/chat`
  is a different class of exposure: an unauthenticated endpoint on `0.0.0.0`
  that runs a model with **write and delete** tools against the store and
  consumes GPU. Minimum bar before this endpoint exists: a shared‑secret header
  (`GHOST_AGENT_TOKEN`) **or** binding the agent routes to localhost, plus a
  note in docs/SYNC.md that the v0 no‑auth stance now has an actuator behind it.
- **Abort semantics.** `useAgent` aborts via `AbortController`; over SSE, client
  disconnect must cancel the server's in‑flight model call and stop the tool
  loop. Tools mutate, so state the rule explicitly: **partial effects stand** —
  an aborted turn leaves already‑executed tool writes in place rather than
  attempting rollback, and the tool events already streamed tell the user what
  happened.

### Phase 5 — Engine selection ✅ done (states deferred)
- The type move happened in Phase 2, which needed it. Selection is now
  `ResolvingEngine`: probe candidates in preference order, take the first that
  reports ready. That is what makes the server a *preferred* backend and the
  embedded model a working fallback, rather than a build‑time choice that is
  wrong whenever reality disagrees.
- **Deferred:** the branch's richer readiness states (`not_installed`, download
  progress). Nothing detects them yet, and inventing states no producer emits
  would be speculative.

### Phase 6 — Guardrails (all before PR)
- **Biome** format + lint every new file (CI enforces it — the most likely CI
  failure).
- `pnpm typecheck` across `apps/web`, `apps/server`, `packages/shared`.
- Add a `RemoteEngine` test mirroring `engine/LocalEngine.test.ts`, plus the
  Phase 3 store tests; run the full Vitest suite.
- `pnpm tool-eval` against the Unsloth model; record the numbers as §7 did.
- Verify the round trip end‑to‑end: status pill → chat → tool call → task
  appears on the client via sync **without waiting for the 15s interval**.

### Phase 7 — PR
- Open against `main` with small commits following Phases 1→6 so it reviews
  cleanly.

**Effort concentration, in hindsight:** Phase 3 was the project, as predicted —
the server had no CRUD at all, and the `rev` trap was real. Phase 4 was bounded
but larger than "transport" suggests once auth and abort were taken seriously.
Phases 1, 2, and 5 were mechanical. The original estimate's one bad call was
describing Phase 3 as a mirror of the client tools; it was closer to 4x that.

---

## 5. Salvage ledger

| From `feat/ai-sidebar-unsloth` | Disposition |
|---|---|
| The idea: Unsloth as a stronger server‑side agent | **Keep** — becomes Tier 1 |
| `<think>` streaming splitter (`agent/loop.ts`) | **Port**, shelved behind a `// planned: streaming` note — the one client artifact worth carrying over |
| Richer `AgentStatus` states | **Fold** into the shared status type (Phase 5) |
| `unsloth connect claude` handshake (`agent/unsloth.ts`) | **Drop** — Studio has a plain key + `/v1/models` |
| `@anthropic-ai/sdk`, Anthropic message loop | **Drop** — off the OpenAI seam |
| `AgentSidebar.tsx`, top‑level `useAgent.ts`, `App.tsx` layout, sidebar CSS | **Drop** — superseded by the canvas module |
| `validation/agent.ts` in `@ghost/shared` | **Drop** — reconcile into the shared status type |

"Drop" means *never ported* — see §1. Nothing needs deleting from `main`.

---

## 6. Open decisions

- ~~**Engine selection**~~ — settled in Phase 1: env var (`VITE_ENGINE`,
  default `local`), chosen for low commitment. Auto‑detect (prefer Unsloth when
  its `/v1/models` answers, else Tier‑0 llama‑server) stays open as a later
  refinement; it is contained to the factory in `apps/web/src/engine/index.ts`.
- **Studio credentials on the server** — env (`UNSLOTH_BASE_URL`,
  `UNSLOTH_API_KEY`, `UNSLOTH_MODEL`) is the v0 answer; revisit if the server
  ever manages multiple Studio instances.
- **Agent‑route auth** — shared secret vs. localhost bind (Phase 4). Either
  clears the v0 bar; the choice depends on whether Tier 1 is meant to serve
  other devices on the LAN, which is also what §8's autonomous mode will need.
- ~~**Finetuning / benchmarking pipeline**~~ — scaffolded; see
  [EVAL.md](EVAL.md). Cases, scoring, and training‑set generation moved into
  `@ghost/shared` beside the contracts, runs append to `bench/results.jsonl`,
  and each run emits a rejection‑sampled `trainset.jsonl` plus the worklist of
  cases it could not label. The training loop itself (running Unsloth SFT on
  that file) is still out of scope here.
</content>
</invoke>
