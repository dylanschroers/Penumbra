import { describe, expect, it } from "vitest";
import { SUITES } from "../lab";
import { agentTools, labTools } from "../tools";
import { type EvalCase, evalCases } from "./cases";
import { labEvalCases } from "./labCases";
import { type CaseOutcome, scoreCase, summarize } from "./scoring";
import { toJsonl, toTrainingExamples } from "./trainset";

const outcome = (over: Partial<CaseOutcome> = {}): CaseOutcome => ({
  name: null,
  args: null,
  argsValid: true,
  ms: 10,
  ...over,
});

const score = (c: EvalCase, o: Partial<CaseOutcome>) =>
  scoreCase(c, outcome(o));

describe("cases", () => {
  // A typo'd tool name would silently score every run as a failure.
  it("only expects tools that actually exist", () => {
    const names = new Set(agentTools.map((t) => t.name));
    for (const c of evalCases) {
      if (c.tool !== null) expect(names).toContain(c.tool);
    }
  });

  it("keeps negative cases in the set, since false positives are the risk", () => {
    expect(evalCases.filter((c) => c.tool === null).length).toBeGreaterThan(0);
  });

  // The base set is graded against agentTools alone and is pinned, so a lab
  // utterance landing in it would both fail the check above and silently change
  // what every past penumbra-tools-v1 score means.
  it("keeps lab utterances out of the pinned base set", () => {
    const lab = new Set(labTools.map((t) => t.name));
    for (const c of evalCases) {
      if (c.tool !== null) expect(lab.has(c.tool)).toBe(false);
    }
  });
});

