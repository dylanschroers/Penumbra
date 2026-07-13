// The client half of Plane A sync. Runs on the main thread, drives the four
// sync primitives the DB worker exposes, and talks to the server's /sync/tasks
// endpoints. One round is "push local changes, then pull remote ones"; it runs
// on startup, on an interval, when the network returns, and (debounced) right
// after a local edit. See docs/SYNC.md.

import type { PullTasksResult } from "@ghost/shared";
import { getDb } from "../db/client";

const SERVER_URL: string =
  import.meta.env.VITE_SERVER_URL ?? "http://localhost:3000";
const INTERVAL_MS = 15_000;
const DEBOUNCE_MS = 800;

/** Fired on window after a pull actually changed local data, so the UI can
 * re-read. Carried as an event (not a callback) to keep sync decoupled from
 * React. */
export const SYNC_EVENT = "ghost:synced";

/** Fired on window when the connection status changes; detail is a SyncStatus.
 * "pending" until the first round settles, then whatever the last round
 * proved. Same event-not-callback reasoning as SYNC_EVENT. */
export const SYNC_STATUS_EVENT = "ghost:sync-status";

export type SyncStatus = "pending" | "connected" | "disconnected";

let status: SyncStatus = "pending";

/** The last known connection status (for initial render; updates arrive via
 * SYNC_STATUS_EVENT). */
export function getSyncStatus(): SyncStatus {
  return status;
}

function setStatus(next: SyncStatus): void {
  if (status === next) return;
  status = next;
  window.dispatchEvent(
    new CustomEvent<SyncStatus>(SYNC_STATUS_EVENT, { detail: next }),
  );
}

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

/** `changed` is true when pulled rows changed local data. */
async function pullOnce(): Promise<{ changed: boolean; serverId: string }> {
  const db = getDb();
  const cursor = await db.getCursor();
  const res = await fetch(`${SERVER_URL}/sync/tasks?since=${cursor}`);
  if (!res.ok) throw new Error(`pull failed: ${res.status}`);
  const { rows, serverId } = (await res.json()) as PullTasksResult;
  const changed = rows.length > 0 && (await db.applyServerRows(rows)) > 0;
  return { changed, serverId };
}

async function syncNow(): Promise<void> {
  if (!active || syncing) return;
  if (!navigator.onLine) {
    setStatus("disconnected");
    return;
  }
  syncing = true;
  try {
    await pushOnce();
    let { changed, serverId } = await pullOnce();

    // A serverId we haven't adopted means the database behind the URL was
    // replaced (or this store has never synced): our cursor and cleared outbox
    // belong to a dead epoch. Reconcile — forget revs, re-offer every row —
    // then run one more push+pull against the new epoch. If the id changes
    // again mid-round, the next round picks it up. A response with no serverId
    // at all is a pre-epoch server build: don't treat that as a new epoch.
    if (serverId && serverId !== (await getDb().getServerId())) {
      await getDb().adoptServer(serverId);
      await pushOnce();
      changed = (await pullOnce()).changed || changed;
    }

    if (changed) {
      window.dispatchEvent(new CustomEvent(SYNC_EVENT));
    }
    // Every round ends in a pull, so reaching here proves the server answered.
    setStatus("connected");
  } catch (err) {
    // Offline or server down is the normal local-first case: stay quiet-ish and
    // let the next trigger retry. The outbox preserves unpushed work.
    setStatus("disconnected");
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
  // Flip the light immediately when the network drops, rather than waiting for
  // the next round's fetch to fail.
  const onOffline = () => setStatus("disconnected");
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  function stop(): void {
    active = false;
    clearInterval(timer);
    clearTimeout(debounce);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  }
  stopSync = stop;
  return stop;
}

let stopSync: () => void = () => {};
