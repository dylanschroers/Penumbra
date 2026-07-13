// Tool-calling regression check (docs/AGENT_DESIGN.md §7). Measures whether the
// embedded model turns a natural request into the RIGHT tool call with the
// RIGHT args. It does not execute tools — it only checks what the model emits.
//
// The tool specs and system prompt are imported from @ghost/shared, so this
// tests exactly what the app ships — the eval cannot drift from the product.
//
// Usage: pnpm tool-eval   (needs llama-server on :8080 with --jinja)
//   LLM_URL=http://127.0.0.1:8080  MODEL=qwen3-1.7b

import { AGENT_SYSTEM, taskTools, toToolSpec } from "@ghost/shared";

// Named BASE_URL so it doesn't shadow the global URL constructor.
const BASE_URL = process.env.LLM_URL ?? "http://127.0.0.1:8080";
const MODEL = process.env.MODEL ?? "qwen3-1.7b";

const tools = taskTools.map(toToolSpec);

// tool: expected tool name, or null = should answer without a tool.
// args: optional key fields to spot-check for semantic correctness. Only
// deterministic slots (priority, status) are checked — title extraction varies
// in casing/phrasing, so titles are judged by tool selection alone.
interface Case {
  text: string;
  tool: string | null;
  args?: Record<string, unknown>;
}

const cases: Case[] = [
  // create_task
  { text: "Add buy milk to my list", tool: "create_task" },
  { text: "Create a task to finish the quarterly report", tool: "create_task" },
  {
    text: "Add a high priority task to file taxes",
    tool: "create_task",
    args: { priority: "high" },
  },
  { text: "Put 'renew passport' on my todo list", tool: "create_task" },
  {
    text: "Make a low priority task to clean the garage",
    tool: "create_task",
    args: { priority: "low" },
  },
  {
    text: "Add a high-priority task to file taxes by April 15",
    tool: "create_task",
    args: { priority: "high" },
  },
  {
    text: "Create a task called draft proposal, medium priority",
    tool: "create_task",
    args: { priority: "medium" },
  },
  // list_tasks
  { text: "What's on my to-do list?", tool: "list_tasks" },
  { text: "Show me my tasks", tool: "list_tasks" },
  {
    text: "Which tasks have I finished?",
    tool: "list_tasks",
    args: { status: "done" },
  },
  { text: "List everything I still have to do", tool: "list_tasks" },
  // complete_task
  { text: "Mark buy milk as done", tool: "complete_task" },
  {
    text: "I finished the quarterly report, check it off",
    tool: "complete_task",
  },
  {
    text: "Complete the task about renewing my passport",
    tool: "complete_task",
  },
  { text: "Tick off cleaning the garage", tool: "complete_task" },
  // delete_task
  { text: "Delete the buy milk task", tool: "delete_task" },
  { text: "Remove 'file taxes' from my list", tool: "delete_task" },
  { text: "Get rid of the draft proposal task", tool: "delete_task" },
  // negative — should NOT call a tool
  { text: "What's the weather like today?", tool: null },
  { text: "How do I stay more organized?", tool: null },
  { text: "What can you help me with?", tool: null },
  { text: "Tell me a fun fact.", tool: null },
  { text: "What's 15% of 240?", tool: null },
  { text: "Explain what a task manager is.", tool: null },
  { text: "Good morning!", tool: null },
  { text: "Thanks, that's helpful.", tool: null },
];

interface AskResult {
  name: string | null;
  args: Record<string, unknown> | null;
  argsValid: boolean;
  ms: number;
}

async function ask(text: string): Promise<AskResult> {
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
      `llama-server responded ${res.status}: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };
  const ms = Date.now() - t0;
  const call = body.choices?.[0]?.message?.tool_calls?.[0]?.function;
  let args: Record<string, unknown> | null = null;
  let argsValid = true;
  if (call) {
    try {
      args = JSON.parse(call.arguments ?? "{}") as Record<string, unknown>;
    } catch {
      argsValid = false;
    }
  }
  return { name: call?.name ?? null, args, argsValid, ms };
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
  let sel = 0,
    fp = 0,
    fn = 0,
    argOk = 0,
    argTotal = 0,
    validCalls = 0,
    calls = 0;
  const lat: number[] = [];
  console.log(
    pad("utterance", 46),
    pad("expected", 14),
    pad("got", 14),
    "result",
  );
  console.log("-".repeat(84));
  for (const c of cases) {
    const r = await ask(c.text);
    lat.push(r.ms);
    const selOk = r.name === c.tool;
    if (selOk) sel++;
    if (c.tool === null && r.name !== null) fp++;
    if (c.tool !== null && r.name === null) fn++;
    if (r.name) {
      calls++;
      if (r.argsValid) validCalls++;
    }
    // semantic arg spot-check
    let argMark = "";
    if (selOk && c.args) {
      argTotal++;
      const hit = Object.entries(c.args).every(([k, v]) => r.args?.[k] === v);
      if (hit) {
        argOk++;
        argMark = " args✓";
      } else argMark = ` args✗(${JSON.stringify(r.args)})`;
    }
    const color = selOk ? R.green : R.red;
    console.log(
      pad(c.text, 46),
      pad(c.tool ?? "(none)", 14),
      pad(r.name ?? "(none)", 14),
      `${color}${selOk ? "PASS" : "FAIL"}${R.reset}${R.dim}${argMark} ${r.ms}ms${R.reset}`,
    );
  }
  const n = cases.length;
  const avg = Math.round(lat.reduce((a, b) => a + b, 0) / n);
  console.log("-".repeat(84));
  console.log(
    `Tool-selection accuracy : ${sel}/${n} (${((sel / n) * 100).toFixed(0)}%)`,
  );
  console.log(`False positives (called on chit-chat): ${fp}`);
  console.log(`False negatives (missed a real action): ${fn}`);
  console.log(`Arg JSON validity       : ${validCalls}/${calls} calls`);
  console.log(`Arg correctness (spot)  : ${argOk}/${argTotal} checked`);
  console.log(
    `Latency                 : avg ${avg}ms, max ${Math.max(...lat)}ms`,
  );
};

main().catch((e: unknown) => {
  console.error("eval failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
