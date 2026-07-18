// Runs on a Web Worker (background thread). Owns the browser build's SQLite
// database (WASM + OPFS) so query work never blocks the UI. The main thread
// talks to it via Comlink — see ./client.ts. All database logic lives in
// ./api.ts; this file supplies only the storage: an OPFS-backed exec primitive.

import { LOCAL_DB_FILE, LOCAL_DB_POOL } from "@penumbra/shared";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import * as Comlink from "comlink";
import { createDbApi } from "./api";

// Minimal shapes for the parts of the sqlite-wasm API we use. The package's
// own types vary across builds, so we pin just what we touch at the WASM
// boundary rather than depend on its full typings.
interface SqliteDb {
  exec(opts: {
    sql: string;
    bind?: unknown[];
    rowMode?: "array";
    returnValue?: "resultRows";
  }): unknown[][];
}
interface SAHPoolUtil {
  OpfsSAHPoolDb: new (filename: string) => SqliteDb;
}

async function init(): Promise<(sql: string, bind?: unknown[]) => unknown[][]> {
  const sqlite3 = await sqlite3InitModule();

  // Install the OPFS "SyncAccessHandle Pool" VFS: real on-disk persistence in
  // the browser that, unlike plain OPFS, needs no special COOP/COEP headers.
  //
  // Deliberately NO fallback on failure. Every alternative sqlite-wasm offers
  // inside a worker is silently non-persistent — kvvfs cannot reach
  // localStorage off the main thread, so it hands back a transient in-memory
  // store — which would accept the user's data and lose it on restart. If the
  // environment can't persist, fail loudly instead. (Tauri doesn't hit this
  // path at all: the desktop build uses native SQLite via ./tauriExec.ts.)
  let sqliteDb: SqliteDb;
  try {
    const poolUtil = (await (
      sqlite3 as unknown as {
        installOpfsSAHPoolVfs(opts: { name: string }): Promise<SAHPoolUtil>;
      }
    ).installOpfsSAHPoolVfs({ name: LOCAL_DB_POOL })) satisfies SAHPoolUtil;
    sqliteDb = new poolUtil.OpfsSAHPoolDb(`/${LOCAL_DB_FILE}`);
  } catch (err) {
    console.error(
      "[penumbra] OPFS is unavailable — the local store cannot persist here:",
      err,
    );
    throw err;
  }

  // Bridge between SQL strings and the WASM database. `rowMode: "array"` returns
  // each row as an array of column values, which is what ./api.ts expects.
  return (sql, bind = []) =>
    sqliteDb.exec({ sql, bind, rowMode: "array", returnValue: "resultRows" });
}

// Kick off initialization once; every exec call awaits it.
const execReady = init();

Comlink.expose(createDbApi(async (sql, bind) => (await execReady)(sql, bind)));
