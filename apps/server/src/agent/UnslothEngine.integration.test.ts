import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { taskTools, toToolSpec } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnslothEngine } from "./UnslothEngine";

// The unit tests stub fetch, so they prove the engine assembles the right
// arguments but never that a turn survives real HTTP. This file runs the engine
// against an actual OpenAI-compatible server over a socket: real requests, real
// headers, real JSON, real async generator plumbing.
//
// What this DOESN'T prove: that Unsloth Studio behaves the way this fake does.
// The fake is written to the same assumption the engine is
// (docs/UNSLOTH_TIER1_PLAN.md → "Unsloth is on the seam"), so it cannot
// validate that assumption — only a live Studio on the GPU host can. It catches
// our bugs, not our misunderstandings.

interface Recorded {
  url: string;
  auth?: string;
  body: Record<string, unknown>;
}

/** A scriptable stand-in for Studio's /v1 surface. */
function startFakeStudio(replies: unknown[]) {
  const recorded: Recorded[] = [];
  let next = 0;
  /** Resolves the pending response, letting a test hold a request open. */
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
      await gate;
      if (res.destroyed) return; // client aborted while we were held
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(replies[next++] ?? replies.at(-1)));
    });
  });

  return {
    recorded,
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

async function boot(replies: unknown[]) {
  studio = startFakeStudio(replies);
  baseURL = await studio.listen();
}

describe("UnslothEngine over real HTTP", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("probes status and sends the bearer token", async () => {
    await boot([{ data: [{ id: "gpt-oss-20b" }] }]);
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
      // The real specs, so the wire payload is the one Studio will actually be
      // sent rather than a hand-written stand-in.
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

    // Two round trips, and the second carried the tool result back to the model
    // in the role the protocol requires.
    expect(studio.recorded).toHaveLength(2);
    const second = studio.recorded[1]?.body.messages as Array<
      Record<string, unknown>
    >;
    expect(second.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: 'Created task "buy milk".',
    });
    // The system prompt leads every turn, and tool_choice stays auto.
    expect(second[0]).toEqual({ role: "system", content: "sys" });
    expect(studio.recorded[1]?.body.tool_choice).toBe("auto");

    // The real specs survive JSON serialization in the shape the OpenAI seam
    // requires — this is the payload Studio will be handed.
    const wireTools = studio.recorded[0]?.body.tools as Array<{
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

  // Phase 4 depends on this: a client disconnect must abort the server's
  // in-flight turn, which only works if the signal reaches fetch.
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

    // Let the request reach the server, then abort while it is held open.
    await vi.waitFor(() => expect(studio.recorded).toHaveLength(1));
    controller.abort();

    await expect(turn).rejects.toThrow(/abort/i);
    release();
  });
});
