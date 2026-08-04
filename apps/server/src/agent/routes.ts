import type { AgentEvent, ChatMessage, Engine } from "@penumbra/shared";
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
});

const promptBody = z.object({ persona: z.string() });

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
}

export function registerAgentRoutes(
  app: FastifyInstance,
  {
    engine,
    targets,
    prompts,
    token = process.env.PENUMBRA_AGENT_TOKEN,
    devices,
  }: AgentRouteOptions,
): void {
  const preHandler = requireAuth({ token, devices });

  // The whole prompt, both halves: "see the system prompt" is not answered by
  // showing only the part that happens to be editable. `policy` is read-only.
  if (prompts) {
    app.get("/agent/prompt", { preHandler }, async () => prompts.current());

    app.put("/agent/prompt", { preHandler }, async (req, reply) => {
      const parsed = promptBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request" });
      }
      const next = prompts.set(parsed.data.persona);
      // Length is the one rule here. The prompt shares a context window with
      // the conversation, and a persona that fills it starves the turn.
      return next ?? reply.code(400).send({ error: "too_long" });
    });

    // Reset. Worth a route of its own: a user who has edited the persona has no
    // other way back to a default that may have improved since they typed.
    app.delete("/agent/prompt", { preHandler }, async () => prompts.clear());
  }

  // Readiness carries the target that produced it. Resolved here rather than
  // left to the client to pair up, so a pill can never show one target's name
  // beside another's state.
  app.get("/agent/status", { preHandler }, async () => {
    const status = await engine.getStatus();
    if (!targets) return status;
    const id = targets.effective("chat");
    const target = targets.list().find((t) => t.id === id);
    return { ...status, target: { id, label: target?.label ?? id } };
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
