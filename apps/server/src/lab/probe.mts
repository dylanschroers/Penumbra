// Contract probe: drives the REAL StudioClient and UnslothEngine against a
// live Unsloth Studio, and reports which of our assumptions hold.
//
// Everything in the lab was built against Studio's documented API and tested
// with a fake that encodes the same reading — so a fake can only catch our
// bugs, never our misunderstandings. This is the only thing that catches those.
//
// Read-only: it lists, probes, and runs one chat turn. It starts no training.
//
// Usage: UNSLOTH_BASE_URL=… UNSLOTH_API_KEY=… pnpm exec tsx src/lab/probe.mts

import { AGENT_SYSTEM, taskTools, toToolSpec } from "@penumbra/shared";
import { UnslothEngine } from "./../agent/UnslothEngine";
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

console.log("-".repeat(72));
console.log(
  failures === 0
    ? "All contract assumptions hold.\n"
    : `${failures} assumption(s) failed — see above.\n`,
);
process.exit(failures === 0 ? 0 : 1);
