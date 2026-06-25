// Main-thread handle to the database worker. `Comlink.wrap` turns the worker's
// exposed `api` into an object whose methods you call with normal `await` —
// the postMessage plumbing is hidden. Import `db` anywhere in the UI.

import * as Comlink from "comlink";
import type { DbApi } from "./worker";

// Vite compiles ./worker.ts into its own bundle and serves it as a module
// worker. `import type` above ensures we pull only the *type* here, so the
// worker code itself never runs on the main thread.
const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

export const db = Comlink.wrap<DbApi>(worker);
