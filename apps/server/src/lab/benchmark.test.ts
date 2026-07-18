import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SuiteDefinition } from "@ghost/shared";
import { afterEach, describe, expect, it } from "vitest";
import { parseLmEvalResults, runBenchmark } from "./benchmark";

// The personal suite is driven against a real HTTP model server, so the request
// shape and scoring are exercised end to end without a model. The general
// suite's subprocess handling is covered by parseLmEvalResults plus a live
// binary probe in benchmark.lmeval.test.ts.

const personalSuite: SuiteDefinition = {
  id: "ghost-tools-v1",
  kind: "personal",
  label: "Ghost tool calling",
  description: "",
  tasks: [],
};

/** A model server that answers every request the same way. */
function startFakeModel(reply: (body: Record<string, unknown>) => unknown) {
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply(raw ? JSON.parse(raw) : {})));
    });
  });
  return {
    listen: () =>
      new Promise<string>((resolve) =>
        server.listen(0, "127.0.0.1", () =>
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
        ),
      ),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const toolReply = (name: string, args: string) => ({
  choices: [
    {
      message: {
        content: "",
        tool_calls: [{ id: "c1", function: { name, arguments: args } }],
      },
    },
  ],
});

let model: ReturnType<typeof startFakeModel>;
afterEach(() => model?.close());

describe("personal suite", () => {
  it("scores a run and reports rates, not raw counts", async () => {
    // Always answers in prose: every actionable case is a false negative and
    // every chit-chat case is correct.
    model = startFakeModel(() => ({
      choices: [{ message: { content: "I can help with that." } }],
    }));
    const baseURL = await model.listen();

    const result = await runBenchmark({
      model: "fake",
      suite: personalSuite,
      samplesPerTask: 8,
      baseURL,
    });

    expect(result.suiteKind).toBe("personal");
    expect(result.samplesPerTask).toBe(8);

    const by = (task: string) =>
      result.scores.find((s) => s.task === task)?.value;
    // First 8 cases are all create_task/list_tasks, so all are misses.
    expect(by("tool_selection")).toBe(0);
    expect(by("false_negatives")).toBe(1);
    expect(by("false_positives")).toBe(0);
    // Rates are 0..1 so a short run compares against a long one.
    for (const s of result.scores) {
      if (s.metric !== "avg_ms") expect(s.value).toBeLessThanOrEqual(1);
    }
  });

  it("credits a correct tool call", async () => {
    model = startFakeModel(() => toolReply("create_task", '{"title":"x"}'));
    const baseURL = await model.listen();

    const result = await runBenchmark({
      model: "fake",
      suite: personalSuite,
      samplesPerTask: 2, // both create_task cases
      baseURL,
    });
    expect(result.scores.find((s) => s.task === "tool_selection")?.value).toBe(
      1,
    );
    expect(
      result.scores.find((s) => s.task === "arg_json_validity")?.value,
    ).toBe(1);
  });

  it("reports progress per case", async () => {
    model = startFakeModel(() => ({
      choices: [{ message: { content: "hi" } }],
    }));
    const baseURL = await model.listen();
    const lines: string[] = [];

    await runBenchmark({
      model: "fake",
      suite: personalSuite,
      samplesPerTask: 3,
      baseURL,
      onProgress: (l) => lines.push(l),
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("case 1/3");
  });

  // A rejected request scored as "declined to call a tool" would silently
  // report a perfect false-positive rate for a broken endpoint.
  it("fails loudly when the model server errors", async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(500);
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await expect(
      runBenchmark({
        model: "fake",
        suite: personalSuite,
        samplesPerTask: 1,
        baseURL,
      }),
    ).rejects.toThrow("responded 500");
    server.close();
  });
});

describe("parseLmEvalResults", () => {
  const raw = JSON.stringify({
    results: {
      gsm8k: {
        alias: "gsm8k",
        "exact_match,strict-match": 0.42,
        "exact_match_stderr,strict-match": 0.013,
        sample_len: 1,
      },
      ifeval: { alias: "ifeval", "prompt_level_strict_acc,none": 0.31 },
    },
  });

  it("extracts one score per numeric metric", () => {
    const scores = parseLmEvalResults(raw);
    expect(scores).toContainEqual({
      task: "gsm8k",
      metric: "exact_match,strict-match",
      value: 0.42,
    });
    expect(scores).toContainEqual({
      task: "ifeval",
      metric: "prompt_level_strict_acc,none",
      value: 0.31,
    });
  });

  // stderr is a confidence interval, not a score; charting it as one would be
  // actively misleading.
  it("drops stderr entries and non-numeric aliases", () => {
    const metrics = parseLmEvalResults(raw).map((s) => s.metric);
    expect(metrics.some((m) => m.includes("stderr"))).toBe(false);
    expect(metrics).not.toContain("alias");
  });

  // Seen in a live gsm8k run: a row count rendered beside accuracy as "1.000",
  // which reads like a perfect score.
  it("drops sample_len, which is a count rather than a score", () => {
    expect(parseLmEvalResults(raw).map((s) => s.metric)).not.toContain(
      "sample_len",
    );
  });

  it("survives an empty or resultless file", () => {
    expect(parseLmEvalResults("{}")).toEqual([]);
    expect(parseLmEvalResults(JSON.stringify({ results: {} }))).toEqual([]);
  });
});
