import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceStore, type DeviceStore } from "./store";

// What is pinned here is the credential posture, not the CRUD. A token that can
// be read back, a revoked device that still authenticates, or two devices
// sharing a token would each defeat the point of issuing them per device.

let db: Database.Database;
let devices: DeviceStore;
beforeEach(() => {
  db = new Database(":memory:");
  devices = createDeviceStore(db);
});

describe("issuing", () => {
  it("returns the token once and never stores it", () => {
    const { token } = devices.issue("laptop");
    const rows = db.prepare("SELECT * FROM devices").all() as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(1);
    // The whole row, not just the columns we map: a token that leaked into any
    // field would be usable by anyone who could read the database.
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  it("never reports the token in a listing", () => {
    const { token } = devices.issue("laptop");
    expect(JSON.stringify(devices.list())).not.toContain(token);
  });

  it("gives each device a distinct token", () => {
    const a = devices.issue("laptop");
    const b = devices.issue("phone");
    expect(a.token).not.toBe(b.token);
    expect(devices.verify(a.token)?.id).toBe(a.device.id);
    expect(devices.verify(b.token)?.id).toBe(b.device.id);
  });

  it("labels an unnamed device rather than listing a blank row", () => {
    expect(devices.issue("   ").device.label).toBe("Unnamed device");
  });

  it("survives a restart", () => {
    const { token, device } = devices.issue("laptop");
    expect(createDeviceStore(db).verify(token)?.id).toBe(device.id);
  });
});

describe("verifying", () => {
  it("rejects a token that was never issued", () => {
    expect(devices.verify("pen_nonsense")).toBeNull();
  });

  it("rejects a bearer that is not one of ours", () => {
    expect(devices.verify("some-other-scheme")).toBeNull();
  });

  it("rejects an empty bearer", () => {
    expect(devices.verify("")).toBeNull();
  });

  // The reason per-device tokens exist at all.
  it("stops accepting a revoked device", () => {
    const { token, device } = devices.issue("laptop");
    expect(devices.verify(token)).not.toBeNull();
    expect(devices.revoke(device.id)).toBe(true);
    expect(devices.verify(token)).toBeNull();
  });

  it("leaves every other device working when one is revoked", () => {
    const laptop = devices.issue("laptop");
    const phone = devices.issue("phone");
    devices.revoke(laptop.device.id);
    expect(devices.verify(phone.token)?.id).toBe(phone.device.id);
  });
});

describe("revoking", () => {
  it("reports nothing revoked for an unknown id", () => {
    expect(devices.revoke("no-such-device")).toBe(false);
  });

  it("is not repeatable", () => {
    const { device } = devices.issue("laptop");
    expect(devices.revoke(device.id)).toBe(true);
    expect(devices.revoke(device.id)).toBe(false);
  });

  // "This used to have access and no longer does" is the question an audit
  // asks, and deleting the row would erase the answer.
  it("keeps the device listed, marked revoked", () => {
    const { device } = devices.issue("laptop");
    devices.revoke(device.id);
    expect(devices.list()).toMatchObject([
      { id: device.id, label: "laptop", revokedAt: expect.any(String) },
    ]);
  });
});

describe("last seen", () => {
  it("is null until the device has presented its token", () => {
    devices.issue("laptop");
    expect(devices.list()[0]?.lastSeenAt).toBeNull();
  });

  it("records the first sighting", () => {
    const { token } = devices.issue("laptop");
    devices.verify(token);
    expect(devices.list()[0]?.lastSeenAt).toEqual(expect.any(String));
  });

  // Every gated request would otherwise be a write, and the Lab polls every two
  // seconds. A minute's resolution answers the only question this value is for.
  it("does not write again on a second request in the same minute", () => {
    vi.useFakeTimers();
    try {
      const { token } = devices.issue("laptop");
      devices.verify(token);
      const first = devices.list()[0]?.lastSeenAt;

      vi.advanceTimersByTime(5_000);
      devices.verify(token);
      expect(devices.list()[0]?.lastSeenAt).toBe(first);

      vi.advanceTimersByTime(60_000);
      devices.verify(token);
      expect(devices.list()[0]?.lastSeenAt).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });
});
