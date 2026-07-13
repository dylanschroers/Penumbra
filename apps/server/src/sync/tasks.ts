// Plane A sync HTTP endpoints for tasks. A thin shell over the injectable
// TaskSyncStore (./store): validate the request, delegate to push()/pull().
// The server is the merge authority, but the merge itself lives in the store.
// See docs/SYNC.md for the protocol.

import { pushTasksInput } from "@ghost/shared";
import type { FastifyInstance } from "fastify";
import type { TaskSyncStore } from "./store";

export function registerTaskSyncRoutes(
  app: FastifyInstance,
  store: TaskSyncStore,
): void {
  // Pull: every row whose rev is past the client's cursor, in rev order.
  app.get("/sync/tasks", async (request) => {
    const since = Number((request.query as { since?: string }).since ?? 0);
    return store.pull(since);
  });

  // Push: client's dirty rows. Validated against the shared schema, then merged.
  app.post("/sync/tasks", async (request, reply) => {
    const parsed = pushTasksInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return store.push(parsed.data.rows);
  });
}
