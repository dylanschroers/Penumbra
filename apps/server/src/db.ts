// Server-side store for Plane A. SQLite (better-sqlite3) keeps sync v0 to a
// single file with no extra service to run — see docs/SYNC.md. The server uses
// the driver directly rather than Drizzle: it owns exactly one table, and
// staying off Drizzle here avoids pulling a second, peer-resolved copy of
// drizzle-orm into the workspace that would clash with the client's. The shared
// Zod schema still governs the wire format, so the two stores cannot drift.
//
// The DDL below mirrors the client migrations 0000_init + 0001_add_sync_columns.
// A later move to Postgres is contained to this module.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export const sqlite: Database.Database = new Database(
  process.env.DB_PATH ?? "ghost-server.db",
);
sqlite.pragma("journal_mode = WAL");

sqlite.exec(`
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

// The identity of this database, minted once at creation and returned with
// every sync response. Revs are only meaningful relative to the database that
// issued them, so a client that sees an unfamiliar id knows its cursor and
// cleared outbox belong to a dead epoch and must reconcile (see docs/SYNC.md).
// A restored backup keeps its id (its revs are still valid); a fresh or
// replaced file gets a new one.
export const instanceId: string = (() => {
  const row = sqlite
    .prepare(`SELECT value FROM meta WHERE key = 'instance_id'`)
    .get() as { value: string } | undefined;
  if (row) return row.value;
  const id = randomUUID();
  sqlite
    .prepare(`INSERT INTO meta (key, value) VALUES ('instance_id', ?)`)
    .run(id);
  return id;
})();
