// Contract probe: drives the REAL StudioClient and UnslothEngine against a
// live Unsloth Studio, and reports which of our assumptions hold.
//
// Everything in the lab was built against Studio's documented API and tested
// with a fake that encodes the same reading — so a fake can only catch our
// bugs, never our misunderstandings. This is the only thing that catches those.
//
// Read-only: it lists, probes, and runs one chat turn. It starts no training.
// The one exception is opt-in and off unless you ask for it by name — see
// "load-checkpoint" at the bottom.
//
// Two kinds of line. A ✅/❌ *check* asserts something the code already believes
// and fails the run when it doesn't hold. A · *note* asks a question the code has
// no answer for yet and prints what Studio said; notes never fail the run,
// because "there is no such endpoint" is an answer, not a regression.
//
// Usage: UNSLOTH_BASE_URL=… UNSLOTH_API_KEY=… pnpm exec tsx src/lab/probe.mts

import { AGENT_SYSTEM, taskTools, toToolSpec } from "@penumbra/shared";
import { UnslothEngine } from "../agent/UnslothEngine";
import { StudioClient } from "./studio";

const studio = new StudioClient();
let failures = 0;

function report(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${name.padEnd(34)} ${detail}`);
}

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    report(name, true, await fn());
  } catch (err) {
    report(name, false, err instanceof Error ? err.message : String(err));
  }
}

/** An observation, not an assertion. Never counts as a failure. */
function note(name: string, detail: string): void {
  console.log(`·  ${name.padEnd(34)} ${detail}`);
}

async function observe(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    note(name, await fn());
  } catch (err) {
    note(name, `— ${err instanceof Error ? err.message : String(err)}`);
  }
}

// The discovery probes below reach endpoints StudioClient has no method for —
// that is precisely what makes them worth probing — so they use fetch directly.
// The header rule is copied rather than shared for the same reason the client
// states it: an empty bearer is rejected as malformed, so the header is omitted
// entirely when there is no key.
const KEY = process.env.UNSLOTH_API_KEY;
const authHeaders: Record<string, string> = KEY
  ? { Authorization: `Bearer ${KEY}` }
  : {};

async function raw(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${studio.baseURL}${path}`, {
    ...init,
    headers: { ...authHeaders, ...init.headers },
    signal: AbortSignal.timeout(10_000),
  });
  return {
    status: res.status,
    body: (await res.text().catch(() => "")).trim(),
  };
}

console.log(`\nProbing ${studio.baseURL}\n${"-".repeat(72)}`);

await check("studio reachable", async () =>
  (await studio.reachable())
    ? "answers /v1/models"
    : Promise.reject(new Error("no answer")),
);

// getStatus is what the status pill and the engine resolver both key on.
await check("engine getStatus", async () => {
  const engine = new UnslothEngine({
    bindings: { tools: [], system: "", runTool: async () => "" },
  });
  const status = await engine.getStatus();
  if (status.state !== "ready") {
    throw new Error(`state=${status.state} (load a model in Studio)`);
  }
  return `ready · ${status.model}`;
});

// The assumption the whole Tier-1 design rests on: Studio speaks OpenAI tool
// calling, and client-supplied tools pass through untouched.
await check("tool calling over /v1", async () => {
  const calls: string[] = [];
  const engine = new UnslothEngine({
    bindings: {
      tools: taskTools.map(toToolSpec),
      system: AGENT_SYSTEM,
      runTool: async (name) => {
        calls.push(name);
        return 'Created task "buy milk".';
      },
    },
    model: process.env.UNSLOTH_MODEL,
  });

  const events = [];
  for await (const ev of engine.runAgent([
    { role: "user", content: "add a task to buy milk" },
  ])) {
    events.push(ev);
  }
  if (!calls.length) {
    throw new Error(`no tool call; model answered: ${JSON.stringify(events)}`);
  }
  return `called ${calls.join(", ")} → ${events.length} events`;
});

// Shapes the Model Lab consumes. These are read-only and safe to call even
// when nothing has ever been trained.
await check("GET /api/train/runs", async () => {
  const runs = await studio.listRuns();
  return `${runs.length} run(s); keys: ${
    runs[0] ? Object.keys(runs[0]).slice(0, 6).join(",") : "—"
  }`;
});

await check("GET /api/export/status", async () => {
  const status = await studio.exportStatus();
  return `keys: ${Object.keys(status).join(",") || "(empty)"}`;
});

// ──────────────────────────────────────────────────────────────── discovery ──
//
// Benchmarking two models and comparing them needs an answer to three questions
// the code cannot currently answer, because nothing in it ever changes which
// model Studio serves:
//
//   1. Is there an endpoint that loads a model *for inference*? Today a
//      benchmark posts a model id to /v1/chat/completions and hopes Studio is
//      already serving it — swapping models is a manual step in Studio's own UI.
//   2. Does /api/export/load-checkpoint affect /v1, or only the export pipeline?
//      If it serves the checkpoint too, a base+adapter run is benchmarkable
//      without a merge step.
//   3. What model id does a loaded GGUF report, and can it be told apart from an
//      unloaded one? Fact 7 says /v1/models lists both.
//
// Everything here is read-only.

console.log(
  `${"-".repeat(72)}\nDiscovery — questions the code has no answer for\n`,
);

interface ModelEntry {
  id?: string;
  loaded?: boolean;
  [k: string]: unknown;
}

let models: ModelEntry[] = [];

