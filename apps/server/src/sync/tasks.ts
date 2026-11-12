import { pushTasksInput } from "@penumbra/shared";
import type { FastifyInstance } from "fastify";
import type { TaskSyncStore } from "./store";

export function registerTaskSyncRoutes(
  app: FastifyInstance,
  store: TaskSyncStore,
): void {
  app.get("/sync/tasks", async (request) => {
    const since = Number((request.query as { since?: string }).since ?? 0);
    return store.pull(since);
  });

  app.post("/sync/tasks", async (request, reply) => {
    const parsed = pushTasksInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return store.push(parsed.data.rows);
  });
}
