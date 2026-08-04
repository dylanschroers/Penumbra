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

// Top-right status pill: a coloured dot + label reflecting whether the last sync
// round reached the server (that *is* the server-connection status). Clicking it
// opens a small menu to point the app at a server by address and connect — the
// round the new address triggers flips the same status, which stays visible in
// the menu so the result is seen. The menu closes on outside-click or Escape.
//
// The bearer is set here too, beside the address, because the dot cannot report
// on it. Sync is ungated, so a round succeeds and the pill goes green whatever
// the token is; /agent/*, /lab/* and /compute/* are behind requireAuth and fail
// separately. Connected therefore means "the address is right", never "the whole
// app can reach it" — which is why the two fields sit together rather than the
// token hiding in a settings screen somewhere else.

const STATUS_LABEL: Record<SyncStatus, string> = {
  pending: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected",
};

export function ServerStatus() {
  const [status, setStatus] = useState<SyncStatus>(getSyncStatus);
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState(() => getServerUrl());
  // Shown rather than masked to a placeholder: unlike the Studio key, this one
  // is already in the user's own browser and the commonest fix is spotting that
  // it does not match what the server was started with.
  const [token, setToken] = useState(() => getAgentToken() ?? "");
  const ref = useRef<HTMLDivElement>(null);
  // Fetched only while the menu is open. Its admin controls render only when the
  // server reports this caller as loopback — see DevicePanel.
  const devices = useDevices(open);

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

  /** Point the app at an address and bearer and test it. Shared by the form and
   *  by picking a recent server, so both go through one path. */
  function connectTo(nextUrl: string, nextToken: string) {
    const trimmed = nextUrl.trim();
    if (!trimmed) return;
    setAddress(trimmed);
    setToken(nextToken);
    // Bearer first, so the round the address change triggers — and every gated
    // call after it — already carries the new one.
    setAgentToken(nextToken.trim());
    // setServerUrl persists + runs a round; the status updates via the event.
    void setServerUrl(trimmed);
  }

  function connect(event: FormEvent) {
    event.preventDefault();
    connectTo(address, token);
  }

  /** Reconnect to a server from the history list, restoring its stored token. */
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
          {/* The failure this exists to explain: a server on another machine
              with no PENUMBRA_AGENT_TOKEN serves loopback only, so the dot goes
              green on sync while the Lab and chat are refused. */}
          <p className="server-status__hint">
            Needed for the assistant and the Model Lab when the server is on
            another machine — it must match that server's PENUMBRA_AGENT_TOKEN,
            or a device token issued below. Sync works without it, so the dot
            can be green while those are still refused.
          </p>

          <RecentServers currentUrl={getServerUrl()} onPick={pickRecent} />

          <DevicePanel devices={devices} />
        </div>
      )}
    </div>
  );
}
