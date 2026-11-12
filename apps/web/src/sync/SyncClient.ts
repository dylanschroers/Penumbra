// Push then pull, on startup, every 15s, on `online`, and debounced after a
// local edit. See docs/SYNC.md.

import type { PullTasksResult } from "@penumbra/shared";
import { getDb } from "../db/client";
import {
  getAgentToken,
  getServerUrl,
  recordConnection,
  setServerUrlValue,
} from "../serverAddress";

// Re-exported from ../serverAddress, the single owner of the address.

export { getServerUrl } from "../serverAddress";

const INTERVAL_MS = 15_000;
const DEBOUNCE_MS = 800;

/** An event, not a callback, to keep sync decoupled from React. */
export const SYNC_EVENT = "penumbra:synced";

/** "pending" until the first round settles. */
export const SYNC_STATUS_EVENT = "penumbra:sync-status";

export type SyncStatus = "pending" | "connected" | "disconnected";

let status: SyncStatus = "pending";

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
let inFlight: Promise<void> | null = null; // that round, for awaiting it
let debounce: ReturnType<typeof setTimeout> | undefined;

async function pushOnce(): Promise<void> {
  const db = getDb();
  const { seqs, rows } = await db.collectOutbox();
  if (rows.length === 0) return;
  const res = await fetch(`${getServerUrl()}/sync/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) throw new Error(`push failed: ${res.status}`);
  // Clear only the collected seqs: a mutation that landed mid-push survives.
  await db.clearOutbox(seqs);
}

async function pullOnce(): Promise<{ changed: boolean; serverId: string }> {
  const db = getDb();
  const cursor = await db.getCursor();
  const res = await fetch(`${getServerUrl()}/sync/tasks?since=${cursor}`);
  if (!res.ok) throw new Error(`pull failed: ${res.status}`);
  const { rows, serverId } = (await res.json()) as PullTasksResult;
  const changed = rows.length > 0 && (await db.applyServerRows(rows)) > 0;
  return { changed, serverId };
}

function syncNow(): Promise<void> {
  if (!active) return Promise.resolve();
  if (syncing) return inFlight ?? Promise.resolve();
  inFlight = runRound();
  return inFlight;
}

async function runRound(): Promise<void> {
  if (!navigator.onLine) {
    setStatus("disconnected");
    return;
  }
  syncing = true;
  try {
    await pushOnce();
    let { changed, serverId } = await pullOnce();

    // An unfamiliar serverId means the database was replaced (or first sync):
    // reconcile and run another push+pull. No serverId at all is a pre-epoch
    // server; ignore it.
    if (serverId && serverId !== (await getDb().getServerId())) {
      await getDb().adoptServer(serverId);
      await pushOnce();
      changed = (await pullOnce()).changed || changed;
    }

    if (changed) {
      window.dispatchEvent(new CustomEvent(SYNC_EVENT));
    }
    // Record history only on the transition to connected, not every 15s.
    if (status !== "connected") {
      recordConnection(getServerUrl(), getAgentToken() ?? "");
    }
    setStatus("connected");
  } catch (err) {
    // Offline is normal; the outbox keeps unpushed work for the next round.
    setStatus("disconnected");
    console.warn("[sync]", err);
  } finally {
    syncing = false;
  }
}

/**
 * A Tier 1 turn runs against the server's store, so flush first
 * (docs/SYNC.md → Server-side writes). A round already in flight may predate
 * the caller's edits, so wait it out and run a fresh one.
 */
export async function flushSync(): Promise<void> {
  if (syncing) await inFlight;
  await syncNow();
}

/** Persists the address and runs a round whose result updates the status. */
export async function setServerUrl(url: string): Promise<void> {
  // Moves the address app-wide.
  setServerUrlValue(url);
  setStatus("pending");
  await flushSync();
}

export function requestSync(): void {
  if (!active) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => void syncNow(), DEBOUNCE_MS);
}

/** Idempotent. Call only from the tab that owns the store. */
export function startSync(): () => void {
  if (active) return stopSync;
  active = true;

  void syncNow();
  const timer = setInterval(() => void syncNow(), INTERVAL_MS);
  const onOnline = () => void syncNow();
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
