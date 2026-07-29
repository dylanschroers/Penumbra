// Contract probe: drives the REAL StudioClient and UnslothEngine against a
// live Unsloth Studio, and reports which of our assumptions hold.
//
// Everything in the lab was built against Studio's documented API and tested
// with a fake that encodes the same reading — so a fake can only catch our
// bugs, never our misunderstandings. This is the only thing that catches those.
//
// Read-only: it lists, probes, and runs one chat turn. It starts no training.
// Everything that changes Studio's state is opt-in and off unless you ask for it
// by name — see the mutating section at the bottom.
//
// Two kinds of line. A ✅/❌ *check* asserts something the code already believes
// and fails the run when it doesn't hold. A · *note* asks a question the code has
// no answer for yet and prints what Studio said; notes never fail the run,
// because "there is no such endpoint" is an answer, not a regression.
//
// Usage: UNSLOTH_BASE_URL=… UNSLOTH_API_KEY=… pnpm exec tsx src/lab/probe.mts
//
// Opt-in, each mutating and each off by default:
//   PENUMBRA_PROBE_LOAD_CHECKPOINT=<dir>   does load-checkpoint reach /v1?
//   PENUMBRA_PROBE_LOAD_MODEL=<id|path>    does /api/inference/load reach /v1?
//   PENUMBRA_PROBE_DOWNLOAD_REPO=<repo>    start-then-cancel a hub download
//   PENUMBRA_PROBE_GGUF_REPO=<repo>        enumerate a repo's GGUF variants
//   PENUMBRA_PROBE_LOAD_VARIANT=<quant>    quant for the two above, e.g. Q4_K_M

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

