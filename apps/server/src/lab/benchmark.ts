import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_SYSTEM,
  agentTools,
  type BenchmarkResult,
  type CaseOutcome,
  composeSystem,
  evalCases,
  LAB_POLICY,
  LAB_TOOL_SUITES,
  labEvalCases,
  labTools,
  type SuiteDefinition,
  scoreCase,
  summarize,
  type TargetId,
  type TaskScore,
  toToolSpec,
} from "@penumbra/shared";
import { caseProgress, type RunProgress, readOutputChunk } from "./progress";

// The general suite shells out to lm-eval (Python); the personal suite scores
// in-process from @penumbra/shared.

export interface BenchmarkOptions {
  /** Studio ignores it and serves what's loaded: this is what was asked for. */
  model: string;
  /** What actually answered; the scores describe this. */
  servedModel: string | null;
  /** Two targets can hold different weights under one name. */
  target: TargetId;
  suite: SuiteDefinition;
  samplesPerTask: number;
  baseURL: string;
  apiKey?: string;
  signal?: AbortSignal;
  onProgress?: (update: RunProgress) => void;
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
    servedModel: opts.servedModel,
    target: opts.target,
    samplesPerTask: opts.samplesPerTask,
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    scores,
  };
}

/** Mirrors scripts/tool-eval.ts. */
async function ask(
  text: string,
  opts: BenchmarkOptions,
  tools: ReturnType<typeof toToolSpec>[],
  system: string,
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
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      tools,
      tool_choice: "auto",
      max_tokens: 256,
      temperature: 0,
    }),
    signal: opts.signal,
  });
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

/** Deterministic, so runs at the same sample count score the same cases. */
function spread<T>(items: T[], n: number): T[] {
  if (n >= items.length) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)] as T);
}

async function runPersonalSuite(opts: BenchmarkOptions): Promise<TaskScore[]> {
  // Tools and prompt both follow from the suite id.
  const withLab = LAB_TOOL_SUITES.has(opts.suite.id);
  const tools = (withLab ? [...agentTools, ...labTools] : agentTools).map(
    toToolSpec,
  );
  const system = withLab ? composeSystem(undefined, LAB_POLICY) : AGENT_SYSTEM;
  // The lab suite reruns the base cases to show what the extra tools cost.
  const all = withLab ? [...evalCases, ...labEvalCases] : evalCases;
  // Spread, not a prefix: every case set puts its negatives last, so a prefix
  // would measure no false positives.
  const cases = spread(all, opts.samplesPerTask);
  const scored = [];

  for (const [i, c] of cases.entries()) {
    opts.signal?.throwIfAborted();
    scored.push(scoreCase(c, await ask(c.text, opts, tools, system)));
    opts.onProgress?.(caseProgress(i + 1, cases.length, c.text));
  }

  const s = summarize(scored);
  const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);
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

/** lm-eval nests results under a model-named directory. */
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

/** Skips stderr entries and non-numerics. */
export function parseLmEvalResults(raw: string): TaskScore[] {
  const parsed = JSON.parse(raw) as {
    results?: Record<string, Record<string, unknown>>;
  };
  const out: TaskScore[] = [];
  for (const [task, metrics] of Object.entries(parsed.results ?? {})) {
    for (const [key, value] of Object.entries(metrics)) {
      if (typeof value !== "number" || Number.isNaN(value)) continue;
      if (key === "alias" || key.startsWith("  ")) continue;
      // stderr is a confidence interval and sample_len a row count; neither is a
      // score.
      if (key.includes("stderr") || key === "sample_len") continue;
      out.push({ task, metric: key, value });
    }
  }
  return out;
}

export const LM_EVAL_BIN = process.env.LM_EVAL_BIN ?? "lm_eval";

/**
 * lm_eval prints a tqdm frame per request, so silence beyond this means a
 * wedge (it hangs after finishing on Windows, holding the GPU). One flat
 * budget: multi-task runs show a full bar at every task boundary.
 */
export const BENCHMARK_STALL_MS =
  Number(process.env.BENCHMARK_STALL_MS) || 300_000;

