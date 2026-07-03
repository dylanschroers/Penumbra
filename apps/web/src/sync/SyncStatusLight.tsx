import { useEffect, useState } from "react";
import {
  getSyncStatus,
  SYNC_STATUS_EVENT,
  type SyncStatus,
} from "./SyncClient";

const LABELS: Record<SyncStatus, string> = {
  pending: "Sync: connecting…",
  connected: "Sync: connected",
  disconnected: "Sync: offline — changes are saved locally and will sync later",
};

// A small dot in the workspace bar showing whether the last sync round reached
// the server. Purely an indicator: sync itself keeps retrying either way, so
// "disconnected" is informational, not an error state.
export function SyncStatusLight() {
  const [status, setStatus] = useState<SyncStatus>(getSyncStatus);

  useEffect(() => {
    const onChange = (e: Event) =>
      setStatus((e as CustomEvent<SyncStatus>).detail);
    window.addEventListener(SYNC_STATUS_EVENT, onChange);
    return () => window.removeEventListener(SYNC_STATUS_EVENT, onChange);
  }, []);

  return (
    <span
      className={`sync-light sync-light--${status}`}
      role="status"
      title={LABELS[status]}
      aria-label={LABELS[status]}
    />
  );
}
