import { describe, expect, it } from "vitest";
import { toDatasetSource } from "./LabModule";

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
