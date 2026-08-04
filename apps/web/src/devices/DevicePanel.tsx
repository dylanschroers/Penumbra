import { type FormEvent, useState } from "react";
import type { Devices } from "./useDevices";

// The device-management half of the status pill's menu.
//
// Rendered only when the server reports the caller as loopback — i.e. the app is
// open on the server's own machine. Off-machine this is nothing, by design and
// for now: managing who may reach the server is admin, and until there is an
// admin flag "same machine" is the only thing that stands in for one.
//
// Kept in its own file rather than inlined so the pill stays about the
// connection and this stays about who may use it — and so it can lift out whole
// into the fuller network-settings surface that is coming.

/** A last-seen worth reading at a glance, not to the second. */
function seen(at: string | null): string {
  if (!at) return "never used";
  const ms = Date.now() - Date.parse(at);
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "seen just now";
  if (mins < 60) return `seen ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `seen ${hrs}h ago`;
  return `seen ${Math.floor(hrs / 24)}d ago`;
}

function DeviceRow({
  device,
  onRevoke,
  disabled,
}: {
  device: Devices["devices"][number];
  onRevoke: () => void;
  disabled: boolean;
}) {
  // Revoking cuts a device off, so it takes two clicks: the first arms, the
  // second does it. Cheaper than a modal and it cannot fire by a stray click.
  const [arming, setArming] = useState(false);

  if (device.revokedAt) {
    return (
      <li className="devices__row devices__row--revoked">
        <span className="devices__label">{device.label}</span>
        <span className="devices__meta">revoked</span>
      </li>
    );
  }

  return (
    <li className="devices__row">
      <span className="devices__label">{device.label}</span>
      <span className="devices__meta">{seen(device.lastSeenAt)}</span>
      <button
        type="button"
        className="devices__revoke"
        disabled={disabled}
        onClick={() => {
          if (arming) onRevoke();
          else setArming(true);
        }}
        onBlur={() => setArming(false)}
      >
        {arming ? "Confirm" : "Revoke"}
      </button>
    </li>
  );
}

export function DevicePanel({ devices }: { devices: Devices }) {
  const [label, setLabel] = useState("");
  const [copied, setCopied] = useState(false);

  // Nothing until the server has answered, and nothing off its own machine.
  if (!devices.context?.loopback) return null;

  function add(event: FormEvent) {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) return;
    setCopied(false);
    void devices.mint(trimmed).then(() => setLabel(""));
  }

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      // Clipboard blocked; the token is on screen to copy by hand.
    }
  }

  return (
    <section className="devices">
      <span className="devices__title">Devices with access</span>

      {devices.devices.length > 0 ? (
        <ul className="devices__list">
          {devices.devices.map((d) => (
            <DeviceRow
              key={d.id}
              device={d}
              disabled={devices.busy}
              onRevoke={() => void devices.revoke(d.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="devices__empty">
          Only this machine, on loopback. Add a device to let another one in.
        </p>
      )}

      {/* Shown once, because the server will never return it again. Held until
          dismissed so it cannot scroll away before it is copied. */}
      {devices.minted && (
        <div className="devices__minted">
          <p className="devices__minted-label">
            Token for “{devices.minted.device.label}” — copy it now, it will not
            be shown again:
          </p>
          <code className="devices__token">{devices.minted.token}</code>
          <div className="devices__minted-actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void copy(devices.minted!.token)}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setCopied(false);
                devices.dismissMinted();
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}

      <form className="devices__add" onSubmit={add}>
        <input
          className="server-status__input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="New device name, e.g. Phone"
          aria-label="New device name"
          spellCheck={false}
          autoComplete="off"
          maxLength={80}
          disabled={devices.busy}
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={devices.busy || !label.trim()}
        >
          Add
        </button>
      </form>

      {devices.error && <p className="devices__error">{devices.error}</p>}
    </section>
  );
}
