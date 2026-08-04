import { useState } from "react";
import {
  forgetServer,
  getServerHistory,
  type ServerHistoryEntry,
} from "../serverAddress";

// The "Recent servers" disclosure in the status pill: the last few servers the
// app connected to, collapsed by default, each one click away from being
// reconnected.
//
// History is written on a proven connection, not on every address change (see
// serverAddress.recordConnection), so this is "servers that answered" and holds
// no typos. The current server is excluded — there is nothing to switch to
// there. Tokens are stored with each entry so a reconnect needs no re-paste, but
// are never rendered: the row shows only where, not the secret.

const SHOWN = 3;

/** "just now" / "2h ago" — enough to tell a fresh entry from a stale one. */
function ago(at: string): string {
  const mins = Math.floor((Date.now() - Date.parse(at)) / 60_000);
  if (Number.isNaN(mins) || mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function RecentServers({
  currentUrl,
  onPick,
}: {
  currentUrl: string;
  onPick: (entry: ServerHistoryEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  // Bumped on forget so the list re-reads localStorage without a parent render.
  const [, setVersion] = useState(0);

  const history = getServerHistory()
    .filter((e) => e.url !== currentUrl)
    .slice(0, SHOWN);

  // Nothing to offer until the app has connected somewhere else at least once.
  if (history.length === 0) return null;

  return (
    <div className="recents">
      <button
        type="button"
        className="recents__toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className={`recents__caret${open ? " recents__caret--open" : ""}`}
        >
          ▸
        </span>
        Recent servers ({history.length})
      </button>

      {open && (
        <ul className="recents__list">
          {history.map((entry) => (
            <li key={entry.url} className="recents__row">
              <button
                type="button"
                className="recents__pick"
                title={`Reconnect to ${entry.url}`}
                onClick={() => onPick(entry)}
              >
                <span className="recents__url">{entry.url}</span>
                <span className="recents__ago">{ago(entry.at)}</span>
              </button>
              <button
                type="button"
                className="recents__forget"
                aria-label={`Forget ${entry.url}`}
                title="Forget this server"
                onClick={() => {
                  forgetServer(entry.url);
                  setVersion((v) => v + 1);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
