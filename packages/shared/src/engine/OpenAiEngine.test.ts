import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_MAX_TOKENS_LOCAL,
  AGENT_MAX_TOKENS_MAX,
  AGENT_MAX_TOKENS_MIN,
  OpenAiEngine,
} from "./OpenAiEngine";
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

// A backend that accepts the connection and then goes quiet — its GPU busy
// training, its weights being evicted — used to leave `fetch` pending forever.
// Nothing above ever learned the turn had stalled, so the UI sat on "still
// working" with no error to show and no way to end it.
/** A socket that is open and silent: it settles only when aborted, which is
 *  what a real fetch does — including rejecting at once for a signal that was
 *  already aborted before the call. */
const silentBackend = (_url: string, init: RequestInit = {}) =>
  new Promise((_resolve, reject) => {
    const fail = () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (init.signal?.aborted) return fail();
    init.signal?.addEventListener("abort", fail);
  });

/**
 * A backend that answers 200 and then stalls partway through the body.
 *
 * `fetch` settles on headers, so this is the half of the wedge a deadline
 * released at that point cannot see: the response object arrives, and reading
 * it never finishes. Modelled the way a real one behaves — the body stream
 * belongs to the same signal, so aborting is what ends it.
 */
const stallingBody = async (url: string, init: RequestInit = {}) => {
  if (String(url).includes("/v1/models")) {
    return res({ data: [{ id: "m", loaded: true }] });
  }
  return {
    ok: true,
    status: 200,
    json: () =>
      new Promise((_resolve, reject) => {
        const fail = () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (init.signal?.aborted) return fail();
        init.signal?.addEventListener("abort", fail);
      }),
  } as unknown as Response;
};

describe("a backend that never answers", () => {
  it("fails the turn instead of waiting forever", async () => {
    // Never settles, exactly like a socket that is open and silent.
    mockFetch.mockImplementation(silentBackend);

    const slow = new OpenAiEngine({
      bindings: { tools: [], system: "sys", runTool: vi.fn() },
      baseURL: "http://test",
      model: "m",
      label: "test model",
      statusTimeoutMs: 5,
      requestTimeoutMs: 20,
    });

    await expect(collect(slow.runAgent([]))).rejects.toThrow(
      /did not respond within/,
    );
  });

  // The caller leaving and the backend stalling both surface as an AbortError,
  // and they mean opposite things: one is the user, the other is the fault
  // worth reporting. Reporting a deliberate stop as a timeout would blame the
  // machine for something the person did.
  it("does not report a caller's abort as a timeout", async () => {
    mockFetch.mockImplementation(silentBackend);

    const patient = new OpenAiEngine({
      bindings: { tools: [], system: "sys", runTool: vi.fn() },
      baseURL: "http://test",
      model: "m",
      label: "test model",
      statusTimeoutMs: 5,
      requestTimeoutMs: 60_000,
    });

    const controller = new AbortController();
    const turn = collect(patient.runAgent([], controller.signal));
    controller.abort();
    await expect(turn).rejects.toThrow(/aborted/);
  });

  // The deadline covers reading the reply, not just getting a response object.
  // Releasing it once `fetch` settled left this shape unguarded, which is the
  // same hang one step later: 200, then silence, then nothing above ever
  // learns the turn is dead.
  it("fails a turn whose body never arrives", async () => {
    mockFetch.mockImplementation(stallingBody);

    const slow = new OpenAiEngine({
      bindings: { tools: [], system: "sys", runTool: vi.fn() },
      baseURL: "http://test",
      model: "m",
      label: "test model",
      statusTimeoutMs: 5,
      requestTimeoutMs: 20,
    });

    await expect(
      collect(slow.runAgent([{ role: "user", content: "hi" }])),
    ).rejects.toThrow(/did not respond within/);
  });

  // Same reason the listener is registered at all: a Stop is only real if it
  // reaches whatever the turn is currently blocked on.
  it("lets a caller stop a turn while the body is still arriving", async () => {
    mockFetch.mockImplementation(stallingBody);

    const patient = new OpenAiEngine({
      bindings: { tools: [], system: "sys", runTool: vi.fn() },
      baseURL: "http://test",
      model: "m",
      label: "test model",
      statusTimeoutMs: 5,
      requestTimeoutMs: 60_000,
    });

    const controller = new AbortController();
    const turn = collect(
      patient.runAgent([{ role: "user", content: "hi" }], controller.signal),
    );
    // Let the fetch settle and the read begin before stopping, so this is the
    // body phase rather than the request phase.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(turn).rejects.toThrow(/aborted/);
  });
});

