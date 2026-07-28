import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  getServerUrl,
  getSyncStatus,
  SYNC_STATUS_EVENT,
  type SyncStatus,
  setServerUrl,
} from "../sync/SyncClient";

// Top-right status pill: a coloured dot + label reflecting whether the last sync
// round reached the server (that *is* the server-connection status). Clicking it
// opens a small menu to point the app at a server by address and connect — the
// round the new address triggers flips the same status, which stays visible in
// the menu so the result is seen. The menu closes on outside-click or Escape.

const STATUS_LABEL: Record<SyncStatus, string> = {
  pending: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected",
};

export function ServerStatus() {
  const [status, setStatus] = useState<SyncStatus>(getSyncStatus);
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState(() => getServerUrl());
  const ref = useRef<HTMLDivElement>(null);

  // Live status: sync rounds dispatch SYNC_STATUS_EVENT as they settle.
  useEffect(() => {
    const onChange = (e: Event) =>
      setStatus((e as CustomEvent<SyncStatus>).detail);
    window.addEventListener(SYNC_STATUS_EVENT, onChange);
    return () => window.removeEventListener(SYNC_STATUS_EVENT, onChange);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function connect(event: FormEvent) {
    event.preventDefault();
    const trimmed = address.trim();
    if (!trimmed) return;
    // setServerUrl persists + runs a round; the status updates via the event.
    void setServerUrl(trimmed);
  }

  return (
    <div className="server-status" ref={ref}>
      <button
        type="button"
        className="server-status__btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Server: ${STATUS_LABEL[status]}`}
        title={`Server: ${STATUS_LABEL[status]}`}
      >
        <span className={`server-status__dot server-status__dot--${status}`} />
      </button>

      {open && (
        <div className="server-status__menu">
          <div className="server-status__row">
            <span
              className={`server-status__dot server-status__dot--${status}`}
            />
            <span className="server-status__state">{STATUS_LABEL[status]}</span>
          </div>
          <p className="server-status__current" title={getServerUrl()}>
            {getServerUrl()}
          </p>
          <form className="server-status__form" onSubmit={connect}>
            <input
              className="server-status__input"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="192.168.1.50:3000"
              aria-label="Server address"
              spellCheck={false}
              autoComplete="off"
            />
            <button type="submit" className="btn btn--primary">
              Connect
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
