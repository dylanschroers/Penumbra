import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerComputeRoutes } from "./routes";
import { createTargetStore, type TargetStore } from "./targets";

// The HTTP surface over compute targets. Most of these cases came from
// /lab/provider/* — the settings themselves are unchanged, they just stopped
// being the Lab's private business once chat started reading them.
//
// No Studio is running in these tests, so every probe reports "stopped". That
// is fine: what is under test here is configuration and assignment, not
// reachability, which StudioClient.probe covers on its own.

let app: FastifyInstance;
let targets: TargetStore;

const env = { UNSLOTH_BASE_URL: "http://env:8888", UNSLOTH_API_KEY: "env-key" };

beforeEach(async () => {
  targets = createTargetStore(new Database(":memory:"), env);
  app = Fastify();
  registerComputeRoutes(app, { targets });
  await app.ready();
});
afterEach(() => app?.close());

const get = async () => (await app.inject({ url: "/compute/targets" })).json();
const local = (body: { targets: { id: string }[] }) =>
  body.targets.find((t) => t.id === "local");
const colab = (body: { targets: { id: string }[] }) =>
  body.targets.find((t) => t.id === "colab");

describe("auth", () => {
  // Same class of endpoint as /lab and /agent: it decides where a model runs.
  it("refuses a non-loopback caller with no token configured", async () => {
    const res = await app.inject({
      url: "/compute/targets",
      remoteAddress: "192.168.1.50",
    });
    expect(res.statusCode).toBe(403);
  });

  it("gates the mutating routes", async () => {
    const gated = Fastify();
    registerComputeRoutes(gated, { targets, token: "secret" });
    await gated.ready();
    for (const url of ["/compute/targets/local", "/compute/assign"]) {
      const res = await gated.inject({ method: "POST", url, payload: {} });
      expect(res.statusCode).toBe(401);
    }
    await gated.close();
  });
});

describe("GET /compute/targets", () => {
  it("lists both targets with where they came from", async () => {
    const body = await get();
    expect(local(body)).toMatchObject({
      baseURL: "http://env:8888",
      source: "env",
      hasKey: true,
      persistence: "persisted",
      configured: true,
    });
    expect(colab(body)).toMatchObject({
      persistence: "session",
      configured: false,
    });
  });

  it("never sends a key back", async () => {
    await app.inject({
      method: "POST",
      url: "/compute/targets/local",
      payload: { apiKey: "rotated" },
    });
    const body = (await app.inject({ url: "/compute/targets" })).body;
    expect(body).not.toContain("rotated");
    expect(body).not.toContain("env-key");
  });

  it("reports assignments and what they resolve to", async () => {
    const body = await get();
    expect(body.assignments).toEqual({ chat: "local", benchmark: "local" });
    expect(body.effective).toEqual({ chat: "local", benchmark: "local" });
  });
});

// Rotating Studio's key used to mean editing .env and restarting the server.
describe("POST /compute/targets/:id", () => {
  it("stores a rotated key and says the settings now govern", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/local",
      payload: { baseURL: "http://studio.lan:8888", apiKey: "rotated" },
    });

    expect(res.statusCode).toBe(200);
    expect(targets.credentials("local").apiKey).toBe("rotated");
    expect(local(await get())).toMatchObject({
      baseURL: "http://studio.lan:8888",
      source: "settings",
    });
  });

  it("rejects an empty patch and a bad URL", async () => {
    for (const payload of [{}, { baseURL: "not-a-url" }]) {
      const res = await app.inject({
        method: "POST",
        url: "/compute/targets/local",
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("404s an unknown target rather than inventing one", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/lambda",
      payload: { baseURL: "http://x:8888" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("configures Colab, echoing the address but not the bearer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/colab",
      payload: { baseURL: "https://tunnel.example", apiKey: "colab-secret" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain("colab-secret");
    expect(colab(await get())).toMatchObject({
      baseURL: "https://tunnel.example",
      configured: true,
      hasKey: true,
    });
  });

  // A key with nothing to attach it to would store silently and read as a save
  // that worked.
  it("refuses a Colab key before an address is known", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/colab",
      payload: { apiKey: "orphan" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("address_required");
  });

  it("allows a Colab key on its own once the address is set", async () => {
    await app.inject({
      method: "POST",
      url: "/compute/targets/colab",
      payload: { baseURL: "https://tunnel.example" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/colab",
      payload: { apiKey: "later" },
    });
    expect(res.statusCode).toBe(200);
    expect(targets.credentials("colab")).toMatchObject({
      baseURL: "https://tunnel.example",
      apiKey: "later",
    });
  });
});

describe("DELETE /compute/targets/:id", () => {
  it("reverts local to the environment", async () => {
    await app.inject({
      method: "POST",
      url: "/compute/targets/local",
      payload: { baseURL: "http://studio.lan:8888" },
    });
    await app.inject({ method: "DELETE", url: "/compute/targets/local" });
    expect(local(await get())).toMatchObject({
      baseURL: "http://env:8888",
      source: "env",
    });
  });

  it("forgets Colab entirely", async () => {
    await app.inject({
      method: "POST",
      url: "/compute/targets/colab",
      payload: { baseURL: "https://tunnel.example" },
    });
    await app.inject({ method: "DELETE", url: "/compute/targets/colab" });
    expect(colab(await get())).toMatchObject({ configured: false });
  });
});

describe("POST /compute/assign", () => {
  it("points a role at another target", async () => {
    await app.inject({
      method: "POST",
      url: "/compute/targets/colab",
      payload: { baseURL: "https://tunnel.example" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/compute/assign",
      payload: { role: "chat", target: "colab" },
    });

    expect(res.json()).toMatchObject({
      assignment: "colab",
      effective: "colab",
    });
    expect((await get()).effective.chat).toBe("colab");
  });

  it("leaves the other roles alone", async () => {
    await app.inject({
      method: "POST",
      url: "/compute/assign",
      payload: { role: "benchmark", target: "colab" },
    });
    expect((await get()).assignments).toEqual({
      chat: "local",
      benchmark: "colab",
    });
  });

  // Colab's config dies with the process, so an assignment can outlive the
  // target it names. Reporting both is what lets the UI say so instead of
  // misreporting where answers come from.
  it("reports the fallback when the assigned target is not configured", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/compute/assign",
      payload: { role: "chat", target: "colab" },
    });
    expect(res.json()).toMatchObject({
      assignment: "colab",
      effective: "local",
    });

    const body = await get();
    expect(body.assignments.chat).toBe("colab");
    expect(body.effective.chat).toBe("local");
  });

  it("rejects an unknown role or target", async () => {
    for (const payload of [
      { role: "training", target: "local" },
      { role: "chat", target: "lambda" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/compute/assign",
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });
});
