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

// Server-side task CRUD for the agent's tools. Every write goes through
// TaskSyncStore.push(): it is the only path that assigns revs, and a row with
// a NULL rev is never pulled (docs/SYNC.md → The rev trap). Reads go straight
// to SQL.

export interface ServerTaskStore {
  listTasks(): SyncTask[];
  createTask(input: z.input<typeof createTaskInput>): SyncTask;
  updateTask(id: string, patch: UpdateTaskInput): SyncTask | undefined;
  deleteTask(id: string): boolean;
}

/** Aliases make rows valid SyncTask shapes as read. */
const COLUMNS = `id, user_id AS userId, title, notes, priority, status,
  due_at AS dueAt, created_at AS createdAt, updated_at AS updatedAt,
  deleted_at AS deletedAt, rev`;

export function createServerTaskStore(
  db: Database.Database,
  sync: TaskSyncStore,
): ServerTaskStore {
  const selectLive = db.prepare(
    `SELECT ${COLUMNS} FROM tasks
     WHERE deleted_at IS NULL ORDER BY created_at DESC`,
  );
  const selectById = db.prepare(
    `SELECT ${COLUMNS} FROM tasks WHERE id = ? AND deleted_at IS NULL`,
  );

  const commit = (row: SyncTask): SyncTask => {
    sync.push([row]);
    return selectById.get(row.id) as SyncTask;
  };

  return {
    listTasks: () => selectLive.all() as SyncTask[],

    createTask(input) {
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
      // A fresh updatedAt is what wins the LWW merge in push().
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
      commit({ ...current, deletedAt: now, updatedAt: now });
      return true;
    },
  };
}
