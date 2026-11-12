// Parses benchmark output into progress for the job row. Rates come as s/it or
// it/s, the estimate is `?` until tqdm has a rate, and a pipe chunk holds
// several frames or half of one.

export interface RunProgress {
  /** Null keeps the job's last value. */
  progress: number | null;
  detail: string;
}

const MAX_DETAIL = 200;

/**
 * Load-bearing. TQDM_FRAME is unanchored, so a non-frame line is retried from
 * every position: quadratic in length, on Node's only thread. The cap bounds
 * one line; the pattern's shape bounds each line. Measured on 64 KB of
 * lm_eval-like output:
 *
 *                                 one 64 KB line   64 KB of 500-char lines
 *     cap only, ambiguous pattern         0.2 ms                   7193 ms
 *     pattern only, no cap                3643 ms                    28 ms
 *     both (what this ships)              0.1 ms                     27 ms
 *
 * A real frame is ~66 chars.
 */
const MAX_FRAME_LINE = 512;

/**
 *     Requesting API:  18%|█▊        | 33/180 [13:25<1:54:32, 46.75s/it]
 *
 * Early frames have no rate (`[00:01<?, ?it/s]`). Do not put `\s*` back
 * between the label and `\d+%`: the label already matches whitespace, and the
 * overlap is 250x slower on padded output (see MAX_FRAME_LINE).
 */
const TQDM_FRAME =
  /(?<label>[^|\r\n]*?)\d+%\|[^|]*\|\s*(?<done>\d+)\/(?<total>\d+)\s*\[(?<elapsed>[\d:]+)<(?<remain>[\d:?]+)(?:,\s*(?<rate>[\d.]+)(?<unit>s\/it|it\/s))?/;

/** Detects half a bar split across chunks. */
const BAR_CHARS = /%\||[█-▏]|░|▒|▓/;

function toSeconds(clock: string): number | null {
  if (clock.includes("?")) return null;
  const parts = clock.split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** A duration, never a clock time: the reader may be in another timezone. */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${whole}s`;
}

function formatRate(rate: string, unit: string): string {
  return unit === "s/it" ? `${Number(rate).toFixed(1)}s each` : `${rate}/s`;
}

export function parseTqdmFrame(line: string): RunProgress | null {
  // Before the match: scanning a long line is the expensive part.
  if (line.length > MAX_FRAME_LINE) return null;
  const match = TQDM_FRAME.exec(line);
  if (!match?.groups) return null;

  const { label, done, total, remain, rate, unit } = match.groups;
  const at = Number(done);
  const of = Number(total);
  if (!Number.isFinite(at) || !Number.isFinite(of) || of <= 0) return null;

  const parts = [`${label?.trim() || "progress"} ${at}/${of}`];
  if (rate && unit) parts.push(formatRate(rate, unit));

  // tqdm reports 00:00 on the last frame; "~0s left" reads as a stall.
  const remaining = toSeconds(remain ?? "?");
  if (at < of && remaining !== null && remaining > 0) {
    parts.push(`~${formatDuration(remaining)} left`);
  }

  return {
    progress: Math.min(at / of, 1),
    detail: parts.join(" · ").slice(0, MAX_DETAIL),
  };
}

/**
 * Null means keep what the row says. The newest frame in the chunk wins; with
 * no frame, the last real line (lm_eval's warnings and preamble).
 */
export function readOutputChunk(chunk: string): RunProgress | null {
  const segments = chunk.split(/[\r\n]+/);

  for (let i = segments.length - 1; i >= 0; i--) {
    const frame = parseTqdmFrame(segments[i] ?? "");
    if (frame) return frame;
  }

  const text = segments
    .map((s) => s.trim())
    .filter(Boolean)
    .at(-1);
  if (!text || BAR_CHARS.test(text)) return null;
  return { progress: null, detail: text.slice(0, MAX_DETAIL) };
}

export function caseProgress(
  done: number,
  total: number,
  what: string,
): RunProgress {
  return {
    progress: total > 0 ? Math.min(done / total, 1) : null,
    detail: `case ${done}/${total}: ${what}`.slice(0, MAX_DETAIL),
  };
}
