// The client half of Plane A sync. Runs on the main thread, drives the four
// sync primitives the DB worker exposes, and talks to the server's /sync/tasks
// endpoints. One round is "push local changes, then pull remote ones"; it runs
// on startup, on an interval, when the network returns, and (debounced) right
// after a local edit. See docs/SYNC.md.

import { getDb } from "../db/client";
import type { PullTasksResult } from "@ghost/shared";

const SERVER_URL: string =
  import.meta.env.VITE_SERVER_URL ?? "http://localhost:3000";
const INTERVAL_MS = 15_000;
const DEBOUNCE_MS = 800;

/** Fired on window after a pull actually changed local data, so the UI can
 * re-read. Carried as an event (not a callback) to keep sync decoupled from
 * React. */
export const SYNC_EVENT = "ghost:synced";

let active = false; // a sync loop is running in this tab
let syncing = false; // a round is in flight (prevents overlap)
let debounce: ReturnType<typeof setTimeout> | undefined;

async function pushOnce(): Promise<void> {
  const db = getDb();
  const { seqs, rows } = await db.collectOutbox();
  if (rows.length === 0) return;
  const res = await fetch(`${SERVER_URL}/sync/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) throw new Error(`push failed: ${res.status}`);
  // Only clear the seqs we collected: a mutation that landed mid-push gets a
  // higher seq and survives to the next round, so no edit is lost.
  await db.clearOutbox(seqs);
}

/** Returns true when pulled rows changed local data. */
async function pullOnce(): Promise<boolean> {
  const db = getDb();
  const cursor = await db.getCursor();
  const res = await fetch(`${SERVER_URL}/sync/tasks?since=${cursor}`);
  if (!res.ok) throw new Error(`pull failed: ${res.status}`);
  const { rows } = (await res.json()) as PullTasksResult;
  if (rows.length === 0) return false;
  return (await db.applyServerRows(rows)) > 0;
}

async function syncNow(): Promise<void> {
  if (!active || syncing || !navigator.onLine) return;
  syncing = true;
  try {
    await pushOnce();
    if (await pullOnce()) {
      window.dispatchEvent(new CustomEvent(SYNC_EVENT));
    }
  } catch (err) {
    // Offline or server down is the normal local-first case: stay quiet-ish and
    // let the next trigger retry. The outbox preserves unpushed work.
    console.warn("[sync]", err);
  } finally {
    syncing = false;
  }
}

/** Nudge a sync soon, coalescing bursts of edits into one round. */
export function requestSync(): void {
  if (!active) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => void syncNow(), DEBOUNCE_MS);
}

/** Start the sync loop for this tab. Idempotent. Returns a stop function.
 * Call only from the tab that owns the local store (the single-tab guard
 * guarantees that's the one rendering the app). */
export function startSync(): () => void {
  if (active) return stopSync;
  active = true;

  void syncNow();
  const timer = setInterval(() => void syncNow(), INTERVAL_MS);
  const onOnline = () => void syncNow();
  window.addEventListener("online", onOnline);

  function stop(): void {
    active = false;
    clearInterval(timer);
    clearTimeout(debounce);
    window.removeEventListener("online", onOnline);
  }
  stopSync = stop;
  return stop;
}

let stopSync: () => void = () => {};
