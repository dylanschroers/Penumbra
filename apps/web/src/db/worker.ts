// Runs on a Web Worker (background thread). Owns the SQLite database so query
// work never blocks the UI. The main thread talks to it via Comlink — see
// ./client.ts. The exposed `api` object grows into the full repository in the
// next step; for now it carries a single health check to prove the chain works.

import * as Comlink from "comlink";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { desc, eq } from "drizzle-orm";
import {
  tasks,
  createTaskInput,
  updateTaskInput,
  type CreateTaskInput,
  type UpdateTaskInput,
  type NewTaskRow,
  type TaskRow,
} from "@ghost/shared";
import { runMigrations } from "./migrator";

// Single-user for now. Every row still carries a userId (see ARCHITECTURE.md →
// "leave the door open for more"), so multi-user later is a query change, not
// a schema migration.
const LOCAL_USER_ID = "local";

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

  // Install the OPFS "SyncAccessHandle Pool" VFS: real on-disk persistence in
  // the browser that, unlike plain OPFS, needs no special COOP/COEP headers.
  const poolUtil = (await (
    sqlite3 as unknown as {
      installOpfsSAHPoolVfs(opts: { name: string }): Promise<SAHPoolUtil>;
    }
  ).installOpfsSAHPoolVfs({ name: "ghost" })) satisfies SAHPoolUtil;

  const sqliteDb = new poolUtil.OpfsSAHPoolDb("/ghost.db");

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

const api = {
  /** All tasks, newest first. */
  async listTasks(): Promise<TaskRow[]> {
    const { db } = await ready;
    return db.select().from(tasks).orderBy(desc(tasks.createdAt));
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
    return updated;
  },

  /** Delete one task by id. */
  async deleteTask(id: string): Promise<void> {
    const { db } = await ready;
    await db.delete(tasks).where(eq(tasks.id, id));
  },
};

export type DbApi = typeof api;

Comlink.expose(api);
