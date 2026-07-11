// Desktop storage: the webview sends each SQL statement over Tauri IPC to a
// native SQLite database (a real file in the app data dir) owned by the Rust
// side — see apps/desktop/src-tauri/src/db.rs. Rows come back as arrays of
// column values, the same shape the sqlite-wasm path produces.
//
// Calls are serialized through a promise chain so statement order matches call
// order — the migrator's BEGIN/COMMIT depends on it, and unlike the worker's
// synchronous exec, concurrent IPC calls would otherwise interleave.

import { invoke } from "@tauri-apps/api/core";

let chain: Promise<unknown> = Promise.resolve();

export function tauriExec(
  sql: string,
  bind: unknown[] = [],
): Promise<unknown[][]> {
  const run = chain.then(() =>
    invoke<unknown[][]>("db_exec", { sql, params: bind }),
  );
  // Keep the chain alive after a failure; the caller still sees the rejection.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
