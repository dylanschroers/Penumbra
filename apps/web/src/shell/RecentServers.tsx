import { useState } from "react";
import {
  forgetServer,
  getServerHistory,
  type ServerHistoryEntry,
} from "../serverAddress";

// History is "servers that answered" (written on a proven connection).
// Tokens are stored per entry but never rendered.

const SHOWN = 3;

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
  const [, setVersion] = useState(0);

  const history = getServerHistory()
    .filter((e) => e.url !== currentUrl)
    .slice(0, SHOWN);

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
