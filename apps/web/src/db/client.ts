// Browser: a Comlink proxy to ./worker.ts. Tauri: a direct DbApi over
// ./tauriExec.ts (IPC isn't reachable from a worker).

import * as Comlink from "comlink";
import { createDbApi, type DbApi } from "./api";
import { tauriExec } from "./tauriExec";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let worker: Worker | null = null;
let api: DbApi | null = null;

// Lazy so SingleTabGuard decides ownership before the worker grabs the
// exclusive OPFS handles.
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

// Releases the OPFS handles so another tab can take over.
export function closeDb(): void {
  worker?.terminate();
  worker = null;
  api = null;
}
