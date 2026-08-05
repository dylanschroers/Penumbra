import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

// Per-device bearer tokens: who is allowed to call the actuator routes, one row
// per device rather than one string shared by all of them.
//
// What this replaces is a single PENUMBRA_AGENT_TOKEN that every client held.
// That had no notion of *which* device was calling, so there was no way to take
// a laptop's access away without editing .env, restarting, and re-pasting the
// new value into everything else. A row per device makes revocation a delete
// and makes "what has access to this machine" a question with an answer.
//
// The env token still works (http/auth.ts) — it is the bootstrap path and the
// back-compat path, not a thing to remove yet.

/** A device as the API reports it. Deliberately no token: see `issue`. */
export interface Device {
  id: string;
  label: string;
  createdAt: string;
  /** When this device last presented its token, or null if it never has.
   *  Throttled — see `TOUCH_INTERVAL_MS`. */
  lastSeenAt: string | null;
  /** Set when access was taken away. The row stays so the list can show that a
   *  device existed and was revoked, which is the audit question. */
  revokedAt: string | null;
}

export interface IssuedDevice {
  device: Device;
  /**
   * The bearer, in cleartext, for the only time it will ever exist in cleartext
   * here. Only its hash is stored, so a lost token is re-issued rather than
   * looked up — the same posture as any credential you cannot read back.
   */
  token: string;
}

export interface DeviceStore {
  issue(label: string): IssuedDevice;
  /** The device this bearer belongs to, or null when it matches nothing or has
   *  been revoked. Records the sighting. */
  verify(token: string): Device | null;
  list(): Device[];
  /** True when a live device was revoked; false when the id is unknown or was
   *  already revoked. */
  revoke(id: string): boolean;
}

/** Marks our tokens as ours, so an obviously foreign bearer can be rejected
 *  without a database round trip and a leaked one is recognisable in a log. */
const TOKEN_PREFIX = "pen_";

/** 256 bits from the CSPRNG. The reason a plain SHA-256 is enough below. */
const TOKEN_BYTES = 32;

/**
 * How stale a last-seen may get before a sighting is written.
 *
 * Without this, every authenticated request is also a write, and the Lab polls
 * every two seconds. The value is only ever read by a human deciding whether a
 * device is still in use, and a minute's resolution answers that fine.
 */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Hash a token for storage and lookup.
 *
 * SHA-256 rather than a password KDF on purpose. Argon2 and bcrypt exist to
 * make *guessable* secrets expensive to grind; this secret is 32 bytes of
 * CSPRNG output, so there is no dictionary to run and nothing a slow hash would
 * buy. What matters is that the stored form is not usable as a bearer, and a
 * one-way hash gives that.
 */
const hash = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const COLUMNS = `id, label, created_at AS createdAt,
  last_seen_at AS lastSeenAt, revoked_at AS revokedAt`;

export function createDeviceStore(db: Database.Database): DeviceStore {
  db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  id text PRIMARY KEY NOT NULL,
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at text NOT NULL,
  last_seen_at text,
  revoked_at text
);
CREATE INDEX IF NOT EXISTS devices_token_hash ON devices (token_hash);`);

  const insert = db.prepare(
    `INSERT INTO devices (id, label, token_hash, created_at)
     VALUES (@id, @label, @tokenHash, @createdAt)`,
  );
  const byHash = db.prepare(
    `SELECT ${COLUMNS} FROM devices WHERE token_hash = ? AND revoked_at IS NULL`,
  );
  const selectAll = db.prepare(
    `SELECT ${COLUMNS} FROM devices ORDER BY created_at DESC`,
  );
  const touch = db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?");
  const revokeOne = db.prepare(
    "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
  );

  return {
    issue(label) {
      const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
      const device: Device = {
        id: randomUUID(),
        // A device with no name is worse than useless in a revoke list, where
        // the whole job is telling one row from another.
        label: label.trim() || "Unnamed device",
        createdAt: new Date().toISOString(),
        lastSeenAt: null,
        revokedAt: null,
      };
      insert.run({
        id: device.id,
        label: device.label,
        tokenHash: hash(token),
        createdAt: device.createdAt,
      });
      return { device, token };
    },

    verify(token) {
      // Cheap rejects first: a bearer that is not ours cannot match, and this is
      // on the path of every gated request.
      if (!token.startsWith(TOKEN_PREFIX)) return null;
      const device = byHash.get(hash(token)) as Device | undefined;
      if (!device) return null;

      const now = Date.now();
      const seen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
      if (now - seen >= TOUCH_INTERVAL_MS) {
        const at = new Date(now).toISOString();
        touch.run(at, device.id);
        device.lastSeenAt = at;
      }
      return device;
    },

    list: () => selectAll.all() as Device[],

    revoke(id) {
      return revokeOne.run(new Date().toISOString(), id).changes > 0;
    },
  };
}
