// Runs on a Web Worker (background thread). Owns the SQLite database so query
// work never blocks the UI. The main thread talks to it via Comlink — see
// ./client.ts. Besides the task CRUD the UI calls, this also exposes the four
// primitives the sync client drives (collect/clear the outbox, apply pulled
// rows, read the cursor) — see ../sync/SyncClient.ts and docs/SYNC.md.

import * as Comlink from "comlink";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  tasks,
  createTaskInput,
  updateTaskInput,
  type CreateTaskInput,
  type UpdateTaskInput,
  type NewTaskRow,
  type TaskRow,
  type SyncTask,
} from "@ghost/shared";
import { runMigrations } from "./migrator";

// Single-user for now. Every row still carries a userId (see ARCHITECTURE.md →
// "leave the door open for more"), so multi-user later is a query change, not
// a schema migration.
const LOCAL_USER_ID = "local";

// Client-only sync bookkeeping table. Mirrors migration 0002_outbox.sql; it is
// deliberately NOT in the shared schema because the server has no outbox. Each
// local mutation appends the touched row id here; the sync client drains it
// after a successful push.
const outbox = sqliteTable("_outbox", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  rowId: text("row_id").notNull(),
});

// Client-only, mirrors 0003_sync_meta.sql. Holds the id of the server database
// this store last reconciled with; see adoptServer below.
const syncMeta = sqliteTable("_sync_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

const SERVER_ID_KEY = "server_id";

// Minimal shapes for the parts of the sqlite-wasm API we use. The package's
// own types vary across builds, so we pin just what we touch at the WASM
// boundary rather than depend on its full typings.
interface SqliteDb {
  exec(opts: {
    sql: string;
    bind?: unknown[];
    rowMode?: "array";
    returnValue?: "resultRows";
  }): unknown[][];
}
interface SAHPoolUtil {
  OpfsSAHPoolDb: new (filename: string) => SqliteDb;
}

async function init() {
  const sqlite3 = await sqlite3InitModule();

  // Try to use OPFS for persistence, but fall back to browser storage if OPFS
  // APIs are unavailable (e.g., Tauri webview, desktop apps, environments
  // without FileSystem Access API support).
  let sqliteDb: SqliteDb;
  try {
    const poolUtil = (await (
      sqlite3 as unknown as {
        installOpfsSAHPoolVfs(opts: { name: string }): Promise<SAHPoolUtil>;
      }
    ).installOpfsSAHPoolVfs({ name: "ghost" })) satisfies SAHPoolUtil;
    sqliteDb = new poolUtil.OpfsSAHPoolDb("/ghost.db");
  } catch (err) {
    // OPFS not available; use JsStorageDb which persists to browser storage
    // (localStorage/IndexedDB). This allows data to survive app restarts in
    // Tauri and other non-browser environments.
    console.warn(
      "[ghost] OPFS not available, using browser storage database:",
      err instanceof Error ? err.message : String(err),
    );
    const JsStorageDb = (sqlite3 as unknown as { oo1: { JsStorageDb: any } })
      .oo1.JsStorageDb;
    sqliteDb = new JsStorageDb("local");
  }

  // Bridge between SQL strings and the WASM database. `rowMode: "array"` returns
  // each row as an array of column values, which is what Drizzle's proxy wants.
  const rawExec = (sql: string, bind: unknown[] = []): unknown[][] =>
    sqliteDb.exec({ sql, bind, rowMode: "array", returnValue: "resultRows" });

  runMigrations(rawExec);

  // The sqlite-proxy driver: Drizzle builds SQL + params and hands them to this
  // callback. Keeps Drizzle decoupled from the specific SQLite build.
  const db = drizzle(async (sql, params, method) => {
    const rows = rawExec(sql, params);
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  });

  return { db };
}

// Kick off initialization once; every API call awaits it.
const ready = init();

type Db = Awaited<ReturnType<typeof init>>["db"];

/** Record that a row changed locally and needs pushing. */
async function enqueue(db: Db, rowId: string): Promise<void> {
  await db.insert(outbox).values({ rowId });
}

/** LWW upsert of a single sync row, used when applying server changes. Writes
 * only when the row is new or the incoming edit is at least as recent, and
 * never touches the outbox (pulled rows must not bounce back as local dirt). */
async function upsertFromServer(db: Db, row: SyncTask): Promise<boolean> {
  const [existing] = await db
    .select({ updatedAt: tasks.updatedAt })
    .from(tasks)
    .where(eq(tasks.id, row.id));

  // ISO-8601 strings sort chronologically, so a string compare is the LWW test.
  // `>=` lets the server (the merge authority) win ties.
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

const api = {
  /** All live (non-deleted) tasks, newest first. */
  async listTasks(): Promise<TaskRow[]> {
    const { db } = await ready;
    return db
      .select()
      .from(tasks)
      .where(isNull(tasks.deletedAt))
      .orderBy(desc(tasks.createdAt));
  },

  /** Validate input, insert a new task, and return the stored row. */
  async createTask(input: CreateTaskInput): Promise<TaskRow> {
    const { db } = await ready;
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

  /** Apply a partial change to one task and return the updated row. */
  async updateTask(id: string, patch: UpdateTaskInput): Promise<TaskRow> {
    const { db } = await ready;
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

  /** Soft-delete one task: stamp a tombstone so the deletion can sync. The row
   * stays in the table (filtered out of listTasks) until it is pushed. */
  async deleteTask(id: string): Promise<void> {
    const { db } = await ready;
    const now = new Date().toISOString();
    const [deleted] = await db
      .update(tasks)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(tasks.id, id))
      .returning();
    if (!deleted) return; // already gone — nothing to enqueue
    await enqueue(db, id);
  },

  // ---- Sync primitives (driven by ../sync/SyncClient.ts) -------------------

  /** The highest server rev this device has stored — the pull cursor. */
  async getCursor(): Promise<number> {
    const { db } = await ready;
    const [row] = await db
      .select({ max: sql<number>`coalesce(max(${tasks.rev}), 0)` })
      .from(tasks);
    return Number(row?.max ?? 0);
  },

  /** Current state of every locally-dirty row, plus the outbox seqs covering
   * them. The seqs are handed back to clearOutbox after a successful push. */
  async collectOutbox(): Promise<{ seqs: number[]; rows: SyncTask[] }> {
    const { db } = await ready;
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

  /** Drop the given outbox entries after the server has accepted them. */
  async clearOutbox(seqs: number[]): Promise<void> {
    if (seqs.length === 0) return;
    const { db } = await ready;
    await db.delete(outbox).where(inArray(outbox.seq, seqs));
  },

  /** The id of the server database this store last reconciled with, or null if
   * it has never synced (or predates instance ids). */
  async getServerId(): Promise<string | null> {
    const { db } = await ready;
    const [row] = await db
      .select()
      .from(syncMeta)
      .where(eq(syncMeta.key, SERVER_ID_KEY));
    return row?.value ?? null;
  },

  /** Reconcile this store with a new server database (epoch). Revs issued by
   * the old database are meaningless (nulling them also resets the pull cursor
   * to 0), and pushes the old database acknowledged may have died with it, so
   * every row — tombstones included — goes back into the outbox to be
   * re-offered. LWW on both sides makes the re-exchange converge. */
  async adoptServer(serverId: string): Promise<void> {
    const { db } = await ready;
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

  /** Apply rows pulled from the server with last-write-wins. Returns how many
   * rows actually changed locally, so the caller can skip a UI refresh on a
   * no-op pull. */
  async applyServerRows(rows: SyncTask[]): Promise<number> {
    const { db } = await ready;
    let changed = 0;
    for (const row of rows) {
      if (await upsertFromServer(db, row)) changed++;
    }
    return changed;
  },
};

export type DbApi = typeof api;

Comlink.expose(api);
