import Fastify from "fastify";
import { createTaskInput } from "@ghost/shared";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok" }));

// Demonstrates the *same* shared Zod schema validating input on the server.
// Persistence (Plane A via Drizzle/SQLite + sync) comes in a later phase.
app.post("/tasks", async (request, reply) => {
  const parsed = createTaskInput.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  return reply.code(201).send({ task: parsed.data });
});

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
