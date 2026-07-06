// Plane A sync endpoints for tasks. The server is the merge authority: it
// resolves conflicts last-write-wins and stamps each accepted write with a
// monotonic `rev`, which is what clients use as their pull cursor. See
// docs/SYNC.md for the protocol.

import type { FastifyInstance } from "fastify";
import { pushTasksInput, type SyncTask } from "@ghost/shared";
import { sqlite, instanceId } from "../db";

// Column aliases map snake_case storage to the camelCase SyncTask wire shape, so
// rows read straight out of these statements are already valid sync rows.
const selectSince = sqlite.prepare(`
  SELECT id, user_id AS userId, title, notes, priority, status,
         due_at AS dueAt, created_at AS createdAt, updated_at AS updatedAt,
         deleted_at AS deletedAt, rev
  FROM tasks WHERE rev > ? ORDER BY rev ASC
`);
const selectUpdatedAt = sqlite.prepare(
  `SELECT updated_at AS updatedAt FROM tasks WHERE id = ?`,
);
const maxRev = sqlite.prepare(`SELECT COALESCE(MAX(rev), 0) AS m FROM tasks`);
const upsert = sqlite.prepare(`
  INSERT INTO tasks
    (id, user_id, title, notes, priority, status, due_at,
     created_at, updated_at, deleted_at, rev)
  VALUES
    (@id, @userId, @title, @notes, @priority, @status, @dueAt,
     @createdAt, @updatedAt, @deletedAt, @rev)
  ON CONFLICT(id) DO UPDATE SET
    user_id = excluded.user_id, title = excluded.title, notes = excluded.notes,
    priority = excluded.priority, status = excluded.status,
    due_at = excluded.due_at, created_at = excluded.created_at,
    updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
    rev = excluded.rev
`);

// One transaction per push. Each accepted write takes the next rev, so the
// returned value is the server's high-water cursor after the batch.
const applyPush = sqlite.transaction((rows: SyncTask[]): number => {
  let rev = Number((maxRev.get() as { m: number }).m);
  for (const row of rows) {
    const existing = selectUpdatedAt.get(row.id) as
      | { updatedAt: string }
      | undefined;

    // ISO-8601 strings compare chronologically. Keep the stored row only when
    // it is strictly newer; otherwise the incoming edit wins (ties included).
    if (existing && row.updatedAt < existing.updatedAt) continue;

    rev += 1;
    upsert.run({
      id: row.id,
      userId: row.userId,
      title: row.title,
      notes: row.notes ?? null,
      priority: row.priority,
      status: row.status,
      dueAt: row.dueAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt ?? null,
      rev,
    });
  }
  return rev;
});

export function registerTaskSyncRoutes(app: FastifyInstance): void {
  // Pull: every row whose rev is past the client's cursor, in rev order.
  app.get("/sync/tasks", async (request) => {
    const since = Number((request.query as { since?: string }).since ?? 0);
    const rows = selectSince.all(since) as SyncTask[];
    const last = rows[rows.length - 1];
    return { rows, cursor: last?.rev ?? since, serverId: instanceId };
  });

  // Push: client's dirty rows. Validated against the shared schema, then merged.
  app.post("/sync/tasks", async (request, reply) => {
    const parsed = pushTasksInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const cursor = applyPush(parsed.data.rows);
    return { cursor, serverId: instanceId };
  });
}