export async function lmEvalAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(LM_EVAL_BIN, ["--help"], { stdio: "ignore" });
    probe.on("error", () => resolve(false));
    probe.on("close", (code) => resolve(code === 0));
  });
}

/**
 * The UTF-8 pair matters on Windows: lm_eval prints "↑" in its final summary,
 * which cp1252 can't encode, so every run exited 1 after writing results.
 * Exported for the test.
 */
export function lmEvalEnv(apiKey?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENAI_API_KEY: apiKey ?? "dummy",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
}

/**
 * A non-zero exit or stall is an outcome, not an error: a stalled run may
 * have complete results.
 */
export interface ProcessOutcome {
  code: number | null;
  stalled: boolean;
  /** Gates salvage on a genuinely finished run. */
  progress: number;
  stderrTail: string;
}

/**
 * Kills the child after `stallMs` of silence; any output resets the clock.
 * Rejects only if the process fails to start.
 */
export function watchProcess(
  child: ChildProcess,
  opts: {
    stallMs: number;
    onProgress?: (update: RunProgress) => void;
  },
): Promise<ProcessOutcome> {
  return new Promise((resolve, reject) => {
    let progress = 0;
    let stalled = false;
    let stderrTail = "";
    let idle: NodeJS.Timeout | undefined;
    let hardKill: NodeJS.Timeout | undefined;

    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        // SIGKILL backs up SIGTERM.
        stalled = true;
        child.kill("SIGTERM");
        hardKill = setTimeout(() => child.kill("SIGKILL"), 2000);
      }, opts.stallMs);
    };

    // Progress bars go to stderr, tables to stdout, and chunks split frames
    // arbitrarily, so both share one reader.
    const relay = (chunk: string) => {
      const update = readOutputChunk(chunk);
      if (update) {
        if (update.progress !== null) progress = update.progress;
        opts.onProgress?.(update);
      }
      arm();
    };

    child.stdout?.on("data", (d: Buffer) => relay(d.toString()));
    child.stderr?.on("data", (d: Buffer) => {
      const line = d.toString();
      // Kept raw: the traceback lives here.
      stderrTail = `${stderrTail}${line}`.slice(-2000);
      relay(line);
    });
    child.on("error", (err) => {
      clearTimeout(idle);
      clearTimeout(hardKill);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(idle);
      clearTimeout(hardKill);
      resolve({ code, stalled, progress, stderrTail });
    });
    // Armed before any output, so a child silent from the start is caught.
    arm();
  });
}

async function runGeneralSuite(opts: BenchmarkOptions): Promise<TaskScore[]> {
  const outDir = await mkdtemp(join(tmpdir(), "penumbra-lmeval-"));
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

  const child = spawn(LM_EVAL_BIN, args, { env: lmEvalEnv(opts.apiKey) });
  // Otherwise a cancelled benchmark keeps the GPU busy for hours.
  const onAbort = () => child.kill("SIGTERM");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  let outcome: ProcessOutcome;
  try {
    outcome = await watchProcess(child, {
      stallMs: BENCHMARK_STALL_MS,
      onProgress: opts.onProgress,
    });
  } catch (err) {
    throw new Error(
      `lm_eval failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }

  // Salvage: with no --log_samples, lm_eval writes results.json once, at the
  // end, so a full bar plus that file means it finished and only failed to
  // exit. Otherwise the stall is a real hang and fails with the stderr tail.
  if (outcome.stalled) {
    const salvage =
      outcome.progress >= 0.999 ? await findResultsJson(outDir) : undefined;
    if (salvage) return parseLmEvalResults(await readFile(salvage, "utf8"));
    throw new Error(
      `lm_eval stalled at ${Math.round(outcome.progress * 100)}% and was killed: ${outcome.stderrTail.trim()}`,
    );
  }
  if (outcome.code !== 0) {
    throw new Error(
      `lm_eval exited ${outcome.code}: ${outcome.stderrTail.trim()}`,
    );
  }

  const results = await findResultsJson(outDir);
  if (!results) throw new Error("lm_eval wrote no results.json");
  return parseLmEvalResults(await readFile(results, "utf8"));
}
