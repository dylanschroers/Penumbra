import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiEngine } from "./OpenAiEngine";
import type { AgentEvent } from "./types";

// The engine's only outside contact is HTTP to the model server, so a mocked
// fetch lets us script the model's replies and assert the loop's behavior
// without a running backend. This covers the protocol for *both* tiers —
// LocalEngine and UnslothEngine add configuration and nothing else.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/** Minimal fetch Response stand-in. */
function res(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** A chat-completion reply carrying tool calls. */
function toolReply(name: string, args: string) {
  return res({
    choices: [
      {
        message: {
          content: "",
          tool_calls: [{ id: "c1", function: { name, arguments: args } }],
        },
      },
    ],
  });
}

/** A chat-completion reply that is a plain answer. */
function answerReply(content: string) {
  return res({ choices: [{ message: { content } }] });
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** An engine with its own mock runTool. Tools are bound at construction, so a
 *  test that asserts on tool execution builds an engine to reach the spy. */
function makeEngine(overrides: { maxToolSteps?: number } = {}) {
  const runTool = vi.fn().mockResolvedValue("ok");
  const engine = new OpenAiEngine({
    bindings: { tools: [], system: "sys", runTool },
    baseURL: "http://test",
    model: "m",
    label: "test model",
    ...overrides,
  });
  return { engine, runTool };
}

/** For tests that never touch a tool. */
const engine = makeEngine().engine;

/** The JSON body of the nth fetch call. */
function bodyOf(call: number): Record<string, unknown> {
  return JSON.parse(mockFetch.mock.calls[call]?.[1]?.body as string);
}

beforeEach(() => mockFetch.mockReset());

describe("getStatus", () => {
  it("reports ready with the loaded model id", async () => {
    mockFetch.mockResolvedValue(res({ data: [{ id: "qwen3" }] }));
    expect(await engine.getStatus()).toEqual({
      state: "ready",
      model: "qwen3",
    });
  });

  it("reports no_model when the server lists none", async () => {
    mockFetch.mockResolvedValue(res({ data: [] }));
    expect(await engine.getStatus()).toEqual({ state: "no_model" });
  });

  // Unsloth Studio lists downloaded-but-unloaded models alongside loaded ones,
  // each carrying a `loaded` flag. Reporting the first entry blindly would show
  // "ready" for a model sitting on disk that cannot serve a completion.
  it("picks the loaded model when the backend flags them", async () => {
    mockFetch.mockResolvedValue(
      res({
        data: [
          { id: "on-disk-only", loaded: false },
          { id: "resident", loaded: true },
        ],
      }),
    );
    expect(await engine.getStatus()).toEqual({
      state: "ready",
      model: "resident",
    });
  });

  it("reports no_model when every listed model is unloaded", async () => {
    mockFetch.mockResolvedValue(
      res({
        data: [
          { id: "a", loaded: false },
          { id: "b", loaded: false },
        ],
      }),
    );
    expect(await engine.getStatus()).toEqual({ state: "no_model" });
  });

  // llama-server omits the flag and lists only what is resident, so the first
  // entry is servable — the Tier-0 behavior must not regress.
  it("uses the first entry when the backend omits the loaded flag", async () => {
    mockFetch.mockResolvedValue(res({ data: [{ id: "qwen3" }, { id: "b" }] }));
    expect(await engine.getStatus()).toEqual({
      state: "ready",
      model: "qwen3",
    });
  });

  it("reports stopped on a non-OK response", async () => {
    mockFetch.mockResolvedValue(res({}, false, 503));
    expect(await engine.getStatus()).toEqual({ state: "stopped" });
  });

  it("reports stopped on a network error", async () => {
    // A refused connection rejects the fetch promise; getStatus' try/catch
    // turns that into a state. Use the ...Once form: the persistent
    // mockRejectedValue leaves Vitest tracking the rejection and flags it as
    // unhandled even though getStatus catches it.
    mockFetch.mockRejectedValueOnce(new Error("refused"));
    expect(await engine.getStatus()).toEqual({ state: "stopped" });
  });
});

describe("runAgent", () => {
  it("yields a single answer and strips <think> blocks", async () => {
    mockFetch.mockResolvedValueOnce(answerReply("<think>secret</think>Hello"));
    const events = await collect(
      engine.runAgent([{ role: "user", content: "hi" }]),
    );
    expect(events).toEqual([{ kind: "answer", text: "Hello" }]);
  });

  it("runs a tool, feeds the result back, then yields the answer", async () => {
    mockFetch
      .mockResolvedValueOnce(toolReply("create_task", '{"title":"x"}'))
      .mockResolvedValueOnce(answerReply("done"));
    const { engine, runTool } = makeEngine();
    const events = await collect(
      engine.runAgent([{ role: "user", content: "add x" }]),
    );

    expect(runTool).toHaveBeenCalledWith("create_task", { title: "x" });
    expect(events).toEqual([
      { kind: "tool", name: "create_task", args: { title: "x" }, result: "ok" },
      { kind: "answer", text: "done" },
    ]);

    // The tool's output must go back to the model, or it answers blind.
    const followUp = bodyOf(1).messages as Array<Record<string, unknown>>;
    expect(followUp.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "ok",
    });
  });

  it("passes empty args to runTool when the model emits malformed JSON", async () => {
    mockFetch
      .mockResolvedValueOnce(toolReply("create_task", "{bad"))
      .mockResolvedValueOnce(answerReply("done"));
    const { engine, runTool } = makeEngine();
    await collect(engine.runAgent([{ role: "user", content: "x" }]));
    expect(runTool).toHaveBeenCalledWith("create_task", {});
  });

  it("throws on a non-OK model response, naming the backend", async () => {
    mockFetch.mockResolvedValue(res({}, false, 500));
    await expect(
      collect(engine.runAgent([{ role: "user", content: "x" }])),
    ).rejects.toThrow("test model responded 500");
  });

  it("stops at the tool-step limit instead of looping forever", async () => {
    // The model asks for a tool on every turn and never answers.
    mockFetch.mockResolvedValue(toolReply("create_task", '{"title":"x"}'));
    const { engine, runTool } = makeEngine();
    const events = await collect(
      engine.runAgent([{ role: "user", content: "x" }]),
    );

    expect(runTool).toHaveBeenCalledTimes(4); // DEFAULT_MAX_TOOL_STEPS
    expect(events.at(-1)).toEqual({
      kind: "answer",
      text: "I hit the tool-step limit before finishing.",
    });
  });

  // Tier 1 wants a larger budget than the small-model default.
  it("honors a configured tool-step limit", async () => {
    mockFetch.mockResolvedValue(toolReply("create_task", '{"title":"x"}'));
    const { engine, runTool } = makeEngine({ maxToolSteps: 7 });
    await collect(engine.runAgent([{ role: "user", content: "x" }]));
    expect(runTool).toHaveBeenCalledTimes(7);
  });
});

// Everything Tier 1 needs beyond Tier 0 is carried by config, so these are the
// tests that keep UnslothEngine honest.
describe("configuration", () => {
  it("sends configured headers on both endpoints", async () => {
    const engine = new OpenAiEngine({
      bindings: { tools: [], system: "sys", runTool: vi.fn() },
      baseURL: "http://studio",
      model: "gpt-oss",
      headers: { Authorization: "Bearer sk-test" },
    });

    mockFetch.mockResolvedValueOnce(res({ data: [{ id: "gpt-oss" }] }));
    await engine.getStatus();
    expect(mockFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer sk-test",
    });

    mockFetch.mockResolvedValueOnce(answerReply("hi"));
    await collect(engine.runAgent([{ role: "user", content: "x" }]));
    expect(mockFetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
    });
  });

  // Unsloth Studio hands client-supplied tools through to the model only while
  // neither flag is set; either one asks Studio to run its OWN tool loop
  // against its MCP registry, silently taking the turn away from Penumbra's
  // server-side tools (studio/backend/routes/inference.py →
  // _explicit_studio_tool_loop_requested). Nothing should ever add these.
  it("never asks the backend to run its own tool loop", async () => {
    mockFetch.mockResolvedValueOnce(answerReply("hi"));
    await collect(engine.runAgent([{ role: "user", content: "x" }]));
    const body = bodyOf(0);
    expect(body).not.toHaveProperty("enable_tools");
    expect(body).not.toHaveProperty("mcp_enabled");
  });

  it("sends the configured model id", async () => {
    const engine = new OpenAiEngine({
      bindings: { tools: [], system: "sys", runTool: vi.fn() },
      baseURL: "http://studio",
      model: "gpt-oss-20b",
    });
    mockFetch.mockResolvedValueOnce(answerReply("hi"));
    await collect(engine.runAgent([{ role: "user", content: "x" }]));
    expect(bodyOf(0).model).toBe("gpt-oss-20b");
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const engine = new OpenAiEngine({
      bindings: { tools: [], system: "sys", runTool: vi.fn() },
      baseURL: "http://studio/",
      model: "m",
    });
    mockFetch.mockResolvedValueOnce(res({ data: [] }));
    await engine.getStatus();
    expect(mockFetch.mock.calls[0]?.[0]).toBe("http://studio/v1/models");
  });
});
