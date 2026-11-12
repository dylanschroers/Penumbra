import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  evalCases,
  labEvalCases,
  labTools,
  type SuiteDefinition,
} from "@penumbra/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  lmEvalEnv,
  parseLmEvalResults,
  runBenchmark,
  watchProcess,
} from "./benchmark";

// The personal suite runs against a real HTTP fake; the general suite is
// covered by parseLmEvalResults and benchmark.lmeval.test.ts.

const personalSuite: SuiteDefinition = {
  id: "penumbra-tools-v2",
  kind: "personal",
  label: "Penumbra tool calling",
  description: "",
  tasks: [],
};

const labSuite: SuiteDefinition = {
  ...personalSuite,
  id: "penumbra-lab-v1",
  label: "Penumbra tool calling, with the Model Lab",
};

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
    // Always prose: every action case is a false negative.
    model = startFakeModel(() => ({
      choices: [{ message: { content: "I can help with that." } }],
    }));
    const baseURL = await model.listen();

    const result = await runBenchmark({
      model: "fake",
      servedModel: "fake",
      target: "local",
      suite: personalSuite,
      samplesPerTask: 8,
      baseURL,
    });

    expect(result.suiteKind).toBe("personal");
    expect(result.samplesPerTask).toBe(8);

    const by = (task: string) =>
      result.scores.find((s) => s.task === task)?.value;
    // A prose-only model must still score: the sample has to reach the negatives,
    // which sit at the end of each set.
    expect(by("tool_selection")).toBeGreaterThan(0);
    expect(by("false_negatives")).toBeLessThan(1);
    expect(by("false_positives")).toBe(0);
    for (const s of result.scores) {
      if (s.metric !== "avg_ms") expect(s.value).toBeLessThanOrEqual(1);
    }
  });

  it("advertises the lab contracts, behind the lab policy", async () => {
    const seen: Record<string, unknown>[] = [];
    model = startFakeModel((body) => {
      seen.push(body);
      return { choices: [{ message: { content: "ok" } }] };
    });
    const baseURL = await model.listen();

    await runBenchmark({
      model: "fake",
      servedModel: "fake",
      target: "local",
      suite: labSuite,
      samplesPerTask: 4,
      baseURL,
    });

    const first = seen[0] as {
      tools: Array<{ function: { name: string } }>;
      messages: Array<{ role: string; content: string }>;
    };
    const names = first.tools.map((t) => t.function.name);
    expect(names).toContain("create_task");
    expect(names).toContain("lab_history");
    expect(names).toContain("start_finetune");
    expect(first.messages[0]?.content).toContain("Model Lab");
  });

  it("keeps the base suite on the base tools", async () => {
    const seen: Record<string, unknown>[] = [];
    model = startFakeModel((body) => {
      seen.push(body);
      return { choices: [{ message: { content: "ok" } }] };
    });
    const baseURL = await model.listen();

    await runBenchmark({
      model: "fake",
      servedModel: "fake",
      target: "local",
      suite: personalSuite,
      samplesPerTask: 2,
      baseURL,
    });

    const first = seen[0] as {
      tools: Array<{ function: { name: string } }>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(first.tools.map((t) => t.function.name)).not.toContain(
      "lab_history",
    );
    expect(first.messages[0]?.content).not.toContain("Model Lab");
  });

  // Both sets put negatives last, so a prefix would miss lab cases and
  // negatives.
  it("samples lab cases and negatives at the default cap", async () => {
    const asked: string[] = [];
    model = startFakeModel((body) => {
      const messages = (body as { messages: Array<{ content: string }> })
        .messages;
      asked.push(messages[1]?.content ?? "");
      return { choices: [{ message: { content: "ok" } }] };
    });
    const baseURL = await model.listen();

    await runBenchmark({
      model: "fake",
      servedModel: "fake",
      target: "local",
      suite: labSuite,
      samplesPerTask: 20,
      baseURL,
    });

    expect(asked).toHaveLength(20);

    // Checked against the case sets, not by matching words.
    const sampled = new Set(asked);
    const picked = [...evalCases, ...labEvalCases].filter((c) =>
      sampled.has(c.text),
    );
    const labToolNames = new Set(labTools.map((t) => t.name));

    expect(
      picked.some((c) => c.tool !== null && labToolNames.has(c.tool)),
    ).toBe(true);
    expect(picked.some((c) => c.tool === null)).toBe(true);
  });

  it("credits a correct tool call", async () => {
    model = startFakeModel(() => toolReply("create_task", '{"title":"x"}'));
    const baseURL = await model.listen();

    const result = await runBenchmark({
      model: "fake",
      servedModel: "fake",
      target: "local",
      suite: personalSuite,
      // One case, so the sample is the first, a create_task utterance.
      samplesPerTask: 1,
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
    const updates: { progress: number | null; detail: string }[] = [];

    await runBenchmark({
      model: "fake",
      servedModel: "fake",
      target: "local",
      suite: personalSuite,
      samplesPerTask: 3,
      baseURL,
      onProgress: (u) => updates.push(u),
    });
    expect(updates).toHaveLength(3);
    expect(updates[0]?.detail).toContain("case 1/3");
    expect(updates.map((u) => u.progress)).toEqual([1 / 3, 2 / 3, 1]);
  });

  // An HTTP error must not score as "declined to call a tool".
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
        servedModel: "fake",
        target: "local",
        suite: personalSuite,
        samplesPerTask: 1,
        baseURL,
      }),
    ).rejects.toThrow("responded 500");
    server.close();
  });
});