// 10s suits a listing. A load is a different animal — paging a multi-GB GGUF
// into RAM and onto the GPU runs to minutes — and timing out on it would be
// actively misleading: the abort happens here while Studio carries on loading,
// so the probe would report a failure against a Studio that then works fine.
async function raw(
  path: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${studio.baseURL}${path}`, {
    ...init,
    headers: { ...authHeaders, ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
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
// Question 1 now has a candidate answer read off Studio's own source: inference
// mounts at /api/inference with load/unload/load-progress, and a separate hub
// router at /api/hub owns the inventory and an async download job API. That
// reading is what the section below exists to confirm *against this build* —
// the pip Studio and a source checkout are different trees, and committing a
// Penumbra route to a path this Studio does not serve would surface as a 404
// deep inside a handler rather than here.
//
// Everything here is read-only. The two probes that would change Studio — an
// actual load, and starting a download — live in the opt-in section at the end.

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

// ── The model-loading surface this build actually serves ────────────────────
//
// These paths come from Studio's own source: backend/main.py mounts inference at
// /api/inference and a separate hub router at /api/hub, and routes/inference.py
// plus hub/routes/inventory.py declare the rest. They are named one by one
// rather than matched by pattern because the whole point is to catch the one
// that is *missing here* — a filter over the route table reports what exists and
// stays silent about what doesn't.
//
// These stay notes even when a route is absent. Nothing in Penumbra calls them
// yet, so "no such endpoint" is a fact about this Studio rather than a broken
// assumption in our code — the same rule the header states.
const LOADING_ROUTES: [method: string, path: string, why: string][] = [
  ["POST", "/api/inference/load", "load a model for inference"],
  ["POST", "/api/inference/unload", "free the GPU without loading another"],
  ["GET", "/api/inference/load-progress", "mmap→ready, not a frozen spinner"],
  ["GET", "/api/hub/local", "inventory: disk, HF cache, LM Studio, Ollama"],
  ["GET", "/api/hub/gguf-variants", "which quants a repo offers"],
  ["POST", "/api/hub/download", "start a download job → 202 + job_key"],
  ["GET", "/api/hub/download-status", "idle|running|complete|error"],
  ["POST", "/api/hub/download/cancel", "scoped by generation"],
  ["GET", "/api/hub/active-downloads", "what is in flight right now"],
  ["GET", "/api/models/local", "pre-hub inventory; may be the only one here"],
];

console.log("");
for (const [method, path, why] of LOADING_ROUTES) {
  await observe(`${method} ${path}`, async () => {
    // The schema is authoritative and costs no requests, so prefer it.
    if (routeTable.length) {
      return routeTable.includes(`${method} ${path}`)
        ? `present — ${why}`
        : "ABSENT from the schema";
    }
    // Without a schema, a GET at a POST-only route is harmless and FastAPI's
    // status tells a real path with the wrong method apart from no path at all.
    const { status } = await raw(path);
    if (status === 404) return "404 — absent";
    if (status === 405) return `405 — present (POST-only) — ${why}`;
    if (status === 422) return `422 — present, wants args — ${why}`;
    return `${status} — present — ${why}`;
  });
}

// Existence is only half of it. The inventory is what a model picker in the app
// would render, so its *shape* decides whether the picker can be built: `load_id`
// is the string that goes back to load/train, and `model_format` decides which
// benchmark suites can run at all (fact 6 — only a GGUF answers /v1/completions),
// so a picker that hides it would let a user disqualify half the suites blind.
await observe("GET /api/hub/local (shape)", async () => {
  const { status, body } = await raw("/api/hub/local");
  if (status !== 200) return `HTTP ${status} — try /api/models/local instead`;
  const parsed = JSON.parse(body) as { models?: Record<string, unknown>[] };
  const rows = parsed.models ?? [];
  if (!rows.length) return "0 models — Studio sees nothing on this host";
  const want = ["id", "load_id", "display_name", "model_format", "runtime"];
  const first = rows[0] ?? {};
  const missing = want.filter((k) => !(k in first));
  const lines = rows
    .slice(0, 8)
    .map(
      (m) =>
        `      ${String(m.model_format ?? "?").padEnd(12)} ${String(m.runtime ?? "?").padEnd(10)} ${m.load_id ?? m.id}`,
    )
    .join("\n");
  return `${rows.length} model(s)${
    missing.length
      ? `; MISSING ${missing.join(",")}`
      : "; all picker fields present"
  }\n${lines}${rows.length > 8 ? `\n      … ${rows.length - 8} more` : ""}`;
});

// Idle shape. Worth seeing before building a progress bar on it: `phase` is null
// when nothing is loading, which is what the UI has to render most of the time.
await observe("GET /api/inference/load-progress", async () => {
  const { status, body } = await raw("/api/inference/load-progress");
  return status === 200 ? `200 — ${body.slice(0, 160)}` : `HTTP ${status}`;
});

await observe("GET /api/hub/active-downloads", async () => {
  const { status, body } = await raw("/api/hub/active-downloads");
  return status === 200 ? `200 — ${body.slice(0, 160)}` : `HTTP ${status}`;
});

// Read-only against Studio, but it reaches the HuggingFace API to enumerate a
// repo's quants, so it is named explicitly rather than run against a guess.
const ggufRepo = process.env.PENUMBRA_PROBE_GGUF_REPO;
if (ggufRepo) {
  await observe("GET /api/hub/gguf-variants", async () => {
    const { status, body } = await raw(
      `/api/hub/gguf-variants?repo_id=${encodeURIComponent(ggufRepo)}`,
    );
    return status === 200 ? `200 — ${body.slice(0, 300)}` : `HTTP ${status}`;
  });
} else {
  note("gguf-variants", "skipped — set PENUMBRA_PROBE_GGUF_REPO=<repo_id>");
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

// ── Opt-in, and the only things here that change Studio's state ─────────────
//
// Each is off unless named, because each can evict the model currently serving
// inference (fact 3 says training does; there is no reason to assume a load
// does not) or write bytes to the host's disk.

/** `/v1/models` flattened to one comparable string, for before/after. */
async function modelSignature(): Promise<string> {
  const { status, body } = await raw("/v1/models");
  if (status !== 200) return `(/v1/models answered ${status})`;
  return ((JSON.parse(body) as { data?: ModelEntry[] }).data ?? [])
    .map((m) => `${m.id}:${m.loaded}`)
    .sort()
    .join(" ");
}

/** Renders a before/after pair the same way for every mutating probe. */
const diff = (before: string, after: string): string =>
  before === after
    ? "no change to /v1/models"
    : `CHANGED\n      before: ${before || "(empty)"}\n      after:  ${after || "(empty)"}`;

// Question 2: whether /api/export/load-checkpoint also makes the checkpoint
// servable on /v1, or only feeds the export pipeline.
const checkpoint = process.env.PENUMBRA_PROBE_LOAD_CHECKPOINT;
if (checkpoint) {
  console.log(
    `\n⚠  MUTATING: loading ${checkpoint} — this may evict the loaded inference model.`,
  );
  await observe("load-checkpoint → /v1 effect", async () => {
    const before = await modelSignature();
    await studio.loadCheckpoint(checkpoint);
    const changed = diff(before, await modelSignature());
    return changed.startsWith("no change")
      ? "no change — export pipeline only; a merge step is needed to benchmark"
      : changed;
  });
} else {
  note(
    "load-checkpoint → /v1 effect",
    "skipped — set PENUMBRA_PROBE_LOAD_CHECKPOINT=<dir> (mutates Studio)",
  );
}

// Question 1, answered directly. If this moves /v1/models, then loading from
// Penumbra is a route away rather than a manual step in Studio's own UI, and
// the whole model-picker plan rests on it.
const loadModel = process.env.PENUMBRA_PROBE_LOAD_MODEL;
if (loadModel) {
  console.log(
    `\n⚠  MUTATING: loading ${loadModel} — this WILL evict whatever is resident.`,
  );
  await observe("inference/load → /v1 effect", async () => {
    const before = await modelSignature();
    const variant = process.env.PENUMBRA_PROBE_LOAD_VARIANT;
    const { status, body } = await raw(
      "/api/inference/load",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model_path: loadModel,
          // Required for a GGUF repo and meaningless otherwise, so it is sent
          // only when named — a wrong variant is a 4xx, not a silent fallback.
          ...(variant ? { gguf_variant: variant } : {}),
        }),
      },
      // Weights page in from disk before this answers; minutes is normal.
      10 * 60_000,
    );
    if (status !== 200) {
      return `HTTP ${status} — ${body.slice(0, 240)}`;
    }
    return `200 · ${diff(before, await modelSignature())}`;
  });
} else {
  note(
    "inference/load → /v1 effect",
    "skipped — set PENUMBRA_PROBE_LOAD_MODEL=<id|path> (evicts the model)",
  );
}

// The download job's *contract*, without pulling gigabytes: start it, read the
// 202, then cancel it scoped to the generation it just handed back. What matters
// is that the lifecycle is observable and interruptible — a picker that cannot
// cancel a 40 GB pull is not one anybody wants. A small repo may finish before
// the cancel lands; that is reported rather than treated as a failure.
const downloadRepo = process.env.PENUMBRA_PROBE_DOWNLOAD_REPO;
if (downloadRepo) {
  console.log(
    `\n⚠  MUTATING: starting a download of ${downloadRepo}, then cancelling it.`,
  );
  await observe("hub download lifecycle", async () => {
    const variant = process.env.PENUMBRA_PROBE_LOAD_VARIANT;
    const start = await raw("/api/hub/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo_id: downloadRepo,
        ...(variant ? { gguf_variant: variant } : {}),
      }),
    });
    if (start.status !== 202) {
      return `start answered ${start.status} (expected 202) — ${start.body.slice(0, 200)}`;
    }
    const job = JSON.parse(start.body) as {
      job_key?: string;
      generation?: number;
      accepted?: boolean;
      state?: string;
    };
    const cancel = await raw("/api/hub/download/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo_id: downloadRepo,
        ...(variant ? { gguf_variant: variant } : {}),
        ...(job.generation === undefined ? {} : { generation: job.generation }),
      }),
    });
    const after = await raw(
      `/api/hub/download-status?repo_id=${encodeURIComponent(downloadRepo)}&gguf_variant=${encodeURIComponent(variant ?? "")}`,
    );
    return [
      `202 accepted=${job.accepted} state=${job.state} generation=${job.generation}`,
      `      job_key: ${job.job_key ?? "(none)"}`,
      `      cancel:  HTTP ${cancel.status} ${cancel.body.slice(0, 120)}`,
      `      status:  HTTP ${after.status} ${after.body.slice(0, 120)}`,
    ].join("\n");
  });
} else {
  note(
    "hub download lifecycle",
    "skipped — set PENUMBRA_PROBE_DOWNLOAD_REPO=<repo_id> (writes to disk)",
  );
}

console.log("-".repeat(72));
console.log(
  failures === 0
    ? "All contract assumptions hold.\n"
    : `${failures} assumption(s) failed — see above.\n`,
);
process.exit(failures === 0 ? 0 : 1);
