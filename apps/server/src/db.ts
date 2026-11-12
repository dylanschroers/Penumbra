// Schema and merge logic live in ./sync/store.ts.

import { SERVER_DB_FILE } from "@penumbra/shared";
import Database from "better-sqlite3";

export const sqlite: Database.Database = new Database(
  process.env.DB_PATH ?? SERVER_DB_FILE,
);
sqlite.pragma("journal_mode = WAL");
