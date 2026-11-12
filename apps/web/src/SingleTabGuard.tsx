import { type ReactNode, useEffect, useRef, useState } from "react";
import { closeDb } from "./db/client";

// The OPFS SAHPool VFS locks its files exclusively, so a Web Lock picks one
// owner tab; others render a takeover screen and never open the DB.
const LOCK_NAME = "penumbra-db-owner";
const CHANNEL_NAME = "penumbra-db-control";
const TAKEOVER = "request-takeover";

type Status = "pending" | "owner" | "blocked";

export function SingleTabGuard({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("pending");
  const ownerRef = useRef(false);
  const releaseRef = useRef<(() => void) | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (!("locks" in navigator)) {
      ownerRef.current = true;
      setStatus("owner");
      return;
    }

    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    const abort = new AbortController();

    const blockedTimer = window.setTimeout(() => {
      if (!ownerRef.current) setStatus("blocked");
    }, 150);

    // One queued request grants ownership now if free, or promotes this tab when
    // the owner releases.
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
          }),
      )
      .catch(() => {});

    // Free the OPFS handles before releasing the lock, or the next owner hits
    // NoModificationAllowedError.
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

  const takeOver = () => channelRef.current?.postMessage(TAKEOVER);

  if (status === "owner") return <>{children}</>;
  if (status === "blocked") return <TabBlocked onTakeOver={takeOver} />;
  return null; // brief pending flash before owner/blocked resolves
}

function TabBlocked({ onTakeOver }: { onTakeOver: () => void }) {
  return (
    <main className="tab-blocked">
      <div className="tab-blocked__card">
        <h1 className="tab-blocked__title">Penumbra is open in another tab</h1>
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
