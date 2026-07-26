import { describe, expect, it } from "vitest";
import { looksLocalPath, toDatasetSource } from "./LabModule";

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