describe("lab cases", () => {
  const serverNames = new Set([...agentTools, ...labTools].map((t) => t.name));

  it("only expects tools the server tier actually advertises", () => {
    for (const c of labEvalCases) {
      if (c.tool !== null) expect(serverNames).toContain(c.tool);
    }
  });

  // The point of the set. A lab tool added with no case is a tool nobody has
  // measured, and the tool count is the thing §7 says to re-measure — so the
  // omission fails here rather than being noticed after a regression ships.
  it("covers every lab tool with at least one case", () => {
    const covered = new Set(labEvalCases.map((c) => c.tool));
    for (const tool of labTools) expect(covered).toContain(tool.name);
  });

  // Crossovers are what a two-domain tool set gets wrong, and they only count
  // if the expected answer is a *base* tool: an utterance full of lab words
  // that must not reach an actuator.
  it("keeps crossovers into the base tools", () => {
    const base = new Set(agentTools.map((t) => t.name));
    const crossovers = labEvalCases.filter(
      (c) => c.tool !== null && base.has(c.tool),
    );
    expect(crossovers.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps negatives drawn from the lab's own subject matter", () => {
    expect(labEvalCases.filter((c) => c.tool === null).length).toBeGreaterThan(
      2,
    );
  });
});

// The general suite runs over an OpenAI-compatible *chat* endpoint, which
// cannot return loglikelihoods. Multiple-choice tasks therefore fail outright
// rather than scoring badly, and every name must resolve in the installed
// harness — the plan's original list did not (see suites.ts).
describe("general suite", () => {
  const general = SUITES.find((s) => s.kind === "general");

  it("names only leaderboard-prefixed or known-generative tasks", () => {
    for (const task of general?.tasks ?? []) {
      expect(task === "gsm8k" || task.startsWith("leaderboard_")).toBe(true);
    }
  });

  it("excludes the multiple-choice tasks a chat endpoint cannot serve", () => {
    const loglikelihoodOnly = [
      "leaderboard_mmlu_pro",
      "leaderboard_bbh",
      "leaderboard_gpqa",
      "leaderboard_musr",
    ];
    for (const task of loglikelihoodOnly) {
      expect(general?.tasks).not.toContain(task);
    }
  });
});

describe("scoreCase", () => {
  const create: EvalCase = { text: "add x", tool: "create_task" };

  it("passes when the expected tool is called", () => {
    expect(score(create, { name: "create_task" }).selectionOk).toBe(true);
  });

  it("fails when a different tool is called", () => {
    expect(score(create, { name: "list_tasks" }).selectionOk).toBe(false);
  });

  it("passes a negative case only when no tool is called", () => {
    const chat: EvalCase = { text: "hi", tool: null };
    expect(score(chat, { name: null }).selectionOk).toBe(true);
    expect(score(chat, { name: "list_tasks" }).selectionOk).toBe(false);
  });

  it("spot-checks declared args", () => {
    const c: EvalCase = { ...create, args: { priority: "high" } };
    expect(
      score(c, { name: "create_task", args: { priority: "high" } }).argsOk,
    ).toBe(true);
    expect(
      score(c, { name: "create_task", args: { priority: "low" } }).argsOk,
    ).toBe(false);
  });

  it("ignores extra args the case does not declare", () => {
    const c: EvalCase = { ...create, args: { priority: "high" } };
    const s = score(c, {
      name: "create_task",
      args: { priority: "high", title: "anything" },
    });
    expect(s.argsOk).toBe(true);
  });

  // Grading a wrong tool's arguments would score them against a schema they
  // were never meant for.
  it("does not grade args when the wrong tool was chosen", () => {
    const c: EvalCase = { ...create, args: { priority: "high" } };
    expect(
      score(c, { name: "list_tasks", args: { priority: "high" } }).argsOk,
    ).toBe(null);
  });
});

describe("summarize", () => {
  const chat: EvalCase = { text: "hi", tool: null };
  const create: EvalCase = { text: "add x", tool: "create_task" };

  it("separates false positives from false negatives", () => {
    const s = summarize([
      score(chat, { name: "list_tasks" }), // called during chit-chat
      score(create, { name: null }), // missed a real action
      score(create, { name: "create_task" }),
    ]);
    expect(s).toMatchObject({
      total: 3,
      selection: 1,
      falsePositives: 1,
      falseNegatives: 1,
    });
  });

  it("counts unparseable tool calls against validity, not selection", () => {
    const s = summarize([
      score(create, { name: "create_task", argsValid: false }),
    ]);
    expect(s.selection).toBe(1);
    expect(s.calls).toBe(1);
    expect(s.validCalls).toBe(0);
  });

  it("reports latency without dividing by zero on an empty run", () => {
    expect(summarize([]).latency).toEqual({ avg: 0, max: 0 });
  });
});

describe("toTrainingExamples", () => {
  const create: EvalCase = { text: "add x", tool: "create_task" };
  const chat: EvalCase = { text: "hi", tool: null };

  it("emits a gold tool call from a correct turn", () => {
    const { examples, skipped } = toTrainingExamples(
      [score(create, { name: "create_task", args: { title: "x" } })],
      "SYS",
    );

    expect(skipped).toEqual([]);
    expect(examples[0]?.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "add x" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            type: "function",
            function: { name: "create_task", arguments: '{"title":"x"}' },
          },
        ],
      },
    ]);
  });

  it("emits the model's own prose for a correct refusal", () => {
    const { examples } = toTrainingExamples(
      [score(chat, { name: null, content: "Hello!" })],
      "SYS",
    );
    expect(examples[0]?.messages.at(-1)).toEqual({
      role: "assistant",
      content: "Hello!",
    });
  });

  // The whole point of rejection sampling: wrong turns must never become
  // training data, or the finetune learns the mistake.
  it("skips a wrong tool choice instead of fabricating a gold call", () => {
    const { examples, skipped } = toTrainingExamples(
      [score(create, { name: "list_tasks" })],
      "SYS",
    );
    expect(examples).toEqual([]);
    expect(skipped[0]?.reason).toContain("wrong tool");
  });

  it("skips a call whose arguments failed the spot-check", () => {
    const c: EvalCase = { ...create, args: { priority: "high" } };
    const { examples, skipped } = toTrainingExamples(
      [score(c, { name: "create_task", args: { priority: "low" } })],
      "SYS",
    );
    expect(examples).toEqual([]);
    expect(skipped[0]?.reason).toBe("args failed spot-check");
  });

  it("skips unparseable arguments", () => {
    const { skipped } = toTrainingExamples(
      [score(create, { name: "create_task", argsValid: false })],
      "SYS",
    );
    expect(skipped[0]?.reason).toBe("unparseable args");
  });

  it("skips a refusal it could not capture text for", () => {
    const { skipped } = toTrainingExamples(
      [score(chat, { name: null, content: "  " })],
      "SYS",
    );
    expect(skipped[0]?.reason).toBe("no assistant content");
  });
});

describe("toJsonl", () => {
  it("writes one parseable object per line", () => {
    const { examples } = toTrainingExamples(
      [
        score(
          { text: "add x", tool: "create_task" },
          { name: "create_task", args: {} },
        ),
        score({ text: "hi", tool: null }, { name: null, content: "Hello!" }),
      ],
      "SYS",
    );
    const lines = toJsonl(examples).split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
