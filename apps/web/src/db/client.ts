// Main-thread handle to the local database. `getDb()` returns the platform's
// DbApi and the caller never knows which backing it got:
//   - Browser: a Comlink proxy to ./worker.ts, which runs sqlite-wasm against
//     OPFS off the UI thread.
//   - Tauri: a direct DbApi over ./tauriExec.ts. The heavy work happens in the
//     Rust process (native SQLite on a real file), and Tauri IPC is not
//     reachable from inside a worker anyway.

import * as Comlink from "comlink";
import { createDbApi, type DbApi } from "./api";
import { tauriExec } from "./tauriExec";

// Injected into every Tauri v2 webview; absent in ordinary browsers.
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let worker: Worker | null = null;
let api: DbApi | null = null;

// Lazily create the backend on first use. Deferring creation (rather than
// opening it at import time) lets the single-tab guard decide whether this tab
// owns the local store *before* the worker grabs the exclusive OPFS handles.
//
// Vite compiles ./worker.ts into its own bundle and serves it as a module
// worker. Comlink wraps its exposed api so methods are called with normal
// `await` — the postMessage plumbing is hidden. Every DbApi method already
// returns a promise, so the Comlink remote satisfies the same interface.
export function getDb(): DbApi {
  if (!api) {
    if (isTauri) {
      api = createDbApi(tauriExec);
    } else {
      worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      });
      api = Comlink.wrap<DbApi>(worker) as unknown as DbApi;
    }
  }
  return api;
}

// Terminate the worker, releasing the exclusive OPFS handles so another tab can
// take ownership of the store. Safe to call when nothing is open. (In Tauri
// there is exactly one window and no handle to release; just drop the api.)
export function closeDb(): void {
  worker?.terminate();
  worker = null;
  api = null;
}
