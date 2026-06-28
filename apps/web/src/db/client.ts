// Main-thread handle to the database worker. `Comlink.wrap` turns the worker's
// exposed `api` into an object whose methods you call with normal `await` —
// the postMessage plumbing is hidden. Call `getDb()` anywhere in the UI.

import * as Comlink from "comlink";
import type { DbApi } from "./worker";

let worker: Worker | null = null;
let api: Comlink.Remote<DbApi> | null = null;

// Lazily spawn the database worker on first use. Deferring creation (rather than
// opening it at import time) lets the single-tab guard decide whether this tab
// owns the local store *before* the worker grabs the exclusive OPFS handles.
//
// Vite compiles ./worker.ts into its own bundle and serves it as a module
// worker. `import type` above pulls only the *type*, so the worker code never
// runs on the main thread.
export function getDb(): Comlink.Remote<DbApi> {
  if (!api) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    api = Comlink.wrap<DbApi>(worker);
  }
  return api;
}

// Terminate the worker, releasing the exclusive OPFS handles so another tab can
// take ownership of the store. Safe to call when nothing is open.
export function closeDb(): void {
  worker?.terminate();
  worker = null;
  api = null;
}
