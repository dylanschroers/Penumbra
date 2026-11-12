import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  type ChatMessage,
  type ClientTools,
  clientToolsInput,
  type Engine,
  type GatewayUsage,
} from "@penumbra/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TargetStore } from "../compute/targets";
import type { DeviceStore } from "../devices/store";
import { requireAuth } from "../http/auth";
import { openSseStream } from "../http/sse";
import type { PromptStore } from "./prompt";

// The Tier-1 agent's HTTP surface: readiness for the status pill, a chat turn
// that streams tool runs as they happen, and the editable half of the prompt.
//
// These are a different class of endpoint from /sync/tasks: an *actuator* that
// runs a model with write and delete tools and costs GPU. They sit behind
// ../http/auth, shared with the lab routes. The prompt routes are the same
// class, not a preference pane — what the prompt says decides when those tools
// fire (./prompt).

const chatBody = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    }),
  ),
  client: clientToolsInput.optional(),
});

const toolResultBody = z.object({
  id: z.string().uuid(),
  result: z.string().max(1_000_000),
});

/** How long a forwarded file call may wait on the client. Long, because the
 *  client may be waiting on the user to approve a change. */
const CLIENT_TOOL_TIMEOUT_MS = 10 * 60_000;

/** WebKit, the desktop window's engine, fails a fetch that receives nothing for
 *  60s, and a free model can think for longer than that between events. */
const KEEP_ALIVE_MS = 15_000;

// Both optional and applied independently: the panel saves the cap and the
// persona from one form, and a request carrying only one of them must not blank
// the other. `null` on maxTokens is meaningful — it clears the override and
// hands each tier back its own default.
const promptBody = z.object({
  persona: z.string().optional(),
  maxTokens: z.number().int().nullable().optional(),
});

export interface AgentRouteOptions {
  engine: Engine;
  /** Compute targets, so readiness can say *which* Studio it is reporting on.
   *  Optional: a server with a single fixed backend has nothing to name. */
  targets?: TargetStore;
  /** The editable persona. Optional: without it the routes 404 and every turn
   *  runs the shipped default, which is what a read-only deployment wants. */
  prompts?: PromptStore;
  /** Shared secret; when unset the routes serve loopback only. */
  token?: string;
  /** Issued device tokens, accepted alongside the shared secret. Optional so a
   *  test can stand these routes up without a device store. */
  devices?: DeviceStore;
  /** Reads the gateway's limits and today's totals. Absent without a gateway,
   *  and then /agent/usage answers 404. */
  gatewayUsage?: () => Promise<GatewayUsage>;
  /** How often a quiet chat stream gets a keep-alive comment. */
  keepAliveMs?: number;
}

export function registerAgentRoutes(
  app: FastifyInstance,
  {
    engine,
    targets,
    prompts,
    token = process.env.PENUMBRA_AGENT_TOKEN,
    devices,
    gatewayUsage,
    keepAliveMs = KEEP_ALIVE_MS,
  }: AgentRouteOptions,
): void {
  const preHandler = requireAuth({ token, devices });

  // File calls forwarded to a client, waiting for its POST /agent/tool-result.
  const pendingClientCalls = new Map<string, (result: string) => void>();

  app.post("/agent/tool-result", { preHandler }, async (req, reply) => {
    const parsed = toolResultBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request" });
    }
    const resolve = pendingClientCalls.get(parsed.data.id);
    if (!resolve) return reply.code(404).send({ error: "unknown_call" });
    resolve(parsed.data.result);
    return { ok: true };
  });

  // The whole prompt, both halves: "see the system prompt" is not answered by
  // showing only the part that happens to be editable. `policy` is read-only.
  if (prompts) {
    app.get("/agent/prompt", { preHandler }, async () => prompts.current());

    app.put("/agent/prompt", { preHandler }, async (req, reply) => {
      const parsed = promptBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request" });
      }
      // One call, so a patch is all-or-nothing. Applying the fields in turn
      // saved the persona before refusing the cap, and a 400 that has already
      // changed something is a lie about the request.
      const result = prompts.update(parsed.data);
      return result.ok
        ? result.state
        : reply.code(400).send({ error: result.error });
    });

    // Reset. Worth a route of its own: a user who has edited the persona has no
    // other way back to a default that may have improved since they typed.
    app.delete("/agent/prompt", { preHandler }, async () => prompts.clear());
  }

  // Readiness carries the target that produced it. Resolved here rather than
  // left to the client to pair up, so a pill can never show one target's name
  // beside another's state. An engine that names its own target (the gateway)
  // is not on a Studio, so the chat assignment does not describe it.
  app.get("/agent/status", { preHandler }, async () => {
    const status = await engine.getStatus();
    if (!targets || status.target) return status;
    const id = targets.effective("chat");
    const target = targets.list().find((t) => t.id === id);
    return { ...status, target: { id, label: target?.label ?? id } };
  });

  app.get("/agent/usage", { preHandler }, async (req, reply) => {
    if (!gatewayUsage) return reply.code(404).send({ error: "no_gateway" });
    try {
      return await gatewayUsage();
    } catch (err) {
      req.log.warn(err);
      return reply.code(502).send({ error: "gateway_unavailable" });
    }
  });

  app.post("/agent/chat", { preHandler }, async (req, reply) => {
    const parsed = chatBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request" });
    }
    const messages = parsed.data.messages as ChatMessage[];

    // Server-Sent Events: one JSON event per line-pair. The turn is short and
    // non-streaming per step, but tool runs must surface as they happen rather
    // than all at once when the answer lands.
    openSseStream(reply);

    // A client that disconnects must not leave a model generating and tools
    // firing. Partial effects stand — already-executed tool writes are not
    // rolled back — and the events already sent are the record of what ran
    // (docs/AGENT_DESIGN.md §5).
    // The response's close, not the request's: the request emits it once its
    // body has been read, before this listener exists, so it never reported a
    // dropped connection and an abandoned turn kept calling the model.
    const controller = new AbortController();
    reply.raw.on("close", () => controller.abort());
    const keepAlive = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": keep-alive\n\n");
    }, keepAliveMs);

    const send = (event: string, data: unknown): void => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    // The client's file tools run on the client: each call goes out as a
    // `client_tool` event and the turn waits for the result to be posted back.
    const client = parsed.data.client;
    const clientTools: ClientTools | undefined = client && {
      ...client,
      runTool: (name, args) =>
        new Promise<string>((resolve) => {
          const id = randomUUID();
          const finish = (result: string) => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", stop);
            pendingClientCalls.delete(id);
            resolve(result);
          };
          const stop = () => finish("Stopped.");
          const timer = setTimeout(
            () => finish("The desktop app did not answer this file request."),
            CLIENT_TOOL_TIMEOUT_MS,
          );
          controller.signal.addEventListener("abort", stop, { once: true });
          pendingClientCalls.set(id, finish);
          send("client_tool", { id, name, args });
        }),
    };

    try {
      for await (const ev of engine.runAgent(
        messages,
        controller.signal,
        clientTools,
      )) {
        send("agent", ev satisfies AgentEvent);
      }
      send("done", {});
    } catch (err) {
      // An abort is the client's own doing, so there is nobody left to tell.
      if (!controller.signal.aborted) {
        req.log.error(err);
        send("error", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      clearInterval(keepAlive);
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });
}
