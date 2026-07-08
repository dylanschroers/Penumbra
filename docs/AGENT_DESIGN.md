# Ghost — Agent & AI Design

> Draft. Companion to ARCHITECTURE.md. Where the two overlap, ARCHITECTURE.md is
> the summary and this is the detail.

## Purpose

Define how AI works in Ghost: what runs where, behind what interface, and with
what guarantees. The single organizing constraint drives every decision here:

**Ghost has no hard dependency on any cloud AI provider.** Local usability is the
floor. A self-hosted server unlocks more (tool calling, heavier reasoning, sync).
Cloud is an opt-in escalation the user chooses, never something the app assumes.

Everything below serves that constraint.

---

## 1. The provider-neutral seam

The one thing every model backend has in common is a tiny config triple:

```
{ baseURL, model, apiKey? }  →  OpenAI-compatible client  →  caller
```

We standardize on the **OpenAI-compatible** chat API (`/v1/chat/completions`)
because it is the lingua franca of local inference — llama.cpp's `llama-server`,
Ollama, vLLM, LM Studio, and LocalAI all speak it natively — and cloud providers
sit behind it directly or through a thin adapter. Nothing above the seam knows or
cares which backend answered.

```
Embedded llama-server (local, default) ─┐
Self-hosted endpoint                    ─┼─→ { baseURL, model } ─→ client ─→ agent / guidance
Opt-in cloud (Anthropic, OpenAI, …)     ─┘
```

> Migration note: an earlier `feat/ai-sidebar-unsloth` branch talked to a local
> Unsloth Studio via the Anthropic SDK — coupling the wire format to
> Anthropic-compat (the rare dialect) and depending on a separately installed
> Studio app. That approach is retired. The engine seam here (`packages/shared`
> inference module) is provider-neutral, `LocalEngine` speaks OpenAI-compatible
> directly to a bundled `llama-server`, and the `<think>` splitter is shared.

---

## 2. Capabilities, not model sizes

The instinct to think in "small model vs big model" is the wrong axis. Agentic
work is a **router** sending each request to the cheapest component that can do
it. There are five capability types, and only two of them are a chat LLM:

| # | Capability | Best handled by | Tier |
|---|---|---|---|
| 1 | **Route / classify** intent | tiny classifier, rules, or embedding similarity — often no LLM | 0 |
| 2 | **Retrieve / search / memory** | an embedding model + a local vector index | 0 |
| 3 | **Generate / converse / guide** | the embedded chat model | 0 |
| 4 | **Orchestrate tools, multi-step** | a larger chat model | 1 / cloud |
| 5 | **Proactive / background** | tier-1 model in an autonomous execution mode | Worker |

Two of these are commonly forgotten and are called out below: **#2 embeddings**
(a different artifact, not a smaller chat model) and **#5 autonomous mode** (a
different execution mode, not a different model).

### The router

Starts trivial — a keyword/heuristic switch that routes obvious intents locally
and everything else to the chat model. It can grow into a small classifier later.
It is not a model tier; it is the dispatcher in front of the tiers.

### Embeddings & retrieval (capability #2)

The embedding model is what makes a small on-device chat model *not* brain-dead:
it grounds answers in the user's own tasks/notes rather than relying on raw
parameters. It is:

- **A distinct artifact** from the chat model (vectors, not generation).
- **Cheap and fully local** — models like `bge-small` / `nomic-embed` /
  `all-MiniLM` run on CPU and bundle in ~100 MB, so they fit the no-cloud floor.
- **Backed by a lightweight local index** over the client SQLite (e.g.
  `sqlite-vec`), not a hosted vector DB.

Uses: semantic search over the user's data, and retrieval-augmented grounding for
the guidance model.

---

## 3. Deployment tiers

All tiers sit behind the §1 seam.

### Tier 0 — Embedded (default, always present)

- A small chat model **bundled with the app** (see §6 delivery). Zero download,
  fully offline, private.
- Plus the bundled embedding model (§2).
- Scope: guidance, Q&A, semantic search, and *light* local tool calls that do
  not need a server (e.g. `createTask`, `setReminder`) via constrained decoding.
