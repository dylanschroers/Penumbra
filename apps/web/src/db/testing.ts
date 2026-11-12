// Test-only in-memory backing for DbApi. Not *.test.ts, so Vitest doesn't run
// it.

import Database from "better-sqlite3";
import { createDbApi, type DbApi } from "./api";
import type { RawExec } from "./migrator";

/**
 * `stmt.reader` statements (SELECT, RETURNING) go through `.all()`; the rest
 * through `.run()`.
 */
export function betterSqliteExec(db: Database.Database): RawExec {
  return (sql, bind = []) => {
    const stmt = db.prepare(sql);
    if (stmt.reader) return stmt.raw(true).all(...bind) as unknown[][];
    stmt.run(...bind);
    return [];
  };
}

export function createTestDb(): { db: Database.Database; api: DbApi } {
  const db = new Database(":memory:");
  const api = createDbApi(betterSqliteExec(db));
  return { db, api };
}
