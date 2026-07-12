/**
 * @vitest-environment node
 */
// The browser-side migration runner against a real in-memory SQLite. The
// migrator inlines the .sql files with Vite's import.meta.glob, which is why
// this runs under Vitest (Vite's transform pipeline) and not a bare Node runner.

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, type RawExec } from "./migrator";
import { betterSqliteExec } from "./testing";

function tableNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .raw(true)
    .all()
    .flat() as string[];
}

describe("runMigrations", () => {
  it("applies every migration in filename order on a fresh store", async () => {
    const db = new Database(":memory:");
    const applied = await runMigrations(betterSqliteExec(db));

    expect(applied).toEqual([
      "0000_init.sql",
      "0001_workable_giant_man.sql",
      "0002_outbox.sql",
      "0003_sync_meta.sql",
    ]);
    const tables = tableNames(db);
    expect(tables).toEqual(
      expect.arrayContaining(["tasks", "_outbox", "_sync_meta"]),
    );
  });

  it("is idempotent: a second run applies nothing", async () => {
    const db = new Database(":memory:");
    const exec = betterSqliteExec(db);
    await runMigrations(exec);
    expect(await runMigrations(exec)).toEqual([]);
  });

  // Fault injection: fail the store exactly while migration 0003 runs, then
  // assert the transaction rolled back cleanly and a healthy re-run recovers.
  it("rolls back a failed migration and recovers on re-run", async () => {
    const db = new Database(":memory:");
    const base = betterSqliteExec(db);

    let injectFault = true;
    const faulty: RawExec = (sql, bind) => {
      // The 0003 statement creates _sync_meta; blow up before it commits.
      if (injectFault && sql.includes("_sync_meta")) {
        throw new Error("disk full");
      }
      return base(sql, bind);
    };

    await expect(runMigrations(faulty)).rejects.toThrow("disk full");

    // 0002 committed (its own transaction); 0003 rolled back — no _sync_meta,
    // and it was never recorded as applied.
    const tables = tableNames(db);
    expect(tables).toContain("_outbox");
    expect(tables).not.toContain("_sync_meta");

    injectFault = false;
    expect(await runMigrations(faulty)).toEqual(["0003_sync_meta.sql"]);
    expect(tableNames(db)).toContain("_sync_meta");
  });
});
