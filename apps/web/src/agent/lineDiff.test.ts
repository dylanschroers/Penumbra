import { describe, expect, it } from "vitest";
import { lineDiff } from "./lineDiff";

const lines = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => `line ${i + from}`).join("\n");

describe("lineDiff", () => {
  it("marks a new file as all additions", () => {
    expect(lineDiff("", "a\nb")).toEqual([
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
    ]);
  });

  it("shows a changed line in place", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
    ]);
  });

  it("collapses long unchanged runs down to the context around a change", () => {
    const before = lines(20);
    const after = before.replace("line 10", "line ten");
    const diff = lineDiff(before, after, 2);
    expect(diff.filter((d) => d.kind === "skip")).toEqual([
      { kind: "skip", text: "7 unchanged lines" },
      { kind: "skip", text: "8 unchanged lines" },
    ]);
    expect(diff.filter((d) => d.kind === "del")).toEqual([
      { kind: "del", text: "line 10" },
    ]);
  });

  it("has nothing but skips when the contents are unchanged", () => {
    expect(lineDiff("a\nb", "a\nb").every((d) => d.kind !== "add")).toBe(true);
  });
});
