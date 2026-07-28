// Parse the head of a dataset file, recognise its schema, and validate it — the
// analysis behind the Model Lab's dataset preview. Pure and synchronous: the
// caller reads the bounded head (fsClient.readHead) and hands the text here.
//
// The point is to catch, before a run starts, the two failures that otherwise
// surface minutes later as an opaque error from Studio: a file in a shape the
// trainer can't read, and a schema the SFT path can't train at all (preference
// data). It also preselects Studio's `format_type` so the trainer reads the
// file the way the file is actually written.

import type { DatasetFormat } from "./datasetLibrary";

/** The record shape we recognise. */
export type DatasetSchema =
  | "alpaca" // { instruction, input?, output }
  | "chatml" // { messages: [{ role, content }] }
  | "sharegpt" // { conversations: [{ from, value }] }
  | "preference" // { prompt?, chosen, rejected } — DPO, not SFT
  | "raw" // { text }
  | "unknown";

/** The subset of Studio's `format_type` we map a detected schema onto. */
export type FormatType = "auto" | "alpaca" | "chatml" | "raw" | "generic";

export interface PreviewIssue {
  level: "warn" | "error";
  message: string;
}

export interface DatasetPreview {
  schema: DatasetSchema;
  /** The Studio `format_type` to preselect for this schema. */
  formatType: FormatType;
  /** False when the SFT fine-tune path can't train this schema (preference/DPO). */
  trainable: boolean;
  /** Parsed sample records from the head (bounded). */
  records: unknown[];
  /** Records counted in the head. */
  count: number;
  /** True when `count` is the whole file; false when it's a sample of the head. */
  exact: boolean;
  issues: PreviewIssue[];
}

// How many records to weigh when deciding the schema and validating. A dataset
// is normally homogeneous, so a sample settles it.
const SAMPLE = 50;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** Split a CSV line on commas, honouring simple `"..."` quoting. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

interface Parsed {
  records: unknown[];
  /** Lines/records that failed to parse (JSON only). */
  parseErrors: number;
  exact: boolean;
}

function parseJsonl(head: string, truncated: boolean): Parsed {
  const lines = head.split("\n");
  // A truncated read almost always cuts the last line mid-record; drop it so it
  // doesn't read as a parse error.
  if (truncated) lines.pop();
  const records: unknown[] = [];
  let parseErrors = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      records.push(JSON.parse(t));
    } catch {
      parseErrors++;
    }
  }
  return { records, parseErrors, exact: !truncated };
}

function parseJson(head: string, truncated: boolean): Parsed {
  try {
    const value = JSON.parse(head);
    const records = Array.isArray(value) ? value : [value];
    return { records, parseErrors: 0, exact: !truncated };
  } catch {
    // A truncated single big array can't parse from its head — expected, not an
    // error. A complete file that won't parse is genuinely malformed.
    return { records: [], parseErrors: truncated ? 0 : 1, exact: false };
  }
}

function parseCsv(head: string, truncated: boolean): Parsed {
  const lines = head.split(/\r?\n/);
  if (truncated) lines.pop();
  const header = lines.shift();
  if (!header) return { records: [], parseErrors: 0, exact: !truncated };
  const cols = splitCsv(header);
  const records: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const vals = splitCsv(line);
    const row: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      row[c] = vals[i] ?? "";
    });
    records.push(row);
  }
  return { records, parseErrors: 0, exact: !truncated };
}

function classify(r: unknown): DatasetSchema {
  if (!isRecord(r)) return "unknown";
  if (Array.isArray(r.messages)) return "chatml";
  if (Array.isArray(r.conversations)) return "sharegpt";
  if ("chosen" in r && "rejected" in r) return "preference";
  if ("instruction" in r && "output" in r) return "alpaca";
  if (typeof r.text === "string") return "raw";
  return "unknown";
}

