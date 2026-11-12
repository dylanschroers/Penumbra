import type { EvalCase } from "./cases";

export interface CaseOutcome {
  name: string | null;
  /** Null when it called nothing or emitted bad JSON. */
  args: Record<string, unknown> | null;
  argsValid: boolean;
  content?: string;
  ms: number;
}

export interface ScoredCase {
  case: EvalCase;
  outcome: CaseOutcome;
  selectionOk: boolean;
  /** Null when the case declares no args to check. */
  argsOk: boolean | null;
}

export interface EvalSummary {
  total: number;
  selection: number;
  falsePositives: number;
  falseNegatives: number;
  calls: number;
  validCalls: number;
  argOk: number;
  argTotal: number;
  latency: { avg: number; max: number };
}

export function scoreCase(c: EvalCase, outcome: CaseOutcome): ScoredCase {
  const selectionOk = outcome.name === c.tool;
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

export interface BenchmarkRecord extends EvalSummary {
  at: string;
  model: string;
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
