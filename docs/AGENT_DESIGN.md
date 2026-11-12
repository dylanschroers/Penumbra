# Penumbra: Agent & AI design

Present tense means it exists in the repo. The constraint: **no hard dependency
on any cloud AI provider.** The local model is the floor; everything else is
optional.

Every backend speaks the OpenAI-compatible chat API (`/v1/chat/completions`) and
is configured by `{ baseURL, model, apiKey? }`. No vendor SDKs, no LangChain.

## Deployment tiers

- **Tier 0, embedded (default).** The desktop app bundles Qwen3-1.7B Q4_K_M
  (Apache-2.0, so it can be redistributed) and runs it in a `llama-server`
  sidecar with thinking off. Offline. Binds `agentTools` with a 4-step budget,
  but is only reliable on single-step requests.
- **Tier 1, server.** The server runs the tool loop with `agentTools` plus
  `labTools`, 8-step budget. Chat goes to a model gateway when
  `PENUMBRA_GATEWAY_URL` and `PENUMBRA_GATEWAY_MODEL` are set, else to the
  Studio target assigned to chat. With both, `ResolvingEngine` takes the first
  that reports ready at the start of each turn, so Studio is the fallback.
- **Cloud (planned).** Listed in the provider selector but disabled.

The user picks **Local**, **Server**, or **Cloud** in the chat header.
`engine/index.ts` holds a `SwitchableEngine` that delegates to the selection and
persists it to `localStorage`.

## The engine abstraction

The UI talks to an `Engine` (`packages/shared/src/engine`):

```ts
interface Engine {
  getStatus(): Promise<AgentStatus>;
  runAgent(messages, signal?): AsyncGenerator<AgentEvent>;
}
```

Readiness is `stopped | unauthorized | no_model | ready`.

- **`OpenAiEngine`** (shared) holds the tool loop. It is bounded and
  non-streaming.
- **`LocalEngine`** (`apps/web/src/engine`): Tier 0, bound to the browser store.
- **`UnslothEngine`** and **`GatewayEngine`** (`apps/server/src/agent`): Tier 1,
  bound to the server store, with a bearer header.
- **`RemoteEngine`** (`apps/web/src/engine`): the transport to `/agent/*` over
  SSE. It flushes sync before a turn and requests sync after every tool event
  ([SYNC.md](SYNC.md) → Server-side writes).

Tool bindings (specs, system prompt, `runTool`) are injected when an engine is
constructed.

**Tools run beside the model.** Tier 1 executes tools server-side against the
server's store, so no client is in the turn loop. Bouncing calls to a client
would deadlock with no client present, which is exactly autonomous mode.

The exception is the file tools, which need the machine holding the sidebar's
folders. The client offers them per turn (`ClientTools` on `runAgent`). A local
engine runs them in place; the server advertises them for that turn only,
sends each call back as a `client_tool` event, and resumes when the client
posts the result to `/agent/tool-result`. A turn with no client has no file
tools.

**Abort**: a client disconnect cancels the in-flight model call and stops the
loop, but writes already made stand. There is no rollback.

### Unsloth is on the seam

Studio serves `/v1/chat/completions` and `/v1/models` with OpenAI tool
semantics, so `UnslothEngine` is the same request plus a bearer. Two things the
seam does not imply are in [MODEL_LAB.md](MODEL_LAB.md) → What Studio
guarantees: `/v1/models` lists unloaded models, and `enable_tools` /
`mcp_enabled` must never be sent.

## Local model delivery

- **Desktop:** `llama-server`, its libraries, and the GGUF ship as Tauri
  resources and run natively ([SIDECAR.md](../apps/desktop/SIDECAR.md)). Native,
  not in-webview, because webview WebGPU is unreliable, worst on WebKitGTK.
- **Web and mobile (planned):** download into OPFS and run on WebGPU/WASM, or a
  native module, behind the same `LocalEngine`.

## Tool calling with a small model

- **Constrained decoding does the work.** llama.cpp constrains output to each
  tool's JSON Schema, which removes malformed calls. Caveat handled in
  `toToolSpec`: a large `maxLength` makes llama.cpp reject the request, so
  oversized bounds are stripped from the wire schema and enforced by Zod.
- **Keep tools few and shallow.** Small models degrade as tools are added, and
  the cost lands on tools that already worked. Measure before growing the set
  ([EVAL.md](EVAL.md)).
- **Dates are the weak spot.** Runners coerce model dates with a deterministic
  parser and drop what they cannot parse.
- **Ceiling:** reliable for single-shot local actions, not multi-step work.
  That is Tier 1's job.

First measured run (Qwen3-1.7B Q4, four task tools, CPU): 92% selection, 0 false
positives, 100% valid arguments, 3.8s average latency.

## Autonomous mode (planned)

Scheduled and proactive jobs on a background worker, reusing Tier 1 with
pre-authorized permission scopes, an audit of every action, and rate limits. The
contracts' `permission` field is the hook.

## Next

1. Embeddings + local index (`bge-small` / `nomic-embed` over something like
   `sqlite-vec`) to ground Tier 0 in the user's data.
2. A router that picks the provider automatically.
3. Autonomous mode.
