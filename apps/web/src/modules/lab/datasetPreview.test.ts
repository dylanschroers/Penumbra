import { describe, expect, it } from "vitest";
import { analyzeHead } from "./datasetPreview";

const jsonl = (...records: unknown[]) =>
  records.map((r) => JSON.stringify(r)).join("\n");

describe("analyzeHead — schema detection", () => {
  it("detects Alpaca and maps it to format_type alpaca", () => {
    const head = jsonl(
      { instruction: "Add milk", input: "", output: "Added milk." },
      { instruction: "List tasks", output: "You have 2." },
    );
    const p = analyzeHead(head, "jsonl", false);
    expect(p.schema).toBe("alpaca");
    expect(p.formatType).toBe("alpaca");
    expect(p.trainable).toBe(true);
    expect(p.count).toBe(2);
    expect(p.exact).toBe(true);
    expect(p.issues).toEqual([]);
  });

  it("detects ChatML messages", () => {
    const head = jsonl({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    const p = analyzeHead(head, "jsonl", false);
    expect(p.schema).toBe("chatml");
    expect(p.formatType).toBe("chatml");
  });

  it("maps ShareGPT conversations onto chatml", () => {
    const head = jsonl({
      conversations: [
        { from: "human", value: "hi" },
        { from: "gpt", value: "hello" },
      ],
    });
    const p = analyzeHead(head, "jsonl", false);
    expect(p.schema).toBe("sharegpt");
    expect(p.formatType).toBe("chatml");
  });

  it("flags preference data as untrainable by the SFT path", () => {
    const head = jsonl({ prompt: "q", chosen: "good", rejected: "bad" });
    const p = analyzeHead(head, "jsonl", false);
    expect(p.schema).toBe("preference");
    expect(p.trainable).toBe(false);
    expect(p.issues.some((i) => i.level === "error")).toBe(true);
  });

  it("detects raw text", () => {
    const p = analyzeHead(jsonl({ text: "some corpus line" }), "jsonl", false);
    expect(p.schema).toBe("raw");
    expect(p.formatType).toBe("raw");
  });

  it("detects Alpaca columns in CSV", () => {
    const head = "instruction,output\nAdd milk,Added milk.\nList,Two.";
    const p = analyzeHead(head, "csv", false);
    expect(p.schema).toBe("alpaca");
    expect(p.count).toBe(2);
  });
});

describe("analyzeHead — validation", () => {
  it("reports invalid JSON lines as an error", () => {
    const head = `${JSON.stringify({ instruction: "a", output: "b" })}\n{not json}`;
    const p = analyzeHead(head, "jsonl", false);
    expect(
      p.issues.some(
        (i) => i.level === "error" && /not valid JSON/.test(i.message),
      ),
    ).toBe(true);
  });

  it("warns about empty outputs in Alpaca data", () => {
    const head = jsonl(
      { instruction: "a", output: "" },
      { instruction: "b", output: "ok" },
    );
    const p = analyzeHead(head, "jsonl", false);
    expect(p.issues.some((i) => /empty output/.test(i.message))).toBe(true);
  });

  it("warns about records that don't match the dominant shape", () => {
    const head = jsonl(
      { instruction: "a", output: "1" },
      { instruction: "b", output: "2" },
      { text: "an outlier" },
    );
    const p = analyzeHead(head, "jsonl", false);
    expect(p.schema).toBe("alpaca");
    expect(
      p.issues.some((i) => /don't match the alpaca shape/.test(i.message)),
    ).toBe(true);
  });
});

describe("analyzeHead — truncation and formats", () => {
  it("drops the partial last line of a truncated JSONL head", () => {
    // The second line is cut mid-record; must not count as a parse error.
    const head = `${JSON.stringify({ instruction: "a", output: "b" })}\n{"instruction":"c","outp`;
    const p = analyzeHead(head, "jsonl", true);
    expect(p.count).toBe(1);
    expect(p.exact).toBe(false);
    expect(p.issues.some((i) => /not valid JSON/.test(i.message))).toBe(false);
  });

  it("does not preview parquet but stays trainable", () => {
    const p = analyzeHead("", "parquet", true);
    expect(p.records).toEqual([]);
    expect(p.trainable).toBe(true);
    expect(p.issues[0]?.message).toMatch(/parquet/);
  });

  it("explains a truncated single-array .json instead of erroring", () => {
    const p = analyzeHead('[{"instruction":"a","output":"b"', "json", true);
    expect(p.count).toBe(0);
    expect(p.issues.some((i) => /large array/.test(i.message))).toBe(true);
    expect(p.issues.some((i) => i.level === "error")).toBe(false);
  });
});
