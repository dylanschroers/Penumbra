// Storage identity. Changing any value here silently orphans existing user
// data. Never tie these to the product name; renaming one needs a migration.

/** Keys compose as `${STORAGE_NAMESPACE}.<feature>.<vN>`. */
export const STORAGE_NAMESPACE = "app";

/**
 * Moves a pre-namespace localStorage value to its new key, once. Call before
 * reading `newKey`. An existing `newKey` always wins. No-op without
 * localStorage.
 */
export function migrateStorageKey(oldKey: string, newKey: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    const legacy = localStorage.getItem(oldKey);
    if (legacy === null) return;
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, legacy);
    }
    localStorage.removeItem(oldKey);
  } catch {
    // Non-fatal: the caller falls back to its default.
  }
}

/** Renaming strands the database in the old OPFS directory. */
export const LOCAL_DB_POOL = "local-store";

/** Repeated as a literal in apps/desktop/src-tauri/src/db.rs. */
export const LOCAL_DB_FILE = "local.db";

export const SERVER_DB_FILE = "server.db";

// The Tauri bundle `identifier` (tauri.conf.json) follows the same rule, more
// strictly: the OS keys app_data_dir() off it, so changing it installs a second
// app with empty data. It must never track `productName`.
//
// RELEASE BLOCKER: "local.placeholder.assistant" is a placeholder and must be
// replaced with a project-owned namespace before anyone else installs a build.