- Model candidate: **Qwen3** family (Apache-2.0 — matches the repo license, which
  matters because bundling redistributes the weights). Small reasoning models
  earn their size here; the UI already renders a `<think>` disclosure.

### Tier 1 — Self-hosted server (optional)

- The user runs the Ghost server with a larger model (e.g. a 7–14B via
  `llama-server`). Model size is a **config knob**, not a new tier.
- Scope: the full tool registry, multi-step agent orchestration, and sync.

### Opt-in cloud

- The user may point the seam at Anthropic / OpenAI / OpenRouter / etc.
- Maximum capability, entirely optional. When enabled it is **Plane B**: external,
  untrusted while offline (ARCHITECTURE.md → two data planes).

---

## 4. Guidance vs. agent

Two roles with opposite needs, kept separate on purpose.

| | Guidance | Agent |
|---|---|---|
| Tier | 0 (embedded) | 1 (self-hosted) / cloud |
| Model | small | large |
| Tools | none, or a few local | full registry, multi-step |
| Availability | always, offline | when server / cloud is up |
| Trust | low blast radius | audited, permissioned |

One bundled small model is a good guide and a poor multi-step agent, so they are
deliberately not the same model. Conflating them is exactly what the retired
Unsloth path did.

---

## 5. The engine abstraction

The UI must not know which backend or transport is behind a reply. One interface:

```ts
interface InferenceEngine {
  getStatus(): EngineStatus;
  streamReply(messages: ChatMessage[]): AsyncGenerator<ReplyChunk>;
}
```

- `ChatMessage` is the shared wire type (`packages/shared`).
- `ReplyChunk` (`{ kind: "reasoning" | "answer"; text }`) and the
  `createThinkSplitter()` state machine live in `packages/shared`, so server and
  client use one copy. The splitter is pure string processing (parses
  `<think>…</think>` across streamed deltas) and has no server dependency.

Two implementations, same `ReplyChunk` stream:

- **LocalEngine** — the embedded model, in-process. On desktop/mobile it talks to
  the bundled `llama-server` over OpenAI-compatible HTTP (§6); on web it uses a
  WASM/WebGPU runtime. This is the default engine.
- **RemoteEngine** — the self-hosted or cloud backend over SSE, its hand-rolled
  SSE parser reduced to *just this engine's transport adapter* that turns SSE
  frames back into `ReplyChunk`s. SSE is a transport detail, not the interface.

Result: the agent module UI (and the "Thinking" disclosure) works unchanged
regardless of where inference runs.

### Status / readiness

The current Unsloth-specific states (`not_installed → stopped → no_model →
ready`) generalize to something honest for a bundled/native model, including one
the remote path never had — download/first-load progress:

```
unsupported | loading | ready | error        // embedded (bundled: usually straight to loading)
downloading(progress %) | …                  // web download-once case
```

---

## 6. Local model delivery

### Bundling (desktop & mobile)

The goal is **zero download after install**. Any platform with an install step can
bundle the model in its package:

- **Desktop (Tauri):** ship `llama-server` as an `externalBin` sidecar and the
  GGUF as a `bundle.resources` file. Tauri spawns the sidecar on launch;
  `LocalEngine` talks to its local OpenAI-compatible port. This reuses the
  "spawn a local model server, talk HTTP" shape the Unsloth code already had —
  relocated from the Node server into the desktop app, so guidance needs **no
  Ghost server and no network**.
- **Mobile:** bundle in the app package (or an on-demand asset pack, given store
  size limits) and use a native inference module.

Cost to be honest about: bundling spends Tauri's small-binary advantage — the
installer grows by roughly the model size (~0.5–1.1 GB for a Q4 small model).

### Web (no install step)

The web build cannot bundle. It **downloads the model once** and caches it in
OPFS, then runs it in the browser. Same `LocalEngine` interface, different
backing: WebGPU (WebLLM) where available, WASM (wllama) as the universal fallback.

### Why native on desktop, not in-webview

