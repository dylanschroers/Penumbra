import { type ReactNode, useEffect, useRef, useState } from "react";
import { closeDb } from "./db/client";

// Ensures only one tab uses the local SQLite store at a time. The OPFS SAHPool
// VFS takes an exclusive lock on its files, so a second tab opening the DB throws
// NoModificationAllowedError. We coordinate with the Web Locks API: the first tab
// holds an exclusive lock and owns the store; other tabs render a takeover screen
// instead of the app (so their worker never opens the DB — see the lazy getDb()).
const LOCK_NAME = "ghost-db-owner";
const CHANNEL_NAME = "ghost-db-control";
const TAKEOVER = "request-takeover";

type Status = "pending" | "owner" | "blocked";

export function SingleTabGuard({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("pending");
  const ownerRef = useRef(false);
  const releaseRef = useRef<(() => void) | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    // No Web Locks (very old browser): fail open and behave as before.
    if (!("locks" in navigator)) {
      ownerRef.current = true;
      setStatus("owner");
      return;
    }

    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    const abort = new AbortController();

    // If the lock isn't granted almost immediately, another tab owns it.
    const blockedTimer = window.setTimeout(() => {
      if (!ownerRef.current) setStatus("blocked");
    }, 150);

    // One queued request does double duty: it grants ownership now if the lock is
    // free, and otherwise stays queued so we auto-promote the instant the current
    // owner releases (its tab closed, or it handed off via takeover below).
    navigator.locks
      .request(
        LOCK_NAME,
        { mode: "exclusive", signal: abort.signal },
        () =>
          new Promise<void>((release) => {
            window.clearTimeout(blockedTimer);
            releaseRef.current = release;
            ownerRef.current = true;
            setStatus("owner");
            // Promise stays pending → we hold the lock until release() runs.
          }),
      )
      .catch(() => {
        // AbortError fires when the cleanup aborts a still-queued request.
      });

    // An owner asked to hand off must free the OPFS handles *before* releasing the
    // lock, or the next owner hits NoModificationAllowedError.
    channel.onmessage = (event) => {
      if (event.data === TAKEOVER && ownerRef.current) {
        ownerRef.current = false;
        closeDb();
        releaseRef.current?.();
        releaseRef.current = null;
        setStatus("blocked");
      }
    };

    return () => {
      abort.abort();
      releaseRef.current?.();
      releaseRef.current = null;
      ownerRef.current = false;
      channel.close();
      window.clearTimeout(blockedTimer);
    };
  }, []);

  // Nudge the current owner to release; our still-queued lock request then
  // promotes this tab to owner automatically.
  const takeOver = () => channelRef.current?.postMessage(TAKEOVER);

  if (status === "owner") return <>{children}</>;
  if (status === "blocked") return <TabBlocked onTakeOver={takeOver} />;
  return null; // brief pending flash before owner/blocked resolves
}

function TabBlocked({ onTakeOver }: { onTakeOver: () => void }) {
  return (
    <main className="tab-blocked">
      <div className="tab-blocked__card">
        <h1 className="tab-blocked__title">Ghost is open in another tab</h1>
        <p className="tab-blocked__text">
          The local store can only be used by one tab at a time. Keep using the
          other tab, or take over here.
        </p>
        <button type="button" className="btn btn--primary" onClick={onTakeOver}>
          Use here instead
        </button>
      </div>
    </main>
  );
}
