import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentEvent, LocalEngine } from "./LocalEngine";

// The engine's only outside contact is HTTP to the local model, so a mocked
// fetch lets us script the model's replies and assert the loop's behavior
// without a running llama-server.
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

const engine = new LocalEngine("http://test", "m");
const opts = () => ({
  tools: [],
  system: "sys",
  runTool: vi.fn().mockResolvedValue("ok"),
});

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
      engine.runAgent([{ role: "user", content: "hi" }], opts()),
    );
    expect(events).toEqual([{ kind: "answer", text: "Hello" }]);
  });

  it("runs a tool, feeds the result back, then yields the answer", async () => {
    mockFetch
      .mockResolvedValueOnce(toolReply("create_task", '{"title":"x"}'))
      .mockResolvedValueOnce(answerReply("done"));
    const o = opts();
    const events = await collect(
      engine.runAgent([{ role: "user", content: "add x" }], o),
    );

    expect(o.runTool).toHaveBeenCalledWith("create_task", { title: "x" });
    expect(events).toEqual([
      { kind: "tool", name: "create_task", args: { title: "x" }, result: "ok" },
      { kind: "answer", text: "done" },
    ]);
  });

  it("passes empty args to runTool when the model emits malformed JSON", async () => {
    mockFetch
      .mockResolvedValueOnce(toolReply("create_task", "{bad"))
      .mockResolvedValueOnce(answerReply("done"));
    const o = opts();
    await collect(engine.runAgent([{ role: "user", content: "x" }], o));
    expect(o.runTool).toHaveBeenCalledWith("create_task", {});
  });

  it("throws on a non-OK model response", async () => {
    mockFetch.mockResolvedValue(res({}, false, 500));
    await expect(
      collect(engine.runAgent([{ role: "user", content: "x" }], opts())),
    ).rejects.toThrow("local model responded 500");
  });

  it("stops at the tool-step limit instead of looping forever", async () => {
    // The model asks for a tool on every turn and never answers.
    mockFetch.mockResolvedValue(toolReply("create_task", '{"title":"x"}'));
    const o = opts();
    const events = await collect(
      engine.runAgent([{ role: "user", content: "x" }], o),
    );

    expect(o.runTool).toHaveBeenCalledTimes(4); // MAX_TOOL_STEPS
    expect(events.at(-1)).toEqual({
      kind: "answer",
      text: "I hit the tool-step limit before finishing.",
    });
  });
});
