import type { AgentEvent, ChatMessage, Engine } from "@penumbra/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../http/auth";

// The Tier-1 agent's HTTP surface. Two routes: readiness for the status pill,
// and a chat turn that streams tool runs as they happen.
//
// These are a different class of endpoint from /sync/tasks: an *actuator* that
// runs a model with write and delete tools and costs GPU. They sit behind
// ../http/auth, shared with the lab routes.

const chatBody = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    }),
  ),
});

export interface AgentRouteOptions {
  engine: Engine;
  /** Shared secret; when unset the routes serve loopback only. */
  token?: string;
}

export function registerAgentRoutes(
  app: FastifyInstance,
  { engine, token = process.env.PENUMBRA_AGENT_TOKEN }: AgentRouteOptions,
): void {
  const preHandler = requireAuth(token);

  app.get("/agent/status", { preHandler }, async () => engine.getStatus());

  app.post("/agent/chat", { preHandler }, async (req, reply) => {
    const parsed = chatBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request" });
    }
    const messages = parsed.data.messages as ChatMessage[];

    // Server-Sent Events: one JSON event per line-pair. The turn is short and
    // non-streaming per step, but tool runs must surface as they happen rather
    // than all at once when the answer lands.
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // A client that disconnects must not leave a model generating and tools
    // firing. Partial effects stand — already-executed tool writes are not
    // rolled back — and the events already sent are the record of what ran
    // (docs/UNSLOTH_TIER1_PLAN.md → Phase 4).
    const controller = new AbortController();
    req.raw.on("close", () => controller.abort());

    const send = (event: string, data: unknown): void => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    try {
      for await (const ev of engine.runAgent(messages, controller.signal)) {
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
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });
}
