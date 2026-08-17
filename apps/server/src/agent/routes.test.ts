import cors from "@fastify/cors";
import {
  AGENT_MAX_TOKENS_MAX,
  AGENT_PERSONA_DEFAULT,
  AGENT_PERSONA_MAX,
  AGENT_POLICY,
  type AgentEvent,
  type Engine,
} from "@penumbra/shared";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPromptStore } from "./prompt";
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
    expect(res.json().error).toBe("local_only");
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

// The prompt routes are the same class of endpoint as the chat turn, not a
// preference pane: what the prompt says decides when the write and delete tools
// fire, so they sit behind the same gate.
describe("/agent/prompt", () => {
  async function buildWithPrompts(token?: string) {
    app = Fastify();
    const prompts = createPromptStore(new Database(":memory:"));
    registerAgentRoutes(app, {
      engine: fakeEngine([answer]),
      prompts,
      token,
    });
    await app.ready();
    return app;
  }

  it("reports the default, including the half that cannot be edited", async () => {
    const app = await buildWithPrompts();
    const body = (await app.inject({ url: "/agent/prompt" })).json();
    expect(body).toMatchObject({
      persona: AGENT_PERSONA_DEFAULT,
      policy: AGENT_POLICY,
      source: "default",
      maxLength: AGENT_PERSONA_MAX,
    });
  });

  it("stores a persona and reports it back as an override", async () => {
    const app = await buildWithPrompts();
    const res = await app.inject({
      method: "PUT",
      url: "/agent/prompt",
      payload: { persona: "Answer in one sentence." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      persona: "Answer in one sentence.",
      source: "settings",
    });
  });

  it("refuses one past the cap without storing it", async () => {
    const app = await buildWithPrompts();
    const res = await app.inject({
      method: "PUT",
      url: "/agent/prompt",
      payload: { persona: "x".repeat(AGENT_PERSONA_MAX + 1) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "too_long" });
    expect((await app.inject({ url: "/agent/prompt" })).json()).toMatchObject({
      source: "default",
    });
  });

  it("rejects a malformed body", async () => {
    const app = await buildWithPrompts();
    const res = await app.inject({
      method: "PUT",
      url: "/agent/prompt",
      payload: { persona: 42 },
    });
    expect(res.statusCode).toBe(400);
  });

  // The panel saves both fields from one form, so a refusal has to leave the
  // whole request unapplied. This used to store the persona and then answer 400
  // for the cap, which is a status that says nothing happened over a request
  // where something did.
  it("stores neither field when one of them is refused", async () => {
    const app = await buildWithPrompts();
    await app.inject({
      method: "PUT",
      url: "/agent/prompt",
      payload: { persona: "kept", maxTokens: 1024 },
    });

    const res = await app.inject({
      method: "PUT",
      url: "/agent/prompt",
      payload: {
        persona: "should not land",
        maxTokens: AGENT_MAX_TOKENS_MAX + 1,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "out_of_range" });
    expect((await app.inject({ url: "/agent/prompt" })).json()).toMatchObject({
      persona: "kept",
      maxTokens: 1024,
    });
  });

  it("resets to the default", async () => {
    const app = await buildWithPrompts();
    await app.inject({
      method: "PUT",
      url: "/agent/prompt",
      payload: { persona: "custom" },
    });
    const res = await app.inject({ method: "DELETE", url: "/agent/prompt" });
    expect(res.json()).toMatchObject({
      persona: AGENT_PERSONA_DEFAULT,
      source: "default",
    });
  });

  it.each([
    "GET",
    "PUT",
    "DELETE",
  ] as const)("gates %s behind the agent token", async (method) => {
    const app = await buildWithPrompts("sekret");
    const res = await app.inject({
      method,
      url: "/agent/prompt",
      payload: method === "PUT" ? { persona: "x" } : undefined,
    });
    expect(res.statusCode).toBe(401);
  });

  // A deployment that does not want the prompt edited leaves the store out, and
  // every turn runs the shipped default.
  it("is absent when no store is provided", async () => {
    const app = await build(fakeEngine([answer]));
    expect((await app.inject({ url: "/agent/prompt" })).statusCode).toBe(404);
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

  // The stream writes to the raw socket, which bypasses everything Fastify
  // queued on the reply. Without the merge in openSseStream, cors's header is
  // dropped here and *only* here: /agent/status keeps working, the browser
  // discards the chat response before any of it reaches the client, and the
  // turn fails as "Failed to fetch" with nothing naming CORS. Asserted against
  // the real plugin rather than a stub, since the bug was that the plugin's
  // header never reached the socket.
  it("keeps CORS headers on the event stream", async () => {
    app = Fastify();
    await app.register(cors, { origin: true });
    registerAgentRoutes(app, { engine: fakeEngine([answer]) });
    await app.ready();

    const origin = "http://localhost:5173";
    const stream = await app.inject({
      method: "POST",
      url: "/agent/chat",
      headers: { origin },
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(stream.headers["access-control-allow-origin"]).toBe(origin);
    // The stream's own headers still win, and the body is unaffected.
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(parseSse(stream.body)).toEqual([
      ["agent", answer],
      ["done", {}],
    ]);
  });
});
