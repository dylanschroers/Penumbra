// Server-side Plane A sync store. The database is *injected* (a parameter),
// not a module-level singleton: production passes the shared better-sqlite3
// handle, tests pass a fresh in-memory one. All the merge authority lives here
// — LWW conflict resolution and monotonic `rev` assignment — while the routes
// in ./tasks.ts are a thin HTTP shell over push()/pull(). See docs/SYNC.md.
//
// The server uses the better-sqlite3 driver directly rather than Drizzle: it
// owns exactly one table, and staying off Drizzle avoids pulling a second,
// peer-resolved copy of drizzle-orm into the workspace that would clash with
// the client's. The shared Zod schema still governs the wire format, so the two
// stores cannot drift. The DDL mirrors client migrations 0000_init +
// 0001_add_sync_columns. A later move to Postgres is contained to this module.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { SyncTask } from "@ghost/shared";

export interface TaskSyncStore {
  /** Identity of this database ("epoch"), returned with every response. Revs
   * are only meaningful within one database's lifetime, so a client that sees
   * an unfamiliar id reconciles (docs/SYNC.md → Epochs). */
  readonly instanceId: string;
  /** Pull: rows with `rev` past `since`, in rev order, plus the new cursor. */
  pull(since: number): { rows: SyncTask[]; cursor: number; serverId: string };
  /** Push: LWW-merge the rows, stamping each accepted write the next `rev`. */
  push(rows: SyncTask[]): { cursor: number; serverId: string };
}

/** Build a sync store over the given database. Ensures the schema and mints (or
 *  reads) the instance id, then prepares its statements against that handle. */
export function createTaskSyncStore(db: Database.Database): TaskSyncStore {
  db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL,
  title text NOT NULL,
  notes text,
  priority text DEFAULT 'medium' NOT NULL,
  status text DEFAULT 'todo' NOT NULL,
  due_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  deleted_at text,
  rev integer
);
CREATE INDEX IF NOT EXISTS tasks_rev_idx ON tasks (rev);
CREATE TABLE IF NOT EXISTS meta (
  key text PRIMARY KEY NOT NULL,
  value text NOT NULL
);
`);

  // Mint once at creation, or read the existing one. A restored backup keeps
  // its id (its revs are still valid); a fresh or replaced file gets a new one.
  const instanceId = ((): string => {
    const row = db
      .prepare(`SELECT value FROM meta WHERE key = 'instance_id'`)
      .get() as { value: string } | undefined;
    if (row) return row.value;
    const id = randomUUID();
    db.prepare(`INSERT INTO meta (key, value) VALUES ('instance_id', ?)`).run(id);
    return id;
  })();

  // Column aliases map snake_case storage to the camelCase SyncTask wire shape,
  // so rows read straight out of this statement are already valid sync rows.
  const selectSince = db.prepare(`
    SELECT id, user_id AS userId, title, notes, priority, status,
           due_at AS dueAt, created_at AS createdAt, updated_at AS updatedAt,
           deleted_at AS deletedAt, rev
    FROM tasks WHERE rev > ? ORDER BY rev ASC
  `);
  const selectUpdatedAt = db.prepare(
    `SELECT updated_at AS updatedAt FROM tasks WHERE id = ?`,
  );
  const maxRev = db.prepare(`SELECT COALESCE(MAX(rev), 0) AS m FROM tasks`);
  const upsert = db.prepare(`
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
  const applyPush = db.transaction((rows: SyncTask[]): number => {
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

  return {
    instanceId,
    pull(since) {
      const rows = selectSince.all(since) as SyncTask[];
      const last = rows[rows.length - 1];
      return { rows, cursor: last?.rev ?? since, serverId: instanceId };
    },
    push(rows) {
      const cursor = applyPush(rows);
      return { cursor, serverId: instanceId };
    },
  };
}
