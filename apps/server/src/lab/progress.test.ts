import { describe, expect, it } from "vitest";
import {
  caseProgress,
  formatDuration,
  parseTqdmFrame,
  readOutputChunk,
} from "./progress";

// Strings are real lm_eval output from a live 12B GGUF run.

describe("parseTqdmFrame", () => {
  it("reads position, pace, and what is left", () => {
    const frame = parseTqdmFrame(
      "Requesting API:  18%|█▊        | 33/180 [13:25<1:54:32, 46.75s/it]",
    );
    expect(frame?.progress).toBeCloseTo(33 / 180);
    expect(frame?.detail).toBe(
      "Requesting API: 33/180 · 46.8s each · ~1h54m left",
    );
  });

  // tqdm flips between s/it and it/s at one per second.
  it("reads the it/s form as well as s/it", () => {
    const frame = parseTqdmFrame(
      "Running loglikelihood requests: 50%|█████     | 10/20 [00:03<00:03, 3.50it/s]",
    );
    expect(frame?.progress).toBeCloseTo(0.5);
    expect(frame?.detail).toContain("3.50/s");
  });

  it("keeps the count when there is no estimate yet", () => {
    const frame = parseTqdmFrame("  0%|          | 0/180 [00:00<?, ?it/s]");
    expect(frame?.progress).toBe(0);
    expect(frame?.detail).toBe("progress 0/180");
    expect(frame?.detail).not.toContain("left");
  });

  it("drops the estimate on the last frame", () => {
    const frame = parseTqdmFrame(
      "Requesting API: 100%|██████████| 180/180 [2:24:00<00:00, 48.00s/it]",
    );
    expect(frame?.progress).toBe(1);
    expect(frame?.detail).toBe("Requesting API: 180/180 · 48.0s each");
  });

  it("is null for a line that is not a frame", () => {
    expect(parseTqdmFrame("Selected Tasks: ['gsm8k']")).toBeNull();
    expect(parseTqdmFrame("")).toBeNull();
  });
});

describe("readOutputChunk", () => {
  it("takes the newest frame in a chunk", () => {
    const update = readOutputChunk(
      "\rRequesting API:  18%|█▊  | 33/180 [13:25<1:54:32, 46.75s/it]" +
        "\rRequesting API:  19%|█▉  | 34/180 [14:17<1:58:00, 48.50s/it]",
    );
    expect(update?.detail).toContain("34/180");
  });

  it("falls back to the last real line when there is no frame", () => {
    const update = readOutputChunk(
      "Selected Tasks: ['gsm8k']\nUsing chat template\n",
    );
    expect(update).toEqual({
      progress: null,
      detail: "Using chat template",
    });
  });

  it("reports nothing for a fragment of a bar", () => {
    expect(readOutputChunk("\rRequesting API:  18%|█▊    ")).toBeNull();
    expect(readOutputChunk("\r\n  \n")).toBeNull();
  });

  it("caps a long line to something a row can hold", () => {
    const update = readOutputChunk("x".repeat(500));
    expect(update?.detail).toHaveLength(200);
  });
});

describe("formatDuration", () => {
  it("reads at a glance at every scale", () => {
    // Truncated to match how tqdm displays it.
    expect(formatDuration(6872)).toBe("1h54m");
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(372)).toBe("6m");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(-1)).toBe("0s");
  });
});

describe("caseProgress", () => {
  it("counts a suite that does its own work", () => {
    expect(caseProgress(2, 5, "buy milk")).toEqual({
      progress: 0.4,
      detail: "case 2/5: buy milk",
    });
  });
});

describe("long lines", () => {
  // Matching a non-frame is quadratic in line length and blocks the only
  // thread. Two guards (MAX_FRAME_LINE and the pattern's shape), one test each.
  // Budgets are loose: correct is milliseconds, broken is seconds.
  it("refuses to scan a line far longer than any real frame", () => {
    // Sized so a missing cap costs ~3.5s, well clear of the budget.
    const started = Date.now();
    expect(parseTqdmFrame(`${" ".repeat(64_000)}x`)).toBeNull();
    expect(parseTqdmFrame("x".repeat(64_000))).toBeNull();
    expect(
      parseTqdmFrame(JSON.stringify({ k: "v".repeat(64_000) })),
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("still reads a frame that is merely long-labelled", () => {
    const label = "Requesting API for a task with a rather wordy name";
    const frame = parseTqdmFrame(
      `${label}:  18%|##        | 33/180 [13:25<1:54:32, 46.75s/it]`,
    );
    expect(frame?.progress).toBeCloseTo(33 / 180);
    expect(frame?.detail).toContain("33/180");
  });

  it("does not lose a frame sitting in a chunk beside a long line", () => {
    // Must drop only the long line, not the frame in the same chunk.
    const chunk = `${"noise ".repeat(2_000)}\r  7%|#         | 1/15 [00:01<?, ?it/s]`;
    expect(readOutputChunk(chunk)?.progress).toBeCloseTo(1 / 15);
  });

  it("reads a whole chunk of padded lines that each clear the cap", () => {
    // Every line is under the cap here; this tests the pattern's shape.
    const chunk = Array(128)
      .fill(`${" ".repeat(500)}x`)
      .join("\n");
    const started = Date.now();
    expect(readOutputChunk(chunk)?.detail).toBe("x");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
