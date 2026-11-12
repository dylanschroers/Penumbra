export interface DiffLine {
  kind: "same" | "add" | "del" | "skip";
  text: string;
}

/** Above this many cells the LCS table is too big to build in the UI thread. */
const MAX_CELLS = 4_000_000;

/**
 * A line diff of `before` to `after`, with unchanged runs longer than
 * 2 × `context` collapsed to a "skip" line. Inputs too large to diff come back
 * as a whole replacement.
 */
export function lineDiff(
  before: string,
  after: string,
  context = 3,
): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const full =
    a.length * b.length > MAX_CELLS
      ? [
          ...a.map((text) => ({ kind: "del" as const, text })),
          ...b.map((text) => ({ kind: "add" as const, text })),
        ]
      : lcsDiff(a, b);
  return collapse(full, context);
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              table[(i + 1) * width + j] ?? 0,
              table[i * width + j + 1] ?? 0,
            );
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] as string });
      i++;
      j++;
    } else if (
      (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)
    ) {
      out.push({ kind: "del", text: a[i++] as string });
    } else {
      out.push({ kind: "add", text: b[j++] as string });
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] as string });
  while (j < m) out.push({ kind: "add", text: b[j++] as string });
  return out;
}

function collapse(lines: DiffLine[], context: number): DiffLine[] {
  const out: DiffLine[] = [];
  let k = 0;
  while (k < lines.length) {
    if (lines[k]?.kind !== "same") {
      out.push(lines[k++] as DiffLine);
      continue;
    }
    let end = k;
    while (end < lines.length && lines[end]?.kind === "same") end++;
    const run = lines.slice(k, end);
    const head = k === 0 ? 0 : context;
    const tail = end === lines.length ? 0 : context;
    if (run.length > head + tail + 1) {
      out.push(...run.slice(0, head));
      out.push({
        kind: "skip",
        text: `${run.length - head - tail} unchanged lines`,
      });
      out.push(...run.slice(run.length - tail));
    } else {
      out.push(...run);
    }
    k = end;
  }
  return out;
}
