import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerDeviceRoutes } from "./routes";
import { createDeviceStore, type DeviceStore } from "./store";

// These routes must themselves be gated, or anyone could enrol.

let app: FastifyInstance;
let devices: DeviceStore;

/** inject() reports loopback unless a forwarded IP is set. */
const REMOTE = { "x-forwarded-for": "203.0.113.9" };

async function build(token?: string): Promise<void> {
  devices = createDeviceStore(new Database(":memory:"));
  app = Fastify({ trustProxy: true });
  registerDeviceRoutes(app, { devices, token });
  await app.ready();
}

beforeEach(() => build());
afterEach(() => app.close());

describe("GET /auth/context", () => {
  it("reports loopback for a same-machine caller", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/context" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ loopback: true, requiresToken: false });
  });

  it("answers a remote caller without a credential", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/context",
      headers: REMOTE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().loopback).toBe(false);
  });

  it("reports a shared secret when one is set", async () => {
    await build("shared-secret");
    const res = await app.inject({ method: "GET", url: "/auth/context" });
    expect(res.json().requiresToken).toBe(true);
  });

  // An empty PENUMBRA_AGENT_TOKEN means no shared secret.
  it("reports no shared secret when the env var is set but empty", async () => {
    await build("");
    const res = await app.inject({ method: "GET", url: "/auth/context" });
    expect(res.json().requiresToken).toBe(false);
    expect((await app.inject({ url: "/auth/devices" })).statusCode).toBe(200);
  });
});

describe("enrolment is gated", () => {
  it("serves loopback when nothing is configured — the bootstrap path", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/devices" });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a remote caller with no credential", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/devices",
      headers: REMOTE,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("local_only");
  });

  it("refuses a remote caller trying to issue itself a token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/devices",
      headers: REMOTE,
      payload: { label: "attacker" },
    });
    expect(res.statusCode).toBe(403);
    expect(devices.list()).toHaveLength(0);
  });
});

describe("POST /auth/devices", () => {
  it("mints a device and returns its token once", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/devices",
      payload: { label: "laptop" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.device).toMatchObject({ label: "laptop", lastSeenAt: null });
    expect(body.token).toEqual(expect.any(String));

    const listed = await app.inject({ method: "GET", url: "/auth/devices" });
    expect(listed.payload).not.toContain(body.token);
  });

  it("rejects a device with no label", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/devices",
      payload: { label: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("issues a token that works from off-loopback", async () => {
    const { token } = (
      await app.inject({
        method: "POST",
        url: "/auth/devices",
        payload: { label: "laptop" },
      })
    ).json();

    const res = await app.inject({
      method: "GET",
      url: "/auth/devices",
      headers: { ...REMOTE, authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("DELETE /auth/devices/:id", () => {
  it("revokes a device and shuts its token out", async () => {
    const { device, token } = (
      await app.inject({
        method: "POST",
        url: "/auth/devices",
        payload: { label: "laptop" },
      })
    ).json();

    const del = await app.inject({
      method: "DELETE",
      url: `/auth/devices/${device.id}`,
    });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: "/auth/devices",
      headers: { ...REMOTE, authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("404s an id that has no access to take away", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/auth/devices/nope",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("alongside a shared secret", () => {
  it("accepts either the env token or a device token", async () => {
    await build("shared-secret");

    const { token } = devices.issue("laptop");
    for (const bearer of ["shared-secret", token]) {
      const res = await app.inject({
        method: "GET",
        url: "/auth/devices",
        headers: { ...REMOTE, authorization: `Bearer ${bearer}` },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  // A shared secret, once set, is required from loopback too.
  it("still requires a credential from loopback", async () => {
    await build("shared-secret");
    const res = await app.inject({ method: "GET", url: "/auth/devices" });
    expect(res.statusCode).toBe(401);
  });
});
