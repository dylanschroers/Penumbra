// Applies the generated SQL migrations to the local SQLite database on startup,
// tracking which have run in a `_migrations` table so each runs exactly once.
// This is the browser-side counterpart to `drizzle-kit migrate` (which can't
// run here because the database lives in OPFS, not on a server).

/** Runs SQL and returns rows as arrays of column values. Sync (sqlite-wasm) and
 *  async (Tauri IPC) backends both satisfy it; callers always await. */
export type RawExec = (
  sql: string,
  bind?: unknown[],
) => unknown[][] | Promise<unknown[][]>;

// Vite inlines every migration file's SQL as a string at build time, so the
// `.sql` files ship inside the worker bundle rather than being fetched.
const files = import.meta.glob("./migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Returns the names of migrations that were applied this run. */
export async function runMigrations(exec: RawExec): Promise<string[]> {
  await exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );

  const applied = new Set(
    (await exec("SELECT name FROM _migrations")).map((row) => String(row[0])),
  );

  const pending = Object.keys(files)
    .sort() // filenames are zero-padded (0000_, 0001_…) so this is run order
    .filter((path) => !applied.has(basename(path)));

  for (const path of pending) {
    const name = basename(path);
    // drizzle-kit separates statements with this marker.
    const statements = files[path]!
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    await exec("BEGIN");
    try {
      for (const statement of statements) await exec(statement);
      await exec("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", [
        name,
        new Date().toISOString(),
      ]);
      await exec("COMMIT");
    } catch (err) {
      await exec("ROLLBACK");
      throw err;
    }
  }

  return pending.map(basename);
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}