await observe("GET /v1/models (full shape)", async () => {
  const { status, body } = await raw("/v1/models");
  if (status !== 200) return `HTTP ${status}`;
  models = (JSON.parse(body) as { data?: ModelEntry[] }).data ?? [];
  if (!models.length) return "no entries — nothing loaded or downloaded";
  // The `loaded` flag is the whole point: fact 7 says an unloaded GGUF sitting
  // on disk is listed too, and reading data[0].id reports ready off a model the
  // next completion will fail on.
  const flagged = models.filter((m) => m.loaded !== undefined).length;
  const lines = models
    .map(
      (m) =>
        `      ${m.loaded === true ? "●" : m.loaded === false ? "○" : "?"} ${m.id ?? "(no id)"}`,
    )
    .join("\n");
  return `${models.length} entr(ies), ${flagged} carry \`loaded\`; keys: ${Object.keys(
    models[0] ?? {},
  ).join(",")}\n${lines}`;
});

const loadedModel = models.find((m) => m.loaded === true) ?? models[0];
const loadedId = loadedModel?.id;

// Studio's backend is FastAPI (routers, 422-with-detail, the doubled
// /api/export/export/gguf segment), so the generated schema should be served and
// is authoritative — far better than guessing at route names.
let routeTable: string[] = [];

await observe("GET /openapi.json", async () => {
  const { status, body } = await raw("/openapi.json");
  if (status !== 200)
    return `HTTP ${status} — no schema, falling back to guesses`;
  const paths = (JSON.parse(body) as { paths?: Record<string, object> }).paths;
  if (!paths) return "schema has no `paths`";
  routeTable = Object.entries(paths).flatMap(([p, ops]) =>
    Object.keys(ops).map((method) => `${method.toUpperCase()} ${p}`),
  );
  return `${routeTable.length} routes`;
});

if (routeTable.length) {
  note(
    "routes touching model loading",
    `\n${
      routeTable
        .filter((r) => /load|serve|unload|infer|\/models?\b/i.test(r))
        .map((r) => `      ${r}`)
        .join("\n") || "      (none — loading really is out-of-band)"
    }`,
  );
} else {
  // Fallback when the schema isn't served. A GET against a POST-only route is
  // harmless and tells us the route exists: FastAPI answers 405 for a matched
  // path with the wrong method, 404 for no such path.
  const candidates = [
    "/api/models/load",
    "/api/model/load",
    "/api/inference/load",
    "/api/inference/load-model",
    "/api/inference/status",
    "/api/models",
  ];
  for (const path of candidates) {
    await observe(`GET ${path}`, async () => {
      const { status } = await raw(path);
      if (status === 404) return "404 — absent";
      if (status === 405) return "405 — EXISTS, wrong method (try POST)";
      if (status === 422) return "422 — EXISTS, wants a body";
      return `${status}`;
    });
  }
}

// Fact 6, re-checked because the whole multiple-choice suite plan turns on it:
// /v1/completions is a passthrough to llama-server and answers only with a GGUF
// loaded. So this doubles as "is the currently loaded model a GGUF?" — which is
// the runtime test for whether loglikelihood tasks can run at all.
await observe("POST /v1/completions", async () => {
  const { status, body } = await raw("/v1/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: loadedId ?? "unsloth",
      prompt: "1 + 1 =",
      max_tokens: 1,
      temperature: 0,
    }),
  });
  if (status === 200)
    return "200 — a GGUF is loaded; loglikelihood suites viable";
  return `HTTP ${status} — not a GGUF (or no passthrough): ${body.slice(0, 160)}`;
});

// The other half of fact 6: the chat endpoint works for any loaded model but
// rejects logprobs, which is why general-v1 is generative-only.
await observe("chat/completions + logprobs", async () => {
  const { status, body } = await raw("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: loadedId ?? "unsloth",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      temperature: 0,
      logprobs: true,
      top_logprobs: 1,
    }),
  });
  if (status === 200) {
    return "200 — logprobs ACCEPTED (fact 6 is stale; MC tasks may run on chat)";
  }
  return `HTTP ${status} — rejected as documented: ${body.slice(0, 160)}`;
});

// ── Opt-in, and the only thing here that changes Studio's state ──────────────
//
// Loading a checkpoint may evict the model currently serving inference (fact 3
// says training does; there is no reason to assume this does not), so it runs
// only when you name a checkpoint explicitly. It answers question 2: whether
// /api/export/load-checkpoint also makes the checkpoint servable on /v1, or
// only feeds the export pipeline.
const checkpoint = process.env.PENUMBRA_PROBE_LOAD_CHECKPOINT;
if (checkpoint) {
  console.log(
    `\n⚠  MUTATING: loading ${checkpoint} — this may evict the loaded inference model.`,
  );
  await observe("load-checkpoint → /v1 effect", async () => {
    const before = models
      .map((m) => `${m.id}:${m.loaded}`)
      .sort()
      .join(" ");
    await studio.loadCheckpoint(checkpoint);
    const { status, body } = await raw("/v1/models");
    if (status !== 200) return `/v1/models answered ${status} afterwards`;
    const after = ((JSON.parse(body) as { data?: ModelEntry[] }).data ?? [])
      .map((m) => `${m.id}:${m.loaded}`)
      .sort()
      .join(" ");
    return before === after
      ? "no change — export pipeline only; a merge step is needed to benchmark"
      : `CHANGED\n      before: ${before || "(empty)"}\n      after:  ${after || "(empty)"}`;
  });
} else {
  note(
    "load-checkpoint → /v1 effect",
    "skipped — set PENUMBRA_PROBE_LOAD_CHECKPOINT=<dir> (mutates Studio)",
  );
}

console.log("-".repeat(72));
console.log(
  failures === 0
    ? "All contract assumptions hold.\n"
    : `${failures} assumption(s) failed — see above.\n`,
);
process.exit(failures === 0 ? 0 : 1);
