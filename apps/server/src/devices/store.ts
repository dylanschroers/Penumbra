import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

// Per-device bearer tokens. PENUMBRA_AGENT_TOKEN still works (http/auth.ts) as
// the bootstrap and back-compat path.

export interface Device {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** Revoked rows stay for the audit trail. */
  revokedAt: string | null;
}

export interface IssuedDevice {
  device: Device;
  /** Cleartext only here, at mint; only the hash is stored. */
  token: string;
}

export interface DeviceStore {
  issue(label: string): IssuedDevice;
  /** Null when unknown or revoked. Records the sighting. */
  verify(token: string): Device | null;
  list(): Device[];
  revoke(id: string): boolean;
}

/** Lets foreign bearers be rejected without a DB lookup. */
const TOKEN_PREFIX = "pen_";

/** 256 bits of CSPRNG output, which is why plain SHA-256 suffices. */
const TOKEN_BYTES = 32;

/** Throttles last-seen writes; the Lab polls every 2s. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * SHA-256, not a password KDF: the secret is 32 random bytes, with no
 * dictionary to grind.
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
