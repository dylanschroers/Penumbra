// Calls are serialized: the migrator's BEGIN/COMMIT depends on statement
// order, and concurrent IPC calls would interleave.

import { invoke } from "@tauri-apps/api/core";

let chain: Promise<unknown> = Promise.resolve();

export function tauriExec(
  sql: string,
  bind: unknown[] = [],
): Promise<unknown[][]> {
  const run = chain.then(() =>
    invoke<unknown[][]>("db_exec", { sql, params: bind }),
  );
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
