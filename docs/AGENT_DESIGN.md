# Ghost — Agent & AI Design

Companion to [ARCHITECTURE.md](ARCHITECTURE.md); this is the AI detail. Same
convention: present tense means it exists in the repo, and planned work is
marked as such.

The single organizing constraint: **Ghost has no hard dependency on any cloud
AI provider.** Local usability is the floor. A self-hosted server unlocks more;
cloud is an opt-in escalation the user chooses, never something the app
assumes.

---

## 1. The provider-neutral seam

The one thing every model backend has in common is a tiny config triple:

```
{ baseURL, model, apiKey? }  →  OpenAI-compatible client  →  caller
```

Ghost standardizes on the **OpenAI-compatible** chat API
(`/v1/chat/completions`) because it is the lingua franca of local inference —
llama.cpp's `llama-server`, Ollama, vLLM, and LM Studio all speak it natively —
and cloud providers sit behind it directly or through a thin adapter. Nothing
above the seam knows which backend answered.

```
Embedded llama-server (default)  ─┐
Self-hosted endpoint   (planned) ─┼─→ { baseURL, model } ─→ client ─→ agent / guidance
Opt-in cloud           (planned) ─┘
```

---

## 2. Capabilities, not model sizes

"Small model vs big model" is the wrong axis. Agentic work is a router sending
each request to the cheapest component that can do it:

| # | Capability | Best handled by | Status |
|---|---|---|---|
| 1 | **Route / classify** intent | rules or a tiny classifier — often no LLM | planned |
| 2 | **Retrieve / search / memory** | an embedding model + a local index | planned, next up |
| 3 | **Generate / converse / guide** | the embedded chat model | ✅ built |
| 4 | **Orchestrate tools** | single-step: embedded model; multi-step: a larger model | ✅ single-step built |
| 5 | **Proactive / background** | the larger model in an autonomous execution mode | planned (§8) |

The commonly-forgotten one is **#2**: the embedding model is a *different
artifact* from the chat model (vectors, not generation), it runs on CPU in
~100 MB (`bge-small` / `nomic-embed` class, over something like `sqlite-vec`),
and it is what makes a small on-device chat model genuinely useful — grounding
answers in the user's own data instead of raw parameter count.

---

## 3. Deployment tiers

All tiers sit behind the §1 seam.

- **Tier 0 — Embedded (built, the default).** The desktop app bundles
  **Qwen3-1.7B Q4** (Apache-2.0, matching the repo license — bundling
  redistributes the weights) and runs it via a `llama-server` sidecar with
  thinking off for latency (`--reasoning-budget 0`). Zero download, fully
  offline, private. Scope: guidance, Q&A, and single-step local tool calls
  against the task registry (§7).
- **Tier 1 — Self-hosted (planned).** The Ghost server runs a larger model
  (7–14B) for the full tool registry and multi-step agent work. Model size is
  a config knob, not a new tier.
- **Opt-in cloud (planned).** Point the same seam at Anthropic / OpenAI /
  OpenRouter. Maximum capability, entirely optional, and treated as **Plane B**
  — external, untrusted while offline.

## 4. Guidance vs. agent

Two roles with opposite needs, deliberately not the same model:

| | Guidance | Agent |
|---|---|---|
| Tier | 0 (embedded) | 1 (self-hosted) / cloud |
| Model | small | large |
| Tools | a few, single-step | full registry, multi-step |
| Availability | always, offline | when server / cloud is up |
| Trust | low blast radius | audited, permissioned |

A bundled small model is a good guide and a poor multi-step agent — §7
measures exactly where that line sits.

---

## 5. The engine abstraction

The UI must not know which backend or transport is behind a reply. It talks to
an **`Engine`** (`packages/shared/src/engine`), exposing only what the UI calls:

```ts
interface Engine {
  getStatus(): Promise<AgentStatus>;                     // status pill
  runAgent(messages, signal?): AsyncGenerator<AgentEvent>; // tool loop + answer
}
```

Two implementations exist, both thin configuration over the shared
**`OpenAiEngine`** — llama-server and Unsloth Studio speak the same
OpenAI-compatible protocol, so the loop is written once:

- **`LocalEngine`** (`apps/web/src/engine`) — Tier 0, the embedded model.
- **`UnslothEngine`** (`apps/server/src/agent`) — Tier 1, Studio on the GPU
  host, adding a bearer token and a longer tool-step budget. It has no route in
  front of it yet (see below).

The tool loop is bounded and non-streaming. Tools touch app state rather than
the engine, so `runTool` — with the tool specs and system prompt — is bound when
an engine is *constructed*: Tier 0 binds the browser store, Tier 1 binds the
server's. Readiness is `stopped | no_model | ready`
(`packages/shared/src/engine/types.ts`).

Planned, behind the same surface: a `RemoteEngine` transport adapter letting the
client reach `UnslothEngine` over `/agent/*` (arrives with the Tier-1 routes),
streaming with `<think>`-splitting (arrives with a streaming chat UI), and
richer readiness states for delivery modes that need download progress. Earlier speculative versions of these were built and then
removed (principle 6 in ARCHITECTURE.md); they live in git history.

---

## 6. Local model delivery

- **Desktop (built):** `llama-server`, its shared libraries, and the GGUF ship
  as Tauri `bundle.resources`; the Rust side spawns the sidecar at launch.
  Details and the `externalBin` pitfall: apps/desktop/SIDECAR.md. Honest cost:
  bundling spends Tauri's small-binary advantage — the installer grows by
  roughly the model size (~1.3 GB for the current Q4).
