import { looksLocalPath, toDatasetSource } from "@penumbra/shared";
import { describe, expect, it } from "vitest";
import { formatWhen, OFFLINE_TAB, SERVER_TABS, TABS } from "./LabModule";

// A new tab is classified by omission: leaving it out of SERVER_TABS silently
// declares it works with no server, and the failure is a tab that stays clickable
// and then shows nothing but a fetch error.
describe("tab gating", () => {
  it("classifies every tab as server-reliant or not", () => {
    const offline = TABS.filter((t) => !SERVER_TABS.has(t));
    expect(offline).toEqual(["datasets"]);
  });

  it("falls back to a tab that survives a dead server", () => {
    expect(TABS).toContain(OFFLINE_TAB);
    expect(SERVER_TABS.has(OFFLINE_TAB)).toBe(false);
  });

  it("leaves something usable when the server is gone", () => {
    expect(TABS.some((t) => !SERVER_TABS.has(t))).toBe(true);
  });
});

// Getting this wrong sends a filesystem path to Studio as a HuggingFace repo id
// (or vice versa), and the training job fails minutes later with an opaque
// error from the other side.
describe("toDatasetSource", () => {
  it("treats owner/name as a HuggingFace repo", () => {
    expect(toDatasetSource("tatsu-lab/alpaca")).toEqual({
      kind: "hf",
      id: "tatsu-lab/alpaca",
    });
  });

  it("treats a relative or absolute path as local", () => {
    expect(toDatasetSource("./bench/trainset.jsonl")).toMatchObject({
      kind: "local",
    });
    // The case the first cut got wrong: an absolute path has a slash but no
    // leading dot, and was being sent as an HF id.
    expect(toDatasetSource("/data/train.jsonl")).toMatchObject({
      kind: "local",
    });
    expect(toDatasetSource("~/train.csv")).toMatchObject({ kind: "local" });
  });

  it("treats a bare data file as local even with no path marker", () => {
    expect(toDatasetSource("trainset.jsonl")).toEqual({
      kind: "local",
      path: "trainset.jsonl",
    });
    expect(toDatasetSource("data.parquet")).toMatchObject({ kind: "local" });
  });

  it("trims whitespace from a pasted value", () => {
    expect(toDatasetSource("  tatsu-lab/alpaca  ")).toEqual({
      kind: "hf",
      id: "tatsu-lab/alpaca",
    });
  });
});

// A false negative here is what makes a run fail: the file is never uploaded to
// the training host, and Studio is handed a path that only this device can read.
describe("looksLocalPath", () => {
  it("recognizes posix and drive-letter paths", () => {
    expect(looksLocalPath("/data/train.jsonl")).toBe(true);
    expect(looksLocalPath("~/train.csv")).toBe(true);
    expect(looksLocalPath("F:\\Projects\\train.jsonl")).toBe(true);
    expect(looksLocalPath("F:/Projects/train.jsonl")).toBe(true);
  });

  // The regression: Windows `canonicalize` hands back a verbatim path, which
  // matched none of the original branches and so skipped the upload entirely.
  it("recognizes Windows verbatim and UNC paths", () => {
    expect(looksLocalPath("\\\\?\\F:\\Projects\\attack_blueteam.jsonl")).toBe(
      true,
    );
    expect(looksLocalPath("\\\\server\\share\\train.jsonl")).toBe(true);
  });

  it("leaves a HuggingFace id alone", () => {
    expect(looksLocalPath("tatsu-lab/alpaca")).toBe(false);
    expect(looksLocalPath("trainset.jsonl")).toBe(false);
  });
});

// Telling which run is the latest is the whole reason the runs list carries a
// time, so the near ages are the ones that have to read right.
describe("formatWhen", () => {
  const now = Date.parse("2026-07-27T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000;

  it("reads as an age for anything within a week", () => {
    expect(formatWhen(ago(5_000), now)).toBe("just now");
    expect(formatWhen(ago(MIN), now)).toBe("1 min ago");
    expect(formatWhen(ago(12 * MIN), now)).toBe("12 mins ago");
    expect(formatWhen(ago(60 * MIN), now)).toBe("1 hr ago");
    expect(formatWhen(ago(5 * 60 * MIN), now)).toBe("5 hrs ago");
    expect(formatWhen(ago(48 * 60 * MIN), now)).toBe("2 days ago");
  });

  it("falls back to a date once an age stops being useful", () => {
    const old = ago(30 * 24 * 60 * MIN);
    expect(formatWhen(old, now)).toBe(new Date(old).toLocaleDateString());
  });

  // A clock skew between the server and this device must not print "-1 mins".
  it("does not report a future timestamp as a negative age", () => {
    expect(formatWhen(new Date(now + 30_000).toISOString(), now)).toBe(
      "just now",
    );
  });

  it("returns nothing for an unparseable timestamp", () => {
    expect(formatWhen("not a date", now)).toBe("");
  });
});
