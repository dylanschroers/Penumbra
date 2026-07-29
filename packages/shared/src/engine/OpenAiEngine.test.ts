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

/**
 * The JSON body of the nth *chat* call.
 *
 * Indexed over chat calls rather than all fetches: a turn also reads /v1/models
 * to learn which model is actually serving it, so counting raw calls would tie
 * every assertion here to how many times the engine happens to probe.
 */
function bodyOf(call: number): Record<string, unknown> {
  const chats = mockFetch.mock.calls.filter(
    (c) => !String(c[0]).includes("/v1/models"),
  );
  return JSON.parse(chats[call]?.[1]?.body as string);
}

/** Chat replies for the turn under test, in order. */
let chatQueue: Response[] = [];

/** Script the model's chat replies. The listing is answered separately. */
function queueChat(...replies: Response[]): void {
  chatQueue.push(...replies);
}

beforeEach(() => {
  chatQueue = [];
  mockFetch.mockReset();
  // Routed by URL, not by call order. runAgent asks /v1/models what is loaded
  // before it prompts, so an ordered queue would hand the listing a chat reply
  // and shift every later assertion by one. Tests that care about the listing
  // (getStatus, and the identity tests) override this with mockResolvedValue.
  mockFetch.mockImplementation(async (url: string) =>
    String(url).includes("/v1/models")
      ? res({ data: [{ id: "test-model", loaded: true }] })
      : (chatQueue.shift() ?? answerReply("")),
  );
});

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

  // A stale key is the routine failure — Studio mints a new one on every
  // rotation — and it sends you somewhere completely different from "the
  // backend isn't running", so the two must not collapse together.
  it.each([401, 403])("reports unauthorized on %i", async (status) => {
    mockFetch.mockResolvedValue(res({}, false, status));
    expect(await engine.getStatus()).toEqual({ state: "unauthorized" });
  });

  it("still reports stopped for other errors", async () => {
    mockFetch.mockResolvedValue(res({}, false, 500));
    expect(await engine.getStatus()).toEqual({ state: "stopped" });
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

// A model cannot know which weights are serving it, and a small one asked
// outright will invent an answer that reads exactly like a real one — the bug
// that had Qwen3-1.7B introducing itself as "Penumbra, developed by Anthropic".
// Studio ignores the `model` field of a request, so the configured id is not the
// answer either; only the listing is.
describe("identity in the system prompt", () => {
  /** The system message the turn actually sent. */
  const systemSent = () =>
    (bodyOf(0).messages as Array<{ role: string; content: string }>)[0]
      ?.content;

  it("tells the model which model and backend are serving it", async () => {
    queueChat(answerReply("hi"));
    await collect(engine.runAgent([{ role: "user", content: "x" }]));
    expect(systemSent()).toContain("sys");
    expect(systemSent()).toContain('running as the model "test-model"');
    expect(systemSent()).toContain("test model backend");
  });

  // The configured id is a placeholder for Studio ("unsloth"), so stating it
  // would be the same confident wrongness by a different route.
  it("states the served id, not the configured one", async () => {
    queueChat(answerReply("hi"));
    await collect(engine.runAgent([{ role: "user", content: "x" }]));
    expect(systemSent()).not.toContain('running as the model "m"');
  });

  // Better to say nothing than to assert an identity that may be wrong: the
  // prompt already instructs the model to admit it does not know.
  it("omits the line when the backend cannot be asked", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes("/v1/models")
        ? res({}, false, 503)
        : answerReply("hi"),
    );
    await collect(engine.runAgent([{ role: "user", content: "x" }]));
    expect(systemSent()).toBe("sys");
  });

  it("omits the line when nothing is loaded", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes("/v1/models")
        ? res({ data: [{ id: "on-disk", loaded: false }] })
        : answerReply("hi"),
    );
    await collect(engine.runAgent([{ role: "user", content: "x" }]));
    expect(systemSent()).toBe("sys");
  });
});

describe("runAgent", () => {
  it("yields a single answer and strips <think> blocks", async () => {
    queueChat(answerReply("<think>secret</think>Hello"));
    const events = await collect(
      engine.runAgent([{ role: "user", content: "hi" }]),
    );
    expect(events).toEqual([{ kind: "answer", text: "Hello" }]);
  });

  // The prompt forbids emoji, but a small model appends one anyway the moment a
  // reply turns warm, so the answer is cleaned rather than trusted.
  it.each([
    ["Hello! How can I help? 😊", "Hello! How can I help?"],
    ["Done ✅ and saved", "Done and saved"],
    ["Nice work 👍🏽 today", "Nice work today"],
    ["Ready 👨‍👩‍👧 now", "Ready now"],
  ])("strips emoji from %j", async (raw, cleaned) => {
    queueChat(answerReply(raw));
    const events = await collect(
      engine.runAgent([{ role: "user", content: "hi" }]),
    );
    expect(events).toEqual([{ kind: "answer", text: cleaned }]);
  });

  it("leaves ordinary punctuation and markdown alone", async () => {
    queueChat(answerReply("**Bold**, a list:\n- one\n- two\n\n`code()` 100%"));
    const events = await collect(
      engine.runAgent([{ role: "user", content: "hi" }]),
    );
    expect(events).toEqual([
      {
        kind: "answer",
        text: "**Bold**, a list:\n- one\n- two\n\n`code()` 100%",
      },
    ]);
  });

  it("runs a tool, feeds the result back, then yields the answer", async () => {
    queueChat(toolReply("create_task", '{"title":"x"}'), answerReply("done"));
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
    queueChat(toolReply("create_task", "{bad"), answerReply("done"));
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

    /** Headers of the first request whose URL matches, by endpoint not order. */
    const headersFor = (match: string) =>
      mockFetch.mock.calls.find((c) => String(c[0]).includes(match))?.[1]
        ?.headers;

    await engine.getStatus();
    expect(headersFor("/v1/models")).toMatchObject({
      Authorization: "Bearer sk-test",
    });

    queueChat(answerReply("hi"));
    await collect(engine.runAgent([{ role: "user", content: "x" }]));
    expect(headersFor("/v1/chat/completions")).toMatchObject({
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
    queueChat(answerReply("hi"));
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
    queueChat(answerReply("hi"));
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
