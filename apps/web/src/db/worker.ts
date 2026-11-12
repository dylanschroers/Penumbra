// Owns the browser build's SQLite (WASM + OPFS) off the UI thread.

import { LOCAL_DB_FILE, LOCAL_DB_POOL } from "@penumbra/shared";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import * as Comlink from "comlink";
import { createDbApi } from "./api";

// sqlite-wasm's own types vary across builds; pin only what we use.
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

  // SAHPool VFS: persistent OPFS without COOP/COEP headers. Deliberately no
  // fallback: every other worker VFS is silently in-memory and would lose data on
  // restart, so fail loudly.
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
      "[penumbra] OPFS is unavailable; the local store cannot persist here:",
      err,
    );
    throw err;
  }

  return (sql, bind = []) =>
    sqliteDb.exec({ sql, bind, rowMode: "array", returnValue: "resultRows" });
}

const execReady = init();

Comlink.expose(createDbApi(async (sql, bind) => (await execReady)(sql, bind)));
