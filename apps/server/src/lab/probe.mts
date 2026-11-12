// Drives the real StudioClient and UnslothEngine against a live Studio: the
// fakes can only catch our bugs, not our misreadings of Studio. Read-only
// unless an opt-in variable below is set. ✅/❌ checks fail the run; · notes
// only report.
//
// Usage: UNSLOTH_BASE_URL=… UNSLOTH_API_KEY=… pnpm exec tsx src/lab/probe.mts
//
// Opt-in, each mutating:
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

// Raw fetch for endpoints StudioClient lacks. No header without a key: Studio
// rejects an empty bearer.
const KEY = process.env.UNSLOTH_API_KEY;
const authHeaders: Record<string, string> = KEY
  ? { Authorization: `Bearer ${KEY}` }
  : {};

// Loads take minutes; timing out here would misreport a load Studio finishes.
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

// Tier 1 rests on this: Studio passes client-supplied tools through.
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

// Discovery: questions the code can't answer yet, checked against this Studio
// build (pip and source trees differ).
//   1. Which endpoint loads a model for inference (expected /api/inference)?
//   2. Does /api/export/load-checkpoint also serve the checkpoint on /v1?
//   3. Can a loaded GGUF be told apart from an unloaded one (fact 7)?

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
  // Fact 7: unloaded GGUFs are listed too.
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

// Studio is FastAPI, so its OpenAPI schema is authoritative when served.
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
  // FastAPI answers 405 for a real path with the wrong method, 404 for none.
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

// Named one by one so a missing route is reported. Notes, not checks: nothing
// in Penumbra calls these yet.
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
    if (routeTable.length) {
      return routeTable.includes(`${method} ${path}`)
        ? `present — ${why}`
        : "ABSENT from the schema";
    }
    const { status } = await raw(path);
    if (status === 404) return "404 — absent";
    if (status === 405) return `405 — present (POST-only) — ${why}`;
    if (status === 422) return `422 — present, wants args — ${why}`;
    return `${status} — present — ${why}`;
  });
}

// `load_id` is what goes back to load/train; `model_format` decides which
// suites can run (fact 6).
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

// `phase` is null when idle.
await observe("GET /api/inference/load-progress", async () => {
  const { status, body } = await raw("/api/inference/load-progress");
  return status === 200 ? `200 — ${body.slice(0, 160)}` : `HTTP ${status}`;
});

await observe("GET /api/hub/active-downloads", async () => {
  const { status, body } = await raw("/api/hub/active-downloads");
  return status === 200 ? `200 — ${body.slice(0, 160)}` : `HTTP ${status}`;
});

// Reaches the HuggingFace API, so opt-in.
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

// Fact 6: /v1/completions answers only with a GGUF loaded.
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

// Fact 6: chat rejects logprobs, hence generative-only general-v1.
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

// Opt-in mutating probes: each can evict the serving model or write to disk.

async function modelSignature(): Promise<string> {
  const { status, body } = await raw("/v1/models");
  if (status !== 200) return `(/v1/models answered ${status})`;
  return ((JSON.parse(body) as { data?: ModelEntry[] }).data ?? [])
    .map((m) => `${m.id}:${m.loaded}`)
    .sort()
    .join(" ");
}

const diff = (before: string, after: string): string =>
  before === after
    ? "no change to /v1/models"
    : `CHANGED\n      before: ${before || "(empty)"}\n      after:  ${after || "(empty)"}`;

// Question 2.
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

// Question 1.
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
          // Sent only when named: a wrong variant is a 4xx, not a fallback.
          ...(variant ? { gguf_variant: variant } : {}),
        }),
      },
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

// Start a download, then cancel it by the returned generation. A small repo
// may finish first; that's reported, not a failure.
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
