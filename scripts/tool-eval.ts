// Tool-calling regression check (docs/AGENT_DESIGN.md §7). Measures whether a
// model turns a natural request into the RIGHT tool call with the RIGHT args.
// It does not execute tools — it only checks what the model emits.
//
// The cases, scoring, and training-set logic all live in @ghost/shared, so this
// script is just IO: ask the model, score, print, record. That keeps the eval
// from drifting from the product (it imports the same specs and prompt the app
// ships) and keeps the metrics unit-tested.
//
// Usage: pnpm tool-eval                (needs an OpenAI-compatible server)
//   LLM_URL=http://127.0.0.1:8080      llama-server (Tier 0) or Studio (Tier 1)
//   MODEL=qwen3-1.7b
//   API_KEY=sk-unsloth-…               when the server wants one
//   LABEL=baseline                     names the run in the benchmark log
//   BENCH_DIR=bench                    where results and trainsets are written

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_SYSTEM,
  type CaseOutcome,
  evalCases,
  scoreCase,
  summarize,
  taskTools,
  toJsonl,
  toRecord,
  toToolSpec,
  toTrainingExamples,
} from "@ghost/shared";

// Named BASE_URL so it doesn't shadow the global URL constructor.
const BASE_URL = process.env.LLM_URL ?? "http://127.0.0.1:8080";
const MODEL = process.env.MODEL ?? "qwen3-1.7b";
const API_KEY = process.env.API_KEY;
const LABEL = process.env.LABEL;
const BENCH_DIR = process.env.BENCH_DIR ?? "bench";

const tools = taskTools.map(toToolSpec);

async function ask(text: string): Promise<CaseOutcome> {
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: AGENT_SYSTEM },
        { role: "user", content: text },
      ],
      tools,
      tool_choice: "auto",
      max_tokens: 256,
      temperature: 0,
    }),
  });
  // Fail loudly: a non-OK response (e.g. a schema the server's grammar builder
  // rejects) must not be scored as "the model declined to call a tool".
  if (!res.ok) {
    throw new Error(
      `model server responded ${res.status}: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };
  const message = body.choices?.[0]?.message;
  const call = message?.tool_calls?.[0]?.function;

  let args: Record<string, unknown> | null = null;
  let argsValid = true;
  if (call) {
    try {
      args = JSON.parse(call.arguments ?? "{}") as Record<string, unknown>;
    } catch {
      argsValid = false;
    }
  }
  return {
    name: call?.name ?? null,
    args,
    argsValid,
    // Strip <think> so a refusal's gold text isn't polluted with reasoning.
    content: (message?.content ?? "")
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .trim(),
    ms: Date.now() - t0,
  };
}

function pad(value: unknown, n: number): string {
  const s = String(value);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

const R = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
};

const main = async (): Promise<void> => {
  console.log(
    pad("utterance", 46),
    pad("expected", 14),
    pad("got", 14),
    "result",
  );
  console.log("-".repeat(84));

  const scored = [];
  for (const c of evalCases) {
    const s = scoreCase(c, await ask(c.text));
    scored.push(s);

    const argMark =
      s.argsOk === null
        ? ""
        : s.argsOk
          ? " args✓"
          : ` args✗(${JSON.stringify(s.outcome.args)})`;
    const color = s.selectionOk ? R.green : R.red;
    console.log(
      pad(c.text, 46),
      pad(c.tool ?? "(none)", 14),
      pad(s.outcome.name ?? "(none)", 14),
      `${color}${s.selectionOk ? "PASS" : "FAIL"}${R.reset}${R.dim}${argMark} ${s.outcome.ms}ms${R.reset}`,
    );
  }

  const summary = summarize(scored);
  const pct = (n: number) => ((n / summary.total) * 100).toFixed(0);
  console.log("-".repeat(84));
  console.log(
    `Tool-selection accuracy : ${summary.selection}/${summary.total} (${pct(summary.selection)}%)`,
  );
  console.log(
    `False positives (called on chit-chat): ${summary.falsePositives}`,
  );
  console.log(
    `False negatives (missed a real action): ${summary.falseNegatives}`,
  );
  console.log(
    `Arg JSON validity       : ${summary.validCalls}/${summary.calls} calls`,
  );
  console.log(
    `Arg correctness (spot)  : ${summary.argOk}/${summary.argTotal} checked`,
  );
  console.log(
    `Latency                 : avg ${summary.latency.avg}ms, max ${summary.latency.max}ms`,
  );

  // Append rather than overwrite: the value of a benchmark is the trend across
  // models and finetunes, not one number.
  mkdirSync(BENCH_DIR, { recursive: true });
  const record = toRecord(summary, MODEL, LABEL);
  appendFileSync(
    join(BENCH_DIR, "results.jsonl"),
    `${JSON.stringify(record)}\n`,
  );

  // The same run doubles as a finetuning seed set — only the turns the model
  // got right (see @ghost/shared → eval/trainset).
  const { examples, skipped } = toTrainingExamples(scored, AGENT_SYSTEM);
  writeFileSync(join(BENCH_DIR, "trainset.jsonl"), `${toJsonl(examples)}\n`);
  console.log(
    `\nRecorded to ${BENCH_DIR}/results.jsonl — trainset: ${examples.length} examples, ${skipped.length} to label`,
  );
  if (skipped.length) {
    writeFileSync(
      join(BENCH_DIR, "trainset-todo.json"),
      JSON.stringify(skipped, null, 2),
    );
  }
};

main().catch((e: unknown) => {
  console.error("eval failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