/** The dominant schema across the sample, and how many records dissented. */
function detectSchema(records: unknown[]): {
  schema: DatasetSchema;
  dissent: number;
} {
  const counts = new Map<DatasetSchema, number>();
  const sample = records.slice(0, SAMPLE);
  for (const r of sample) {
    const s = classify(r);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let schema: DatasetSchema = "unknown";
  let best = -1;
  for (const [s, n] of counts) {
    // Prefer any recognised schema over "unknown" on a tie.
    if (n > best || (n === best && schema === "unknown")) {
      best = n;
      schema = s;
    }
  }
  const dissent = sample.length - (counts.get(schema) ?? 0);
  return { schema, dissent };
}

const FORMAT_OF: Record<
  DatasetSchema,
  { formatType: FormatType; trainable: boolean }
> = {
  alpaca: { formatType: "alpaca", trainable: true },
  chatml: { formatType: "chatml", trainable: true },
  // Studio ingests ShareGPT conversations as chat; chatml is the closest type.
  sharegpt: { formatType: "chatml", trainable: true },
  preference: { formatType: "auto", trainable: false },
  raw: { formatType: "raw", trainable: true },
  unknown: { formatType: "auto", trainable: true },
};

/** Count records failing a per-record predicate, over the sample. */
function countBad(
  records: unknown[],
  bad: (r: Record<string, unknown>) => boolean,
): number {
  let n = 0;
  for (const r of records.slice(0, SAMPLE)) {
    if (!isRecord(r) || bad(r)) n++;
  }
  return n;
}

function validate(schema: DatasetSchema, records: unknown[]): PreviewIssue[] {
  const issues: PreviewIssue[] = [];
  const push = (
    n: number,
    message: string,
    level: "warn" | "error" = "warn",
  ) => {
    if (n > 0) issues.push({ level, message: `${n} ${message}` });
  };

  switch (schema) {
    case "alpaca":
      push(
        countBad(records, (r) => !nonEmptyString(r.output)),
        "record(s) have an empty output.",
      );
      push(
        countBad(records, (r) => !nonEmptyString(r.instruction)),
        "record(s) have an empty instruction.",
      );
      break;
    case "chatml":
      push(
        countBad(
          records,
          (r) => !Array.isArray(r.messages) || r.messages.length === 0,
        ),
        "record(s) have no messages.",
      );
      push(
        countBad(records, (r) =>
          (r.messages as unknown[]).some?.(
            (m) => !isRecord(m) || !("role" in m) || !nonEmptyString(m.content),
          ),
        ),
        "record(s) have a message missing a role or content.",
      );
      break;
    case "sharegpt":
      push(
        countBad(
          records,
          (r) =>
            !Array.isArray(r.conversations) || r.conversations.length === 0,
        ),
        "record(s) have no conversation turns.",
      );
      break;
    case "raw":
      push(
        countBad(records, (r) => !nonEmptyString(r.text)),
        "record(s) have empty text.",
      );
      break;
    case "preference":
      issues.push({
        level: "error",
        message:
          "Looks like preference (DPO) data. This fine-tune path does SFT only, so it won't train as-is.",
      });
      break;
    default:
      issues.push({
        level: "warn",
        message:
          "Couldn't recognise a known schema — Studio will try to auto-detect. Check the records below look right.",
      });
  }
  return issues;
}

/**
 * Analyse the head of a dataset file. `truncated` (from readHead) tells us
 * whether the count is exact or a sample.
 */
export function analyzeHead(
  head: string,
  format: DatasetFormat,
  truncated: boolean,
): DatasetPreview {
  if (format === "parquet") {
    return {
      schema: "unknown",
      formatType: "auto",
      trainable: true,
      records: [],
      count: 0,
      exact: false,
      issues: [
        {
          level: "warn",
          message:
            "Preview isn't available for .parquet yet — Studio still trains it.",
        },
      ],
    };
  }

  const parsed =
    format === "jsonl"
      ? parseJsonl(head, truncated)
      : format === "csv"
        ? parseCsv(head, truncated)
        : parseJson(head, truncated);

  const { schema, dissent } = detectSchema(parsed.records);
  const { formatType, trainable } = FORMAT_OF[schema];
  const issues = validate(schema, parsed.records);

  if (parsed.parseErrors > 0) {
    issues.unshift({
      level: "error",
      message: `${parsed.parseErrors} line(s) are not valid JSON.`,
    });
  }
  if (parsed.records.length === 0 && format === "json" && truncated) {
    issues.unshift({
      level: "warn",
      message:
        "This .json is one large array — a preview would need the whole file.",
    });
  }
  // Only flag dissent for a schema that was actually recognised.
  if (schema !== "unknown" && dissent > 0) {
    issues.push({
      level: "warn",
      message: `${dissent} record(s) don't match the ${schema} shape.`,
    });
  }

  return {
    schema,
    formatType,
    trainable,
    records: parsed.records,
    count: parsed.records.length,
    exact: parsed.exact,
    issues,
  };
}
