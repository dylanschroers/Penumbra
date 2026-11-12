// Browser-side `drizzle-kit migrate`: the database lives in OPFS.

/** Sync (sqlite-wasm) and async (Tauri IPC) backends both fit; always await. */
export type RawExec = (
  sql: string,
  bind?: unknown[],
) => unknown[][] | Promise<unknown[][]>;

const files = import.meta.glob("./migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

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
    const statements = files[path]!.split("--> statement-breakpoint")
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
