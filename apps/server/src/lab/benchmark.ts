import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_SYSTEM,
  type BenchmarkResult,
  type CaseOutcome,
  evalCases,
  type SuiteDefinition,
  scoreCase,
  summarize,
  type TaskScore,
  taskTools,
  toToolSpec,
} from "@ghost/shared";

// Runs both benchmark families and reduces them to one BenchmarkResult, which
// is what lets a single table hold both and a single view compare them
// (docs/model_lab_plan.md M3).
//
// They run differently on purpose. The general suite shells out to lm-eval
// because it is Python. The personal suite is a direct call, because its
// scoring is already pure TypeScript in @ghost/shared — no subprocess, no
// Python, and no way to drift from the tool specs the app ships.

export interface BenchmarkOptions {
  model: string;
  suite: SuiteDefinition;
  samplesPerTask: number;
  /** OpenAI-compatible endpoint the model is served from. */
  baseURL: string;
  apiKey?: string;
  signal?: AbortSignal;
  /** Progress lines, for the job's SSE relay. */
  onProgress?: (line: string) => void;
}

export async function runBenchmark(
  opts: BenchmarkOptions,
): Promise<BenchmarkResult> {
  const started = Date.now();
  const scores =
    opts.suite.kind === "personal"
      ? await runPersonalSuite(opts)
      : await runGeneralSuite(opts);

  return {
    suite: opts.suite.id,
    suiteKind: opts.suite.kind,
    model: opts.model,
    samplesPerTask: opts.samplesPerTask,
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    scores,
  };
}

// ---------------------------------------------------------------- personal --

/** Ask the model one utterance and record what it emitted. Mirrors
 *  scripts/tool-eval.ts, which stays the no-server path for a quick check. */
async function ask(
  text: string,
  opts: BenchmarkOptions,
  tools: ReturnType<typeof toToolSpec>[],
): Promise<CaseOutcome> {
  const t0 = Date.now();
  const res = await fetch(`${opts.baseURL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: "system", content: AGENT_SYSTEM },
        { role: "user", content: text },
      ],
      tools,
      tool_choice: "auto",
      max_tokens: 256,
      temperature: 0,
    }),
    signal: opts.signal,
  });
  // Fail loudly: a rejected request must not be scored as "declined to call".
  if (!res.ok) throw new Error(`model responded ${res.status}`);

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
    content: (message?.content ?? "")
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .trim(),
    ms: Date.now() - t0,
  };
}

async function runPersonalSuite(opts: BenchmarkOptions): Promise<TaskScore[]> {
  const tools = taskTools.map(toToolSpec);
  // samplesPerTask caps the run so a smoke check stays quick; the full set is
  // small enough that the cap is usually the whole thing.
  const cases = evalCases.slice(0, opts.samplesPerTask);
  const scored = [];

  for (const [i, c] of cases.entries()) {
    opts.signal?.throwIfAborted();
    scored.push(scoreCase(c, await ask(c.text, opts, tools)));
    opts.onProgress?.(`case ${i + 1}/${cases.length}: ${c.text}`);
  }

  const s = summarize(scored);
  const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);
  // Rates, not raw counts, so a 20-case run compares against a 26-case one.
  return [
    {
      task: "tool_selection",
      metric: "acc",
      value: rate(s.selection, s.total),
    },
    {
      task: "false_positives",
      metric: "rate",
      value: rate(s.falsePositives, s.total),
    },
    {
      task: "false_negatives",
      metric: "rate",
      value: rate(s.falseNegatives, s.total),
    },
    {
      task: "arg_json_validity",
      metric: "rate",
      value: rate(s.validCalls, s.calls),
    },
    {
      task: "arg_correctness",
      metric: "acc",
      value: rate(s.argOk, s.argTotal),
    },
    { task: "latency", metric: "avg_ms", value: s.latency.avg },
  ];
}

// ----------------------------------------------------------------- general --

/** Where lm-eval writes results; it nests under a model-named directory. */
async function findResultsJson(root: string): Promise<string | undefined> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.startsWith("results") && entry.name.endsWith(".json"))
        return path;
    }
  }
  return undefined;
}

/** Pull every numeric metric out of lm-eval's results.json. Its per-task shape
 *  is `{ "gsm8k": { "exact_match,strict-match": 0.42, ... } }`; stderr entries
 *  and non-numerics are skipped. */
export function parseLmEvalResults(raw: string): TaskScore[] {
  const parsed = JSON.parse(raw) as {
    results?: Record<string, Record<string, unknown>>;
  };
  const out: TaskScore[] = [];
  for (const [task, metrics] of Object.entries(parsed.results ?? {})) {
    for (const [key, value] of Object.entries(metrics)) {
      if (typeof value !== "number" || Number.isNaN(value)) continue;
      if (key === "alias" || key.startsWith("  ")) continue;
      if (key.includes("stderr")) continue;
      out.push({ task, metric: key, value });
    }
  }
  return out;
}

/** Path to the lm_eval binary, overridable for tests and for a venv install. */
export const LM_EVAL_BIN = process.env.LM_EVAL_BIN ?? "lm_eval";

export async function lmEvalAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(LM_EVAL_BIN, ["--help"], { stdio: "ignore" });
    probe.on("error", () => resolve(false));
    probe.on("close", (code) => resolve(code === 0));
  });
}

async function runGeneralSuite(opts: BenchmarkOptions): Promise<TaskScore[]> {
  const outDir = await mkdtemp(join(tmpdir(), "ghost-lmeval-"));
  const args = [
    "--model",
    "local-chat-completions",
    "--model_args",
    `model=${opts.model},base_url=${opts.baseURL}/v1/chat/completions,num_concurrent=1,max_retries=3`,
    "--tasks",
    opts.suite.tasks.join(","),
    "--limit",
    String(opts.samplesPerTask),
    "--seed",
    "42",
    "--apply_chat_template",
    "--output_path",
    outDir,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(LM_EVAL_BIN, args, {
      env: { ...process.env, OPENAI_API_KEY: opts.apiKey ?? "dummy" },
    });
    // A client abort must kill the subprocess, or a cancelled benchmark keeps
    // burning GPU for hours.
    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    let stderrTail = "";
    child.stdout.on("data", (d: Buffer) =>
      opts.onProgress?.(d.toString().trimEnd()),
    );
    child.stderr.on("data", (d: Buffer) => {
      const line = d.toString();
      stderrTail = `${stderrTail}${line}`.slice(-2000);
      opts.onProgress?.(line.trimEnd());
    });
    child.on("error", (err) =>
      reject(new Error(`lm_eval failed to start: ${err.message}`)),
    );
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve();
      else reject(new Error(`lm_eval exited ${code}: ${stderrTail.trim()}`));
    });
  });

  const results = await findResultsJson(outDir);
  if (!results) throw new Error("lm_eval wrote no results.json");
  return parseLmEvalResults(await readFile(results, "utf8"));
}
