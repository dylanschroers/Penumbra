import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { taskTools, toToolSpec } from "@penumbra/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnslothEngine } from "./UnslothEngine";

// Runs the engine against a fake OpenAI-compatible server over a real socket.
// It proves our HTTP plumbing, not that Studio behaves like the fake.

interface Recorded {
  url: string;
  auth?: string;
  body: Record<string, unknown>;
}

/** `replies` scripts the chat endpoint only; `/v1/models` is answered separately. */
function startFakeStudio(
  replies: unknown[],
  models: unknown = { data: [{ id: "gpt-oss-20b", loaded: true }] },
) {
  const recorded: Recorded[] = [];
  let next = 0;
  let gate: Promise<void> = Promise.resolve();

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", async () => {
      recorded.push({
        url: req.url ?? "",
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : {},
      });
      const listing = (req.url ?? "").includes("/v1/models");
      // Only chat requests wait on the gate; the pre-prompt listing never does.
      if (!listing) await gate;
      if (res.destroyed) return; // client aborted while we were held
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(listing ? models : (replies[next++] ?? replies.at(-1))),
      );
    });
  });

  return {
    recorded,
    chats: () => recorded.filter((r) => !r.url.includes("/v1/models")),
    listen: () =>
      new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${port}`);
        });
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    hold: (until: Promise<void>) => {
      gate = until;
    },
  };
}

const answer = (content: string) => ({ choices: [{ message: { content } }] });
const toolCall = (name: string, args: string) => ({
  choices: [
    {
      message: {
        content: "",
        tool_calls: [{ id: "call_1", function: { name, arguments: args } }],
      },
    },
  ],
});

let studio: ReturnType<typeof startFakeStudio>;
let baseURL: string;

afterEach(() => studio?.close());

async function boot(replies: unknown[], models?: unknown) {
  studio = startFakeStudio(replies, models);
  baseURL = await studio.listen();
}

describe("UnslothEngine over real HTTP", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("probes status and sends the bearer token", async () => {
    await boot([], { data: [{ id: "gpt-oss-20b" }] });
    const engine = new UnslothEngine({
      bindings: { tools: [], system: "sys", runTool: vi.fn() },
      baseURL,
      apiKey: "sk-unsloth-live",
    });

    expect(await engine.getStatus()).toEqual({
      state: "ready",
      model: "gpt-oss-20b",
    });
    expect(studio.recorded[0]?.url).toBe("/v1/models");
    expect(studio.recorded[0]?.auth).toBe("Bearer sk-unsloth-live");
  });

  it("completes a tool-using turn end to end", async () => {
    await boot([
      toolCall("create_task", '{"title":"buy milk"}'),
      answer("Added it."),
    ]);
    const runTool = vi.fn().mockResolvedValue('Created task "buy milk".');
    const engine = new UnslothEngine({
      bindings: { tools: taskTools.map(toToolSpec), system: "sys", runTool },
      baseURL,
      apiKey: "sk-test",
    });

    const events = [];
    for await (const ev of engine.runAgent([
      { role: "user", content: "add buy milk" },
    ])) {
      events.push(ev);
    }

    expect(events).toEqual([
      {
        kind: "tool",
        name: "create_task",
        args: { title: "buy milk" },
        result: 'Created task "buy milk".',
      },
      { kind: "answer", text: "Added it." },
    ]);

    expect(studio.chats()).toHaveLength(2);
    const second = studio.chats()[1]?.body.messages as Array<
      Record<string, unknown>
    >;
    expect(second.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: 'Created task "buy milk".',
    });
    expect(second[0]?.role).toBe("system");
    expect(second[0]?.content).toContain("sys");
    expect(second[0]?.content).toContain("gpt-oss-20b");
    expect(studio.chats()[1]?.body.tool_choice).toBe("auto");

    const wireTools = studio.chats()[0]?.body.tools as Array<{
      type: string;
      function: { name: string; description: string; parameters: unknown };
    }>;
    expect(wireTools.map((t) => t.function.name)).toContain("create_task");
    expect(wireTools[0]).toMatchObject({
      type: "function",
      function: {
        description: expect.any(String),
        parameters: expect.any(Object),
      },
    });
  });

  it("aborts an in-flight turn when the signal fires", async () => {
    await boot([answer("never sent")]);
    let release: () => void = () => {};
    studio.hold(new Promise<void>((r) => (release = r)));

    const engine = new UnslothEngine({
      bindings: { tools: [], system: "sys", runTool: vi.fn() },
      baseURL,
    });
    const controller = new AbortController();
    const turn = engine
      .runAgent([{ role: "user", content: "x" }], controller.signal)
      .next();

    await vi.waitFor(() => expect(studio.chats()).toHaveLength(1));
    controller.abort();

    await expect(turn).rejects.toThrow(/abort/i);
    release();
  });
});
