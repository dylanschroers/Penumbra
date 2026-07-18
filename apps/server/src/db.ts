// Server-side better-sqlite3 handle for Plane A. Keeps sync v0 to a single file
// with no extra service to run (docs/SYNC.md). The schema, database identity,
// and merge logic live in ./sync/store.ts, which takes this handle — or an
// in-memory one in tests — as a parameter. A later move to Postgres is
// contained to this module plus the store.

import { SERVER_DB_FILE } from "@ghost/shared";
import Database from "better-sqlite3";

export const sqlite: Database.Database = new Database(
  process.env.DB_PATH ?? SERVER_DB_FILE,
);
sqlite.pragma("journal_mode = WAL");
