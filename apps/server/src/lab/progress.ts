// Turning a benchmark's output into something a job row can show.
//
// Both suites report where they are, and neither said so in a form anyone could
// read. The general suite piped raw chunks off lm_eval's pipes straight into the
// job's detail — a carriage-return tqdm frame, truncated mid-bar at 200 chars —
// and never set `progress` at all, so the UI could not draw a bar even in
// principle. A run at 48 seconds a request then looked exactly like a hung one
// for two hours.
//
// Pure functions here, because every hard case is a string shape: the rate
// arrives as `s/it` or `it/s` depending on which side of one-per-second it
// falls, the remaining time is `?` until tqdm has a rate to extrapolate from,
// and a chunk off a pipe holds several frames, or half of one.

/** What a line of output says about a run's position. */
export interface RunProgress {
  /** 0..1 where the output says so, else null — the job keeps its last value
   *  rather than blanking a bar that was correct. */
  progress: number | null;
  /** The line to show, already short enough for a job row. */
  detail: string;
}

/** The job row is one line in a strip; anything longer is not read anyway. */
const MAX_DETAIL = 200;

/**
 * One tqdm frame, as lm-eval writes them:
 *
 *     Requesting API:  18%|█▊        | 33/180 [13:25<1:54:32, 46.75s/it]
 *
 * The trailing group is optional because the first frames carry no rate yet
 * (`[00:01<?, ?it/s]`), and the label is optional because not every bar has a
 * description.
 */
const TQDM_FRAME =
  /(?<label>[^|\r\n]*?)\s*\d+%\|[^|]*\|\s*(?<done>\d+)\/(?<total>\d+)\s*\[(?<elapsed>[\d:]+)<(?<remain>[\d:?]+)(?:,\s*(?<rate>[\d.]+)(?<unit>s\/it|it\/s))?/;

/** A bar's own characters. A chunk boundary can split a frame, and half a
 *  progress bar as the status line is worse than the line it replaced. */
const BAR_CHARS = /%\||[█-▏]|░|▒|▓/;

/** tqdm's `H:MM:SS` or `MM:SS` as seconds, or null for its `?`. */
function toSeconds(clock: string): number | null {
  if (clock.includes("?")) return null;
  const parts = clock.split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * Seconds as a duration worth reading at a glance: `1h58m`, `6m`, `45s`.
 *
 * Deliberately a duration and never a clock time. The detail line is written on
 * the server and read on whatever device has the app open, and "done ~21:55"
 * from another timezone is worse than no estimate at all.
 */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${whole}s`;
}

/** The pace, in whichever direction tqdm chose to report it. */
function formatRate(rate: string, unit: string): string {
  return unit === "s/it" ? `${Number(rate).toFixed(1)}s each` : `${rate}/s`;
}

/**
 * Read one tqdm frame, or null when the line is not one.
 *
 * The frame carries everything the job row wants — position, pace, and how much
 * longer — which is why parsing it beats every alternative: no extra flags on
 * the child, no second channel, and it works for whichever bar lm_eval decides
 * to show for a given task.
 */
export function parseTqdmFrame(line: string): RunProgress | null {
  const match = TQDM_FRAME.exec(line);
  if (!match?.groups) return null;

  const { label, done, total, remain, rate, unit } = match.groups;
  const at = Number(done);
  const of = Number(total);
  if (!Number.isFinite(at) || !Number.isFinite(of) || of <= 0) return null;

  const parts = [`${label?.trim() || "progress"} ${at}/${of}`];
  if (rate && unit) parts.push(formatRate(rate, unit));

  // No estimate on the last frame: "~0s left" on a finished bar reads as a
  // stall, and tqdm reports 00:00 remaining there rather than nothing.
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
 * What one chunk off a child's stdout/stderr is worth showing, or null for
 * "nothing new — keep what the row already says".
 *
 * A chunk is not a line: tqdm redraws with carriage returns, so a single read
 * can hold a dozen frames, and a read can land mid-frame. The newest frame in
 * the chunk wins because the older ones in it are already stale, and a chunk
 * with no frame at all falls back to its last real line — that is where
 * lm_eval's warnings and its "Selected Tasks:" preamble live, which are worth
 * seeing while a run starts up.
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

/** Position through a fixed list of cases, for a suite that counts its own
 *  work rather than shelling out to something that prints a bar. */
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
