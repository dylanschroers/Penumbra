import type { AgentEvent, Engine } from "@ghost/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentRoutes } from "./routes";

/** An engine whose turn is scripted, so the routes are tested alone. */
function fakeEngine(
  events: AgentEvent[],
  opts: { hang?: boolean } = {},
): Engine {
  return {
    getStatus: async () => ({ state: "ready", model: "fake" }),
    async *runAgent(_messages, signal) {
      for (const ev of events) yield ev;
      if (opts.hang) {
        // Stay open until the request is aborted, like a slow generation.
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve());
        });
      }
    },
  };
}

let app: FastifyInstance;
afterEach(() => app?.close());

async function build(engine: Engine, token?: string) {
  app = Fastify();
  registerAgentRoutes(app, { engine, token });
  await app.ready();
  return app;
}

const answer: AgentEvent = { kind: "answer", text: "done" };
const toolRun: AgentEvent = {
  kind: "tool",
  name: "create_task",
  args: { title: "x" },
  result: "Created.",
};

describe("auth", () => {
  // An unconfigured server must never expose a write-capable model to the LAN.
  it("serves loopback when no token is configured", async () => {
    const app = await build(fakeEngine([answer]));
    const res = await app.inject({ method: "GET", url: "/agent/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: "ready", model: "fake" });
  });

  it("refuses a non-loopback caller when no token is configured", async () => {
    const app = await build(fakeEngine([answer]));
    const res = await app.inject({
      method: "GET",
      url: "/agent/status",
      remoteAddress: "192.168.1.50",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("agent_local_only");
  });

  it("accepts a remote caller presenting the token", async () => {
    const app = await build(fakeEngine([answer]), "secret");
    const res = await app.inject({
      method: "GET",
      url: "/agent/status",
      remoteAddress: "192.168.1.50",
      headers: { authorization: "Bearer secret" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a wrong or missing token even from loopback", async () => {
    const app = await build(fakeEngine([answer]), "secret");
    expect(
      (await app.inject({ method: "GET", url: "/agent/status" })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/agent/status",
          headers: { authorization: "Bearer wrong" },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("gates the chat route too, not just status", async () => {
    const app = await build(fakeEngine([answer]), "secret");
    const res = await app.inject({
      method: "POST",
      url: "/agent/chat",
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /agent/chat", () => {
  /** Parse an SSE body into [event, data] pairs. */
  function parseSse(body: string): Array<[string, unknown]> {
    return body
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => {
        const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? "";
        const data = /^data: (.*)$/m.exec(chunk)?.[1] ?? "{}";
        return [event, JSON.parse(data)] as [string, unknown];
      });
  }

  it("streams each tool run, then the answer, then done", async () => {
    const app = await build(fakeEngine([toolRun, answer]));
    const res = await app.inject({
      method: "POST",
      url: "/agent/chat",
      payload: { messages: [{ role: "user", content: "add x" }] },
    });

    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(parseSse(res.body)).toEqual([
      ["agent", toolRun],
      ["agent", answer],
      ["done", {}],
    ]);
  });

  it("rejects a malformed body before starting a turn", async () => {
    const runAgent = vi.fn();
    const app = await build({
      getStatus: async () => ({ state: "ready" }),
      runAgent,
    } as unknown as Engine);

    const res = await app.inject({
      method: "POST",
      url: "/agent/chat",
      payload: { messages: [{ role: "system", content: "nope" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("reports an engine failure as an error event", async () => {
    const app = await build({
      getStatus: async () => ({ state: "ready" }),
      runAgent: () => {
        throw new Error("studio responded 500");
      },
    } as unknown as Engine);

    const res = await app.inject({
      method: "POST",
      url: "/agent/chat",
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    const events = parseSse(res.body);
    const last = events[events.length - 1];
    expect(last?.[0]).toBe("error");
    expect(last?.[1]).toMatchObject({
      message: expect.stringContaining("studio responded 500"),
    });
  });
});
