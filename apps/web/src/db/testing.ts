// Test-only. Builds a DbApi backed by an in-memory better-sqlite3 database, so
// the whole storage-agnostic layer (api.ts + migrator.ts) runs for real in a
// test — no mocks, no OPFS, no Tauri IPC. This is the third backing for the one
// `exec(sql, bind) → rows` primitive, alongside the browser's sqlite-wasm
// (worker.ts) and the desktop's native SQLite (tauriExec.ts). Not named
// *.test.ts so Vitest doesn't try to run it as a suite.

import Database from "better-sqlite3";
import { createDbApi, type DbApi } from "./api";
import type { RawExec } from "./migrator";

/** Adapt a better-sqlite3 handle to the RawExec primitive. `stmt.reader` is
 *  true for statements that return rows (SELECT and INSERT/UPDATE/DELETE …
 *  RETURNING); those go through `.all()`. Everything else (DDL, transaction
 *  control, plain writes) goes through `.run()` and yields no rows. `raw(true)`
 *  returns each row as an array of column values — the shape RawExec promises,
 *  matching what the wasm and Rust backends produce. */
export function betterSqliteExec(db: Database.Database): RawExec {
  return (sql, bind = []) => {
    const stmt = db.prepare(sql);
    if (stmt.reader) return stmt.raw(true).all(...bind) as unknown[][];
    stmt.run(...bind);
    return [];
  };
}

/** A fresh in-memory store plus its DbApi. Migrations run lazily inside the
 *  DbApi the first time a method is awaited, so every test starts from a real,
 *  fully-migrated schema. The raw handle is returned too, for tests that need
 *  to inspect the store directly (e.g. that a table does or doesn't exist). */
export function createTestDb(): { db: Database.Database; api: DbApi } {
  const db = new Database(":memory:");
  const api = createDbApi(betterSqliteExec(db));
  return { db, api };
}