Once the model is a file on disk (bundled), a **native** runtime is the natural
fit: it reads the GGUF directly, gets real GPU acceleration (Metal / CUDA /
Vulkan), and avoids the **WebGPU-in-webview floor problem**. Tauri uses the OS
webview, and WebGPU support there is uneven and *worst on Linux/WebKitGTK* — the
one place you cannot rely on it. Going native sidesteps WebGPU entirely: the floor
becomes native CPU (works everywhere), with platform GPU as accel. In-webview
WASM/WebGPU is therefore a **web-only** concern.

---

## 7. Tool calling with a small model

Viable, with one technique doing most of the work, and a firm ceiling.

- **Constrained decoding is the game.** llama.cpp supports **GBNF grammars /
  JSON-schema-constrained output**, which forces the model to emit valid JSON
  matching a tool's argument schema. This removes the #1 small-model failure
  (malformed calls). Tool schemas are already Zod → JSON-schema, so they feed the
  grammar directly.
- **Keep it shallow and small.** A *few* well-described tools, single-step
  selection. Small models degrade fast with many tools or long multi-hop loops.
- **Best small tool-callers:** Qwen3 / Qwen2.5-3B-Instruct (explicitly trained for
  function calling; Apache-2.0). Reasoning mode helps tool selection.
- **Honest ceiling:** grammar-constrained 3–4B is usable for local single-shot
  actions (Tier 0). It is *not* a reliable multi-step agent over finance/banking
  — that is Tier 1's larger model. With the no-cloud constraint, the ceiling is
  "run a bigger self-hosted model," not "call the cloud."

**Viability check (do before committing):** wire 3–4 real Zod tools through
GBNF-constrained JSON on the bundled 3–4B model and measure tool-selection
accuracy and argument validity against the real registry. That sets the honest
Tier-0 action line.

---

## 8. Autonomous / background mode (capability #5)

Proactive agentics ("your budget is blown," "overnight email summary," scheduled
jobs) run on the **Worker**, with no user present to approve a tool mid-loop. This
reuses Tier 1's model but is a distinct *execution mode* with its own concerns:

- **Pre-authorized permission scopes** — tools the agent may call unattended are
  granted ahead of time; anything outside the scope queues for user approval.
- **Hard audit** — every autonomous action lands in the append-only audit log
  (already mandated for finance).
- **Budget / rate limits** — an unattended loop must not run away.

Designed-for now (so the permission model accounts for it), built later.

---

## 9. Open decisions

- **Embedded chat model + exact size** (0.6B vs 1.7B vs 3–4B) — trades footprint
  against the Tier-0 tool-calling ceiling (§7). Resolve via the viability check.
- **Embedding model + local index** choice (`bge-small` / `nomic-embed`;
  `sqlite-vec` vs alternative).
- **Native runtime on desktop:** bundled `llama-server` binary (simplest, reuses
  the spawn-a-server pattern) vs a Rust crate (`mistral.rs` / `candle`).
- **Cloud adapters:** which providers to support behind the seam at launch (if
  any), given cloud is strictly opt-in.

---

## 10. Sequencing

1. **Shared-seam refactor** — ✅ done. `ReplyChunk` + `createThinkSplitter` live
   in `packages/shared`; `InferenceEngine` defined; `RemoteEngine` wraps the SSE
   path.
2. **Embedded chat (Tier 0)** — *in progress.* `LocalEngine` (OpenAI-compatible)
   and the agent canvas module are done; still to do: bundle `llama-server` + a
   Qwen3 GGUF as a Tauri `externalBin` sidecar and pick the model.
3. **Embeddings + retrieval:** bundle the embedding model + local index; ground
   guidance and add semantic search. (Second because it is what makes Tier 0
   genuinely useful.)
4. **Router:** promote the dispatch heuristic in front of the engines.
5. **Self-hosted agent (Tier 1):** full tool registry + multi-step loop against a
   larger self-hosted model (the seat where a `RemoteEngine` backend is wired up).
6. **Autonomous Worker mode:** proactive jobs with pre-authorized scopes + audit.

Web and mobile fall out of the same `InferenceEngine` interface: `LocalEngine`
gains a WASM/WebGPU backing on web and a native module on mobile, with no UI or
wire-contract changes.
