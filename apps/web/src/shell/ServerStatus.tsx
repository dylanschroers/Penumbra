import { type FormEvent, useEffect, useRef, useState } from "react";
import { DevicePanel } from "../devices/DevicePanel";
import { useDevices } from "../devices/useDevices";
import {
  getAgentToken,
  getServerUrl,
  type ServerHistoryEntry,
  setAgentToken,
} from "../serverAddress";
import {
  getSyncStatus,
  SYNC_STATUS_EVENT,
  type SyncStatus,
  setServerUrl,
} from "../sync/SyncClient";
import { RecentServers } from "./RecentServers";

// The dot shows whether the last sync round reached the server. Sync is
// ungated, so green means the address is right, not that the bearer works for
// /agent/*, /lab/*, /compute/*; that's why the token field sits here too.

const STATUS_LABEL: Record<SyncStatus, string> = {
  pending: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected",
};

export function ServerStatus() {
  const [status, setStatus] = useState<SyncStatus>(getSyncStatus);
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState(() => getServerUrl());
  // Shown, not masked: it's already in the user's browser, and spotting a
  // mismatch is the usual fix.
  const [token, setToken] = useState(() => getAgentToken() ?? "");
  const ref = useRef<HTMLDivElement>(null);
  // Admin controls render only for loopback callers.
  const devices = useDevices(open);

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

  function connectTo(nextUrl: string, nextToken: string) {
    const trimmed = nextUrl.trim();
    if (!trimmed) return;
    setAddress(trimmed);
    setToken(nextToken);
    // Bearer first, so the round the address change triggers already uses it.
    setAgentToken(nextToken.trim());
    void setServerUrl(trimmed);
  }

  function connect(event: FormEvent) {
    event.preventDefault();
    connectTo(address, token);
  }

  function pickRecent(entry: ServerHistoryEntry) {
    connectTo(entry.url, entry.token);
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
            <input
              className="server-status__input"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Access token (blank if the server is local)"
              aria-label="Server access token"
              spellCheck={false}
              autoComplete="off"
            />
            <button type="submit" className="btn btn--primary">
              Connect
            </button>
          </form>
          {/* A remote server with no PENUMBRA_AGENT_TOKEN serves loopback only, so sync goes green while the Lab and chat are refused. A server with a shared secret requires it from its own machine too. */}
          <p className="server-status__hint">
            {devices.context?.requiresToken
              ? "This server is set up with a shared secret, so every client needs a token — this one included, even on the server's own machine. Use that server's PENUMBRA_AGENT_TOKEN, or a device token issued from it."
              : "Needed for the assistant and the Model Lab when the server is on another machine — it must match that server's PENUMBRA_AGENT_TOKEN, or a device token issued below."}{" "}
            Sync works without it, so the dot can be green while those are still
            refused.
          </p>

          <RecentServers currentUrl={getServerUrl()} onPick={pickRecent} />

          <DevicePanel devices={devices} />
        </div>
      )}
    </div>
  );
}
