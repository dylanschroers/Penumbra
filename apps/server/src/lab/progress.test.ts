import { describe, expect, it } from "vitest";
import {
  caseProgress,
  formatDuration,
  parseTqdmFrame,
  readOutputChunk,
} from "./progress";

// The strings here are real lm_eval output, taken off a live general-suite run
// against a 12B GGUF (48 seconds a request, 180 requests). That run is the
// reason this module exists: it was two hours of a job row that said nothing a
// person could read, and looked exactly like a hang.

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

  // tqdm flips the rate over once it passes one per second, and a bar that only
  // understood one direction would drop the pace from every fast task.
  it("reads the it/s form as well as s/it", () => {
    const frame = parseTqdmFrame(
      "Running loglikelihood requests: 50%|█████     | 10/20 [00:03<00:03, 3.50it/s]",
    );
    expect(frame?.progress).toBeCloseTo(0.5);
    expect(frame?.detail).toContain("3.50/s");
  });

  // The first frames carry no rate, so there is nothing to extrapolate from.
  // Position is still worth showing, and claiming an estimate would be a lie.
  it("keeps the count when there is no estimate yet", () => {
    const frame = parseTqdmFrame("  0%|          | 0/180 [00:00<?, ?it/s]");
    expect(frame?.progress).toBe(0);
    expect(frame?.detail).toBe("progress 0/180");
    expect(frame?.detail).not.toContain("left");
  });

  // "~0s left" on a finished bar reads as a stall, which is the one thing this
  // line exists to rule out.
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
  // tqdm redraws with carriage returns, so one read off the pipe holds every
  // frame written since the last one. The older ones are already stale.
  it("takes the newest frame in a chunk", () => {
    const update = readOutputChunk(
      "\rRequesting API:  18%|█▊  | 33/180 [13:25<1:54:32, 46.75s/it]" +
        "\rRequesting API:  19%|█▉  | 34/180 [14:17<1:58:00, 48.50s/it]",
    );
    expect(update?.detail).toContain("34/180");
  });

  // Where lm_eval's warnings and its startup preamble live. Worth showing: for
  // the first minute of a run they are the only sign anything is happening.
  it("falls back to the last real line when there is no frame", () => {
    const update = readOutputChunk(
      "Selected Tasks: ['gsm8k']\nUsing chat template\n",
    );
    expect(update).toEqual({
      progress: null,
      detail: "Using chat template",
    });
  });

  // A read can land mid-frame. Half a progress bar as the job's status line is
  // worse than the line it would replace, so the row keeps what it had.
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
    // Truncated, matching the 1:54:32 tqdm showed it as: a minute of rounding
    // either way is noise on a two-hour estimate, and agreeing with the source
    // beats being clever about it.
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