// Windows-only failure; pinned because POSIX CI can't see it.
describe("lmEvalEnv", () => {
  it("forces UTF-8 so the child can print its own summary table", () => {
    const env = lmEvalEnv();
    expect(env.PYTHONIOENCODING).toBe("utf-8");
    expect(env.PYTHONUTF8).toBe("1");
  });

  it("passes the bearer through, defaulting to a placeholder", () => {
    expect(lmEvalEnv("sk-real").OPENAI_API_KEY).toBe("sk-real");
    // lm_eval's OpenAI client refuses to start without a key.
    expect(lmEvalEnv().OPENAI_API_KEY).toBe("dummy");
  });
});

function fakeChild(): ChildProcess & { signals: string[] } {
  const child = new EventEmitter() as ChildProcess & { signals: string[] };
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.signals = [];
  child.kill = ((signal?: string) => {
    child.signals.push(signal ?? "SIGTERM");
    setTimeout(() => child.emit("close", null), 0);
    return true;
  }) as ChildProcess["kill"];
  return child;
}

const frame = (pct: number, at: number, of: number) =>
  Buffer.from(
    `Requesting API: ${pct}%|#####     | ${at}/${of} [05:00<05:00, 3.3s/it]\n`,
  );

describe("watchProcess", () => {
  // lm_eval can wedge after reaching 100%, holding the GPU.
  it("kills a child that goes silent past its budget", async () => {
    const child = fakeChild();
    const watched = watchProcess(child, { stallMs: 30 });
    child.stderr?.emit("data", frame(100, 180, 180));
    const outcome = await watched;
    expect(outcome.stalled).toBe(true);
    expect(outcome.progress).toBe(1);
    expect(child.signals).toContain("SIGTERM");
  });

  it("keeps running while output keeps arriving", async () => {
    const child = fakeChild();
    const watched = watchProcess(child, { stallMs: 80 });
    child.stderr?.emit("data", frame(50, 90, 180));
    await new Promise((r) => setTimeout(r, 50));
    child.stderr?.emit("data", frame(60, 108, 180)); // resets the silence clock
    await new Promise((r) => setTimeout(r, 20));
    child.emit("close", 0);
    const outcome = await watched;
    expect(outcome.stalled).toBe(false);
    expect(child.signals).toHaveLength(0);
  });

  it("resolves cleanly when the child exits on its own", async () => {
    const child = fakeChild();
    const watched = watchProcess(child, { stallMs: 1000 });
    child.stderr?.emit("data", frame(100, 5, 5));
    child.emit("close", 0);
    expect(await watched).toMatchObject({
      code: 0,
      stalled: false,
      progress: 1,
    });
    expect(child.signals).toHaveLength(0);
  });

  it("rejects if the process fails to start", async () => {
    const child = fakeChild();
    const watched = watchProcess(child, { stallMs: 1000 });
    child.emit("error", new Error("ENOENT"));
    await expect(watched).rejects.toThrow("ENOENT");
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

  // stderr is a confidence interval, not a score.
  it("drops stderr entries and non-numeric aliases", () => {
    const metrics = parseLmEvalResults(raw).map((s) => s.metric);
    expect(metrics.some((m) => m.includes("stderr"))).toBe(false);
    expect(metrics).not.toContain("alias");
  });

  // sample_len is a row count; a live run showed it as "1.000".
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
