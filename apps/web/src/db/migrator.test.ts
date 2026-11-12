/**
 * @vitest-environment node
 */
// Runs under Vitest because the migrator uses import.meta.glob.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { type RawExec, runMigrations } from "./migrator";
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

  it("rolls back a failed migration and recovers on re-run", async () => {
    const db = new Database(":memory:");
    const base = betterSqliteExec(db);

    let injectFault = true;
    const faulty: RawExec = (sql, bind) => {
      if (injectFault && sql.includes("_sync_meta")) {
        throw new Error("disk full");
      }
      return base(sql, bind);
    };

    await expect(runMigrations(faulty)).rejects.toThrow("disk full");

    const tables = tableNames(db);
    expect(tables).toContain("_outbox");
    expect(tables).not.toContain("_sync_meta");

    injectFault = false;
    expect(await runMigrations(faulty)).toEqual(["0003_sync_meta.sql"]);
    expect(tableNames(db)).toContain("_sync_meta");
  });
});
