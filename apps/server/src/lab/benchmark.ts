import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_SYSTEM,
  agentTools,
  type BenchmarkResult,
  type CaseOutcome,
  evalCases,
  type SuiteDefinition,
  scoreCase,
  summarize,
  type TargetId,
  type TaskScore,
  toToolSpec,
} from "@penumbra/shared";
import { caseProgress, type RunProgress, readOutputChunk } from "./progress";

// Runs both benchmark families and reduces them to one BenchmarkResult, which
// is what lets a single table hold both and a single view compare them
// (docs/EVAL.md §4).
//
// They run differently on purpose. The general suite shells out to lm-eval
// because it is Python. The personal suite is a direct call, because its
// scoring is already pure TypeScript in @penumbra/shared — no subprocess, no
// Python, and no way to drift from the tool specs the app ships.

export interface BenchmarkOptions {
  /** The id sent on the wire. Studio ignores it and serves what it has loaded,
   *  so it is what was *asked for*, not what answered. */
  model: string;
  /** What the endpoint reports as loaded — the model the scores actually
   *  describe. Recorded beside `model` so a mismatch is visible. */
  servedModel: string | null;
  /** Which compute target served it. Two targets can hold different weights
   *  under one name, so a score is not comparable without it. */
  target: TargetId;
  suite: SuiteDefinition;
  samplesPerTask: number;
  /** OpenAI-compatible endpoint the model is served from. */
  baseURL: string;
  apiKey?: string;
  signal?: AbortSignal;
  /**
   * Where the run has got to, for the job record.
   *
   * Structured rather than a line of text: a job row can only draw a bar if
   * something hands it a number, and the number is already in the output both
   * suites produce. Interpreting it here keeps the route a relay — it writes
   * what it is given and does not need to know what lm_eval's stdout looks
   * like.
   */
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
  const tools = agentTools.map(toToolSpec);
  // samplesPerTask caps the run so a smoke check stays quick; the full set is
  // small enough that the cap is usually the whole thing.
  const cases = evalCases.slice(0, opts.samplesPerTask);
  const scored = [];

  for (const [i, c] of cases.entries()) {
    opts.signal?.throwIfAborted();
    scored.push(scoreCase(c, await ask(c.text, opts, tools)));
    opts.onProgress?.(caseProgress(i + 1, cases.length, c.text));
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
      // stderr is a confidence interval and sample_len is a row count; neither
      // is a score, and charting them beside accuracy is actively misleading.
      // (sample_len showed up in a live gsm8k run as a flat "1.000".)
      if (key.includes("stderr") || key === "sample_len") continue;
      out.push({ task, metric: key, value });
    }
  }
  return out;
}

/** Path to the lm_eval binary, overridable for tests and for a venv install. */
export const LM_EVAL_BIN = process.env.LM_EVAL_BIN ?? "lm_eval";

/**
 * How long the lm_eval child may fall silent before it is treated as wedged and
 * killed. It prints a tqdm frame per completed request, so a healthy run is
 * quiet only for the length of one request (a Studio at ~48s/it, measured, sits
 * far inside this) or the gap between tasks — both well under five minutes.
 *
 * This is what catches lm_eval hanging *after* a finished run — it has done so
 * on Windows at the summary-table step — which used to leave a job stuck at
 * "running 100%" forever, holding the GPU with it and so timing out every chat
 * turn and job_status check aimed at the same host.
 *
 * A single flat budget on purpose: shortening it once the bar hits 100% would
 * catch that hang sooner, but a multi-task run shows a full bar at every task
 * boundary, and a short budget there would kill a healthy run in the gap before
 * the next task's first request. Overridable for a slow host or a snappier one.
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
 * Environment for the lm_eval child.
 *
 * The UTF-8 pair is load-bearing on a Windows host. lm_eval finishes the run,
 * writes results.json, and *then* prints a summary table containing "↑" — which
 * cp1252, Python's default stdout encoding there, cannot encode. The process
 * died with a UnicodeEncodeError and exited 1 after the evaluation had already
 * succeeded, so every general-suite run failed at the last step with its scores
 * sitting on disk unread.
 *
 * Fixed on the child rather than by accepting a non-zero exit whenever
 * results.json happens to exist: that would swallow the failures worth seeing,
 * and a run that dies partway through a task also leaves a file behind.
 *
 * Exported for the test — this is invisible on a POSIX CI box and would return
 * unnoticed.
 */
export function lmEvalEnv(apiKey?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENAI_API_KEY: apiKey ?? "dummy",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
}

/** How a watched child process ended. A non-zero exit and a stall are outcomes,
 *  not errors: the caller decides what each means, because a stalled run may
 *  still have complete results on disk worth keeping. */
export interface ProcessOutcome {
  /** Exit code, or null when a signal (a kill) ended it. */
  code: number | null;
  /** The watchdog killed it for going silent past its budget. */
  stalled: boolean;
  /** Highest progress (0..1) the output reported. Gates salvage on a genuinely
   *  finished run and names the stall point in the error. */
  progress: number;
  /** Last ~2 KB of stderr, where a failed run's traceback lives. */
  stderrTail: string;
}

/**
 * Relay a child's output as progress and settle when it ends, killing it if it
 * goes silent for longer than `stallMs`. Any output at all restarts the clock,
 * so a run that keeps printing tqdm frames is never touched; only true silence
 * past the budget counts as a wedge.
 *
 * Rejects only if the process fails to start; every other ending resolves with
 * a ProcessOutcome for the caller to interpret.
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
        // Silent past the budget: kill it so the job settles as failed instead
        // of sitting at 100% forever, and the GPU it holds is freed. SIGKILL
        // backs up SIGTERM if the wedged process ignores the first.
        stalled = true;
        child.kill("SIGTERM");
        hardKill = setTimeout(() => child.kill("SIGKILL"), 2000);
      }, opts.stallMs);
    };

    // lm_eval writes its progress bars to stderr and its tables to stdout, and a
    // chunk from either can be several frames or half of one — so both go
    // through the same reader, which reports only what is worth showing. Any
    // output at all also means the child is alive, so it restarts the clock.
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
      // Kept whole and unparsed: this is what a failed run's message is built
      // from, and a bar frame trimmed for display would lose the traceback.
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
    // Arm before any output so a child that hangs from the very first byte is
    // still caught.
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
  // A client abort must kill the subprocess, or a cancelled benchmark keeps
  // burning GPU for hours.
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

  // Salvage a wedged-but-finished run. lm_eval has hung after the last request
  // on Windows (the summary-table step it also once crashed on, see lmEvalEnv):
  // the scores are already written, so a full bar plus a results.json on disk is
  // a completed run whose process merely would not exit — not a partial one. Our
  // args carry no --log_samples, so lm_eval writes results.json exactly once, at
  // the very end, which is what makes the file's presence proof of completion.
  // Without it, the stall is a real mid-run hang and must fail — carrying the
  // stderr tail so the traceback that a stuck "running 100%" row hid is visible.
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
