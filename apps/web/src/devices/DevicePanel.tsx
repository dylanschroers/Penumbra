import { type FormEvent, useState } from "react";
import type { Devices } from "./useDevices";

// Rendered only for loopback callers: "same machine" stands in for an admin
// flag for now.

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
  // Two clicks to revoke: the first arms.
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
    } catch {}
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

      {/* Shown once (the server never returns it again) and held until dismissed. */}
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
