// Tool-calling viability spike (docs/AGENT_DESIGN.md §7). Measures whether the
// embedded model can turn a natural request into the RIGHT tool call with the
// RIGHT args. It does not execute tools — it only checks what the model emits.
//
// Usage: node scripts/tool-eval.mjs   (needs llama-server on :8080 with --jinja)
//   LLM_URL=http://127.0.0.1:8080  MODEL=qwen3-1.7b

const URL = process.env.LLM_URL ?? "http://127.0.0.1:8080";
const MODEL = process.env.MODEL ?? "qwen3-1.7b";

// Tools modeled on the real app: create_task mirrors validation/task.ts.
const tools = [
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Add a task to the user's to-do list.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short task title" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          dueAt: { type: "string", description: "Due date/time, ISO 8601 if known" },
          notes: { type: "string" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description: "Schedule a time-based reminder to notify the user.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to remind about" },
          when: { type: "string", description: "When to fire the reminder" },
        },
        required: ["text", "when"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_notes",
      description: "Search the user's saved notes and return matches.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
];

const SYSTEM =
  "You are Ghost, a personal assistant with tools to manage the user's tasks, " +
  "reminders, and notes. Call a tool ONLY when the user is asking you to perform " +
  "that action. For general questions, greetings, or chit-chat, just answer — do " +
  "not call a tool.";

// tool: expected tool name, or null = should answer without a tool.
// args: optional key fields to spot-check for semantic correctness.
const cases = [
  // create_task
  { text: "Add buy milk to my list", tool: "create_task" },
  { text: "Create a task to finish the quarterly report", tool: "create_task" },
  { text: "Add a high priority task to file taxes", tool: "create_task", args: { priority: "high" } },
  { text: "Put 'renew passport' on my todo list", tool: "create_task" },
  { text: "Make a low priority task to clean the garage", tool: "create_task", args: { priority: "low" } },
  { text: "Add a high-priority task to file taxes by April 15", tool: "create_task", args: { priority: "high" } },
  { text: "Create a task called draft proposal, medium priority", tool: "create_task", args: { priority: "medium" } },
  // set_reminder
  { text: "Remind me to call mom at 5pm", tool: "set_reminder" },
  { text: "Set a reminder to take out the trash tonight", tool: "set_reminder" },
  { text: "Remind me about the dentist appointment tomorrow at 9am", tool: "set_reminder" },
  { text: "Ping me in an hour to check the oven", tool: "set_reminder" },
  { text: "Set a reminder for the team meeting at 2pm", tool: "set_reminder" },
  { text: "Remind me to water the plants tomorrow morning", tool: "set_reminder" },
  // search_notes
  { text: "Find my notes about the vacation plan", tool: "search_notes" },
  { text: "Search my notes for the wifi password", tool: "search_notes" },
  { text: "What did I write about the budget meeting?", tool: "search_notes" },
  { text: "Look up my notes on book recommendations", tool: "search_notes" },
  { text: "Pull up what I saved about the lasagna recipe", tool: "search_notes" },
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

async function ask(text) {
  const t0 = Date.now();
  const res = await fetch(`${URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
      tools,
      tool_choice: "auto",
      max_tokens: 256,
      temperature: 0,
    }),
  });
  const body = await res.json();
  const ms = Date.now() - t0;
  const msg = body.choices?.[0]?.message ?? {};
  const call = msg.tool_calls?.[0]?.function;
  let name = call?.name ?? null;
  let args = null;
  let argsValid = true;
  if (call) {
    try {
      args = JSON.parse(call.arguments ?? "{}");
    } catch {
      argsValid = false;
    }
  }
  return { name, args, argsValid, ms };
}

function pad(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n);
}

const R = { reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", dim: "\x1b[2m" };

const main = async () => {
  let sel = 0, fp = 0, fn = 0, argOk = 0, argTotal = 0, validCalls = 0, calls = 0;
  const lat = [];
  console.log(pad("utterance", 46), pad("expected", 14), pad("got", 14), "result");
  console.log("-".repeat(84));
  for (const c of cases) {
    const r = await ask(c.text);
    lat.push(r.ms);
    const selOk = r.name === c.tool;
    if (selOk) sel++;
    if (c.tool === null && r.name !== null) fp++;
    if (c.tool !== null && r.name === null) fn++;
    if (r.name) { calls++; if (r.argsValid) validCalls++; }
    // semantic arg spot-check
    let argMark = "";
    if (selOk && c.args) {
      argTotal++;
      const hit = Object.entries(c.args).every(([k, v]) => r.args?.[k] === v);
      if (hit) { argOk++; argMark = " args✓"; } else argMark = ` args✗(${JSON.stringify(r.args)})`;
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
  console.log(`Tool-selection accuracy : ${sel}/${n} (${((sel / n) * 100).toFixed(0)}%)`);
  console.log(`False positives (called on chit-chat): ${fp}`);
  console.log(`False negatives (missed a real action): ${fn}`);
  console.log(`Arg JSON validity       : ${validCalls}/${calls} calls`);
  console.log(`Arg correctness (spot)  : ${argOk}/${argTotal} checked`);
  console.log(`Latency                 : avg ${avg}ms, max ${Math.max(...lat)}ms`);
};

main().catch((e) => {
  console.error("eval failed:", e.message);
  process.exit(1);
});
