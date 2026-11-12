// The merge authority: LWW resolution and `rev` assignment (docs/SYNC.md).
// Raw better-sqlite3, not Drizzle, to avoid a second peer-resolved drizzle-orm
// copy clashing with the client's. DDL mirrors the client's 0000/0001
// migrations.

import { randomUUID } from "node:crypto";
import type { SyncTask } from "@penumbra/shared";
import type Database from "better-sqlite3";

export interface TaskSyncStore {
  /**
   * Revs are only meaningful within one database, so clients reconcile on an
   * unfamiliar id (docs/SYNC.md → Epochs).
   */
  readonly instanceId: string;
  pull(since: number): { rows: SyncTask[]; cursor: number; serverId: string };
  push(rows: SyncTask[]): { cursor: number; serverId: string };
}

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

  // A restored backup keeps its id; a new or replaced file gets a new one.
  const instanceId = ((): string => {
    const row = db
      .prepare(`SELECT value FROM meta WHERE key = 'instance_id'`)
      .get() as { value: string } | undefined;
    if (row) return row.value;
    const id = randomUUID();
    db.prepare(`INSERT INTO meta (key, value) VALUES ('instance_id', ?)`).run(
      id,
    );
    return id;
  })();

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

  const applyPush = db.transaction((rows: SyncTask[]): number => {
    let rev = Number((maxRev.get() as { m: number }).m);
    for (const row of rows) {
      const existing = selectUpdatedAt.get(row.id) as
        | { updatedAt: string }
        | undefined;

      // Keep the stored row only if strictly newer; ties go to the incoming write.
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
