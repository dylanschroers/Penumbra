import { randomUUID } from "node:crypto";
import {
  createTaskInput,
  LOCAL_USER_ID,
  type SyncTask,
  type UpdateTaskInput,
  updateTaskInput,
} from "@penumbra/shared";
import type Database from "better-sqlite3";
import type { z } from "zod";
import type { TaskSyncStore } from "../sync/store";

// Server-side task CRUD. The client's DbApi (apps/web/src/db/api.ts) has no
// counterpart here: TaskSyncStore is a *replication* interface (pull/push), so
// the agent's tools had nothing to bind to. This is that missing surface.
//
// The one rule that matters: **every write goes through TaskSyncStore.push().**
// Revs are assigned only inside its transaction, and `pull` selects
// `WHERE rev > ?`. A direct INSERT here would leave rev NULL, and the task
// would be invisible to every client forever with no error raised anywhere.
// Routing writes through push keeps a single rev-assigning path and gets LWW
// merge behavior for free. Reads go straight to SQL, since push/pull cannot
// express them (see docs/UNSLOTH_TIER1_PLAN.md §3).

export interface ServerTaskStore {
  /** Live tasks, newest first — the shape the agent's list tool reports. */
  listTasks(): SyncTask[];
  /** Takes the schema's *input* type (priority optional — `.parse` fills its
   *  default), matching the client's createTask. */
  createTask(input: z.input<typeof createTaskInput>): SyncTask;
  /** Returns the updated row, or undefined when no live task has that id. */
  updateTask(id: string, patch: UpdateTaskInput): SyncTask | undefined;
  /** Tombstones the task. False when no live task has that id. */
  deleteTask(id: string): boolean;
}

/** Column aliases map snake_case storage to the camelCase SyncTask shape, so
 *  rows read from these statements are already valid sync rows. */
const COLUMNS = `id, user_id AS userId, title, notes, priority, status,
  due_at AS dueAt, created_at AS createdAt, updated_at AS updatedAt,
  deleted_at AS deletedAt, rev`;

export function createServerTaskStore(
  db: Database.Database,
  sync: TaskSyncStore,
): ServerTaskStore {
  // Tombstoned rows stay in the table so the deletion can sync; they are never
  // part of what the agent sees.
  const selectLive = db.prepare(
    `SELECT ${COLUMNS} FROM tasks
     WHERE deleted_at IS NULL ORDER BY created_at DESC`,
  );
  const selectById = db.prepare(
    `SELECT ${COLUMNS} FROM tasks WHERE id = ? AND deleted_at IS NULL`,
  );

  /** Push one row and read it back with the rev the push assigned. */
  const commit = (row: SyncTask): SyncTask => {
    sync.push([row]);
    return selectById.get(row.id) as SyncTask;
  };

  return {
    listTasks: () => selectLive.all() as SyncTask[],

    createTask(input) {
      // The same schema the client parses, so defaults (priority) and limits
      // land identically on both sides.
      const data = createTaskInput.parse(input);
      const now = new Date().toISOString();
      return commit({
        id: randomUUID(),
        userId: LOCAL_USER_ID,
        title: data.title,
        notes: data.notes ?? null,
        priority: data.priority,
        status: "todo",
        dueAt: data.dueAt ?? null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        rev: null,
      });
    },

    updateTask(id, patch) {
      const current = selectById.get(id) as SyncTask | undefined;
      if (!current) return undefined;
      const data = updateTaskInput.parse(patch);
      // A fresh updatedAt is what makes this edit win the LWW comparison in
      // push(); without it a concurrent client row could suppress the write.
      return commit({
        ...current,
        ...data,
        updatedAt: new Date().toISOString(),
      });
    },

    deleteTask(id) {
      const current = selectById.get(id) as SyncTask | undefined;
      if (!current) return false;
      const now = new Date().toISOString();
      // Soft delete: the tombstone is the thing that syncs.
      commit({ ...current, deletedAt: now, updatedAt: now });
      return true;
    },
  };
}
