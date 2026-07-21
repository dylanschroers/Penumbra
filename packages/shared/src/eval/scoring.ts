import type { EvalCase } from "./cases";

// Scoring is pure and separate from the runner that does HTTP, so the metrics
// a benchmark reports can be tested without a model.

/** What the model did with one utterance. */
export interface CaseOutcome {
  /** Tool it called, or null when it answered in prose. */
  name: string | null;
  /** Parsed arguments, or null when it called nothing or emitted bad JSON. */
  args: Record<string, unknown> | null;
  /** False when the model emitted a tool call whose arguments would not parse. */
  argsValid: boolean;
  /** Assistant prose, when it answered without a tool. */
  content?: string;
  ms: number;
}

export interface ScoredCase {
  case: EvalCase;
  outcome: CaseOutcome;
  /** Did it pick the right tool (or correctly pick none)? */
  selectionOk: boolean;
  /** Spot-check verdict, or null when the case declares no args to check. */
  argsOk: boolean | null;
}

export interface EvalSummary {
  total: number;
  /** Correct tool selections. */
  selection: number;
  /** Called a tool during chit-chat. */
  falsePositives: number;
  /** Answered in prose when an action was asked for. */
  falseNegatives: number;
  /** Tool calls emitted, and how many had parseable arguments. */
  calls: number;
  validCalls: number;
  /** Argument spot-checks passed, out of those the cases declare. */
  argOk: number;
  argTotal: number;
  latency: { avg: number; max: number };
}

export function scoreCase(c: EvalCase, outcome: CaseOutcome): ScoredCase {
  const selectionOk = outcome.name === c.tool;
  // Args are only meaningful when the right tool was chosen; a wrong tool's
  // arguments would be scored against a schema they were never meant for.
  const argsOk =
    selectionOk && c.args
      ? Object.entries(c.args).every(([k, v]) => outcome.args?.[k] === v)
      : null;
  return { case: c, outcome, selectionOk, argsOk };
}

export function summarize(scored: ScoredCase[]): EvalSummary {
  const latencies = scored.map((s) => s.outcome.ms);
  return {
    total: scored.length,
    selection: scored.filter((s) => s.selectionOk).length,
    falsePositives: scored.filter(
      (s) => s.case.tool === null && s.outcome.name !== null,
    ).length,
    falseNegatives: scored.filter(
      (s) => s.case.tool !== null && s.outcome.name === null,
    ).length,
    calls: scored.filter((s) => s.outcome.name !== null).length,
    validCalls: scored.filter(
      (s) => s.outcome.name !== null && s.outcome.argsValid,
    ).length,
    argOk: scored.filter((s) => s.argsOk === true).length,
    argTotal: scored.filter((s) => s.argsOk !== null).length,
    latency: {
      avg: latencies.length
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0,
      max: latencies.length ? Math.max(...latencies) : 0,
    },
  };
}

/** One benchmark run, appended to a JSONL log so runs stay comparable as the
 *  model, the prompt, or the contracts change. */
export interface BenchmarkRecord extends EvalSummary {
  at: string;
  model: string;
  /** Free-form label for what was being tested (e.g. a finetune's name). */
  label?: string;
}

export function toRecord(
  summary: EvalSummary,
  model: string,
  label?: string,
): BenchmarkRecord {
  return {
    at: new Date().toISOString(),
    model,
    ...summary,
    ...(label ? { label } : {}),
  };
}
