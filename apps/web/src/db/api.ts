// All database logic, on one `exec(sql, bind) → rows` primitive: sqlite-wasm on
// OPFS in a worker (./worker.ts) on web, native SQLite over Tauri IPC
// (./tauriExec.ts) on desktop.

import {
  createTaskInput,
  LOCAL_USER_ID,
  type NewTaskRow,
  type SyncTask,
  type TaskRow,
  tasks,
  type UpdateTaskInput,
  updateTaskInput,
} from "@penumbra/shared";
import { desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { z } from "zod";
import { type RawExec, runMigrations } from "./migrator";

// Shared with the server, which stamps the same owner on agent-created tasks.

// Client-only (0002_outbox.sql); not in the shared schema because the server
// has no outbox.
const outbox = sqliteTable("_outbox", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  rowId: text("row_id").notNull(),
});

// Client-only (0003_sync_meta.sql); see adoptServer.
const syncMeta = sqliteTable("_sync_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

const SERVER_ID_KEY = "server_id";

export function createDbApi(exec: RawExec) {
  const ready = (async () => {
    await runMigrations(exec);

    return drizzle(async (sqlText, params, method) => {
      const rows = await exec(sqlText, params);
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    });
  })();

  type Db = Awaited<typeof ready>;

  async function enqueue(db: Db, rowId: string): Promise<void> {
    await db.insert(outbox).values({ rowId });
  }

  /** LWW. Never touches the outbox, so pulled rows don't bounce back as dirty. */
  async function upsertFromServer(db: Db, row: SyncTask): Promise<boolean> {
    const [existing] = await db
      .select({ updatedAt: tasks.updatedAt })
      .from(tasks)
      .where(eq(tasks.id, row.id));

    // Ties go to the server, the merge authority.
    if (existing && row.updatedAt < existing.updatedAt) return false;

    const values: NewTaskRow = {
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
      rev: row.rev ?? null,
    };

    await db
      .insert(tasks)
      .values(values)
      .onConflictDoUpdate({ target: tasks.id, set: values });
    return true;
  }

  return {
    async listTasks(): Promise<TaskRow[]> {
      const db = await ready;
      return db
        .select()
        .from(tasks)
        .where(isNull(tasks.deletedAt))
        .orderBy(desc(tasks.createdAt));
    },

    /** Takes the schema's input type (priority optional). */
    async createTask(input: z.input<typeof createTaskInput>): Promise<TaskRow> {
      const db = await ready;
      const data = createTaskInput.parse(input); // throws on invalid input
      const now = new Date().toISOString();
      const row: NewTaskRow = {
        id: crypto.randomUUID(),
        userId: LOCAL_USER_ID,
        title: data.title,
        notes: data.notes,
        priority: data.priority,
        status: "todo",
        dueAt: data.dueAt,
        createdAt: now,
        updatedAt: now,
      };
      const [created] = await db.insert(tasks).values(row).returning();
      await enqueue(db, row.id);
      return created!;
    },

    async updateTask(id: string, patch: UpdateTaskInput): Promise<TaskRow> {
      const db = await ready;
      const data = updateTaskInput.parse(patch);
      const [updated] = await db
        .update(tasks)
        .set({ ...data, updatedAt: new Date().toISOString() })
        .where(eq(tasks.id, id))
        .returning();
      if (!updated) throw new Error(`Task not found: ${id}`);
      await enqueue(db, id);
      return updated;
    },

    /** Soft delete: the tombstone syncs. */
    async deleteTask(id: string): Promise<void> {
      const db = await ready;
      const now = new Date().toISOString();
      const [deleted] = await db
        .update(tasks)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(tasks.id, id))
        .returning();
      if (!deleted) return; // already gone — nothing to enqueue
      await enqueue(db, id);
    },

    async getCursor(): Promise<number> {
      const db = await ready;
      const [row] = await db
        .select({ max: sql<number>`coalesce(max(${tasks.rev}), 0)` })
        .from(tasks);
      return Number(row?.max ?? 0);
    },

    /** The seqs go back to clearOutbox after a successful push. */
    async collectOutbox(): Promise<{ seqs: number[]; rows: SyncTask[] }> {
      const db = await ready;
      const entries = await db.select().from(outbox);
      if (entries.length === 0) return { seqs: [], rows: [] };

      const seqs = entries.map((e) => e.seq);
      const ids = [...new Set(entries.map((e) => e.rowId))];
      const rows = (await db
        .select()
        .from(tasks)
        .where(inArray(tasks.id, ids))) as SyncTask[];
      return { seqs, rows };
    },

    async clearOutbox(seqs: number[]): Promise<void> {
      if (seqs.length === 0) return;
      const db = await ready;
      await db.delete(outbox).where(inArray(outbox.seq, seqs));
    },

    /** Null if never synced. */
    async getServerId(): Promise<string | null> {
      const db = await ready;
      const [row] = await db
        .select()
        .from(syncMeta)
        .where(eq(syncMeta.key, SERVER_ID_KEY));
      return row?.value ?? null;
    },

    /**
     * New server database: its old revs are meaningless and acked pushes may be
     * lost, so null every rev (resetting the cursor) and re-enqueue every row,
     * tombstones included. LWW makes the re-exchange converge.
     */
    async adoptServer(serverId: string): Promise<void> {
      const db = await ready;
      await db.update(tasks).set({ rev: null });
      const ids = await db.select({ id: tasks.id }).from(tasks);
      if (ids.length > 0) {
        await db.insert(outbox).values(ids.map(({ id }) => ({ rowId: id })));
      }
      await db
        .insert(syncMeta)
        .values({ key: SERVER_ID_KEY, value: serverId })
        .onConflictDoUpdate({ target: syncMeta.key, set: { value: serverId } });
    },

    /** Returns how many rows changed, so a no-op pull skips the UI refresh. */
    async applyServerRows(rows: SyncTask[]): Promise<number> {
      const db = await ready;
      let changed = 0;
      for (const row of rows) {
        if (await upsertFromServer(db, row)) changed++;
      }
      return changed;
    },
  };
}

export type DbApi = ReturnType<typeof createDbApi>;