- **Web (planned):** no install step, so the browser build downloads the model
  once into OPFS and runs it in-browser (WebGPU where available, WASM
  fallback) behind the same `LocalEngine` interface.
- **Mobile (planned):** bundle in the app package and use a native inference
  module.

**Why native on desktop, not in-webview:** a native runtime reads the GGUF
directly and gets real GPU acceleration (Metal / CUDA / Vulkan). Tauri uses
the OS webview, where WebGPU support is uneven and worst on Linux/WebKitGTK —
the one place you cannot rely on it. Going native makes the floor "native CPU
everywhere"; in-webview inference stays a web-only concern.

---

## 7. Tool calling with a small model

Viable, with one technique doing most of the work, and a firm ceiling.

- **Constrained decoding is the game.** llama.cpp supports
  JSON-schema-constrained output, which forces the model to emit valid JSON
  matching a tool's argument schema — removing the #1 small-model failure
  (malformed calls). Tool contracts are defined once in Zod
  (`packages/shared/src/tools`) and derived to JSON Schema (`toToolSpec`), so
  the grammar, the runtime validation, and the eval all read the same source.
  One derivation caveat, handled in `toToolSpec`: llama.cpp expands bounded
  string repetitions into the grammar, so a large `maxLength` (>~1000) makes it
  reject the whole request — oversized bounds are stripped from the wire schema
  and enforced by Zod at the call boundary instead.
- **Keep it shallow and small.** A *few* well-described tools, single-step
  selection. Small models degrade fast with many tools or long multi-hop loops.
- **Honest ceiling:** a grammar-constrained small model is usable for local
  single-shot actions (Tier 0). It is *not* a reliable multi-step agent over
  finance/banking — that is Tier 1's larger model. With the no-cloud
  constraint, the ceiling is "run a bigger self-hosted model," not "call the
  cloud."

### Viability check — measured (✅ passed)

`scripts/tool-eval.ts` (`pnpm tool-eval`) ran 26 labeled utterances against the
bundled **Qwen3-1.7B Q4** (thinking off), using llama-server's
grammar-constrained `tools` API. The harness imports the shipped tool contracts
and system prompt from `@ghost/shared`, so it measures exactly the four tools
the app exposes (`create_task`, `list_tasks`, `complete_task`, `delete_task`):

| Metric | Result |
|---|---|
| Tool-selection accuracy | **24/26 (92%)** |
| False positives (tool called on chit-chat) | **0** |
| False negatives (missed a real action) | 1 |
| Argument JSON validity | 17/17 (100%) |
| Argument correctness (priority/status spot-checks) | 5/5 (100%) |
| Latency (CPU) | avg 3.8 s, max 9.9 s |

- **0 false positives** is the key safety property — it never fabricates an
  action during questions/greetings. It *under-calls* or mis-picks on idiomatic
  phrasings ("Tick off…", "Remove … from my list"), which is the safe direction.
- Argument extraction is good (priority/status parsed from natural language
  every time); JSON validity is guaranteed by the grammar.
- **Dates remain the weak spot** — `priority` was verified, but not whether
  `dueAt` resolves to the *correct* date. The runner coerces model dates with a
  deterministic parser and drops what it can't parse.
- Latency is CPU-bound; a Vulkan/CUDA build would cut it substantially.

Verdict: ship it, keep the tool set small, and re-measure as it grows.
`scripts/tool-eval.ts` is the regression check for model/prompt/tool changes —
it consumes the shared contracts, so a new tool is automatically part of what
it exercises (cases still need writing by hand).

---

## 8. Autonomous / background mode (planned)

Proactive agentics ("your budget is blown," scheduled jobs) run on the planned
Worker, with no user present to approve a tool mid-loop. This reuses Tier 1's
model but is a distinct *execution mode*: pre-authorized permission scopes
(anything outside them queues for approval), hard audit of every action, and
budget/rate limits so an unattended loop can't run away. Designed-for now —
the tool contracts' `permission` field is its hook — built later.

---

## 9. Decisions

Resolved:

- **Embedded model:** Qwen3-1.7B Q4, bundled. Revisit size only if the §7
  numbers degrade as tools grow.
- **Desktop runtime:** bundled `llama-server` binary (reuses the
  spawn-a-server pattern; no Rust inference crate needed).

Open:

- **Embedding model + local index** (`bge-small` / `nomic-embed`; `sqlite-vec`
  vs alternatives) — blocks capability #2.
- **Cloud adapters:** which providers to support behind the seam, if any,
  given cloud is strictly opt-in.

## 10. Sequencing

1. ✅ **Engine seam + embedded chat (Tier 0)** — `LocalEngine`, the agent
   canvas module, the bundled sidecar, and grammar-constrained task tools.
2. **Embeddings + retrieval** — bundle the embedding model + local index;
   ground guidance and add semantic search. (Next, because it is what makes
   Tier 0 genuinely useful.)
3. **Router** — promote the dispatch heuristic in front of the engines.
4. **Self-hosted agent (Tier 1)** — server-side multi-step loop against a
   larger model; `RemoteEngine` gets wired up here.
5. **Autonomous Worker mode** — proactive jobs with pre-authorized scopes and
   audit.

Web and mobile fall out of the same engine surface: `LocalEngine` gains a
WASM/WebGPU backing on web and a native module on mobile, with no UI or
wire-contract changes.