// A reply that hit the token cap ends mid-sentence and is otherwise
// indistinguishable from a finished one — the backend says so in
// `finish_reason`, and that was the only place it was known.
describe("a reply cut off by the token cap", () => {
  it("marks the answer as truncated", async () => {
    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce(res({ data: [{ id: "m" }] }))
      .mockResolvedValueOnce(
        res({
          choices: [
            { message: { content: "**Model Lab (" }, finish_reason: "length" },
          ],
        }),
      );

    const [ev] = await collect(engine.runAgent([]));
    expect(ev).toEqual({
      kind: "answer",
      text: "**Model Lab (",
      truncated: true,
    });
  });

  it("leaves a complete answer unmarked", async () => {
    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce(res({ data: [{ id: "m" }] }))
      .mockResolvedValueOnce(
        res({
          choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        }),
      );

    const [ev] = await collect(engine.runAgent([]));
    expect(ev).toEqual({ kind: "answer", text: "done" });
  });
});

// The cap is user-editable, and Tier 0's engine is built once at page load, so
// a number captured in the constructor would pin the limit to whatever it was
// when the tab opened. A function is read per request instead.
describe("an adjustable reply cap", () => {
  it("sends a fixed cap as given", async () => {
    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce(res({ data: [{ id: "m" }] }))
      .mockResolvedValueOnce(answerReply("hi"));

    const capped = new OpenAiEngine({
      bindings: { tools: [], system: "sys", runTool: vi.fn() },
      baseURL: "http://test",
      model: "m",
      maxTokens: 1234,
    });
    await collect(capped.runAgent([]));

    expect(JSON.parse(mockFetch.mock.calls[1]?.[1]?.body).max_tokens).toBe(
      1234,
    );
  });

  // The server refuses an out-of-range edit, but the cap also arrives from a
  // client's localStorage mirror, which nothing checks at the moment it is
  // read. A ceiling only some paths respect does not bound anything.
  it.each([
    [999_999, AGENT_MAX_TOKENS_MAX],
    [1, AGENT_MAX_TOKENS_MIN],
    [Number.NaN, AGENT_MAX_TOKENS_LOCAL],
  ])("holds a resolver's %j inside the range", async (given, sent) => {
    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce(res({ data: [{ id: "m" }] }))
      .mockResolvedValueOnce(answerReply("hi"));

    const rogue = new OpenAiEngine({
      bindings: { tools: [], system: "sys", runTool: vi.fn() },
      baseURL: "http://test",
      model: "m",
      maxTokens: () => given,
    });
    await collect(rogue.runAgent([]));

    expect(JSON.parse(mockFetch.mock.calls[1]?.[1]?.body).max_tokens).toBe(
      sent,
    );
  });

  it("re-reads a resolver, so an edit reaches the next turn", async () => {
    let cap = 512;
    const adjustable = new OpenAiEngine({
      bindings: { tools: [], system: "sys", runTool: vi.fn() },
      baseURL: "http://test",
      model: "m",
      maxTokens: () => cap,
    });

    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce(res({ data: [{ id: "m" }] }))
      .mockResolvedValueOnce(answerReply("first"));
    await collect(adjustable.runAgent([]));
    expect(JSON.parse(mockFetch.mock.calls[1]?.[1]?.body).max_tokens).toBe(512);

    cap = 4096;
    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce(res({ data: [{ id: "m" }] }))
      .mockResolvedValueOnce(answerReply("second"));
    await collect(adjustable.runAgent([]));
    expect(JSON.parse(mockFetch.mock.calls[1]?.[1]?.body).max_tokens).toBe(
      4096,
    );
  });
});
