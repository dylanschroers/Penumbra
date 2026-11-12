import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { requireAuth } from "./auth";
import { allowedOrigins, corsOptions } from "./cors";

// `origin: true` plus the loopback exemption let any open web page POST
// /agent/chat and read the reply. Tests go through the real plugin, since the
// bug was in the options handed to it.

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * Uses `corsOptions` itself: a hand-mirrored copy is how missing `methods`
 * went unnoticed.
 */
async function serve(allowedFromEnv?: string): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cors, corsOptions(allowedFromEnv));
  instance.post("/agent/chat", { preHandler: requireAuth({}) }, async () => ({
    ok: true,
  }));
  instance.put("/agent/prompt", { preHandler: requireAuth({}) }, async () => ({
    ok: true,
  }));
  return instance;
}

describe("through @fastify/cors, unauthenticated (the default posture)", () => {
  it("does not let a hostile page read a reply", async () => {
    app = await serve();

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/agent/chat",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();

    // CORS is enforced by the browser; without allow-origin the page can't read
    // the response.
    const post = await app.inject({
      method: "POST",
      url: "/agent/chat",
      headers: { origin: "https://evil.example" },
      payload: {},
    });
    expect(post.statusCode).toBe(200);
    expect(post.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses a lookalike that merely starts like an allowed origin", async () => {
    // Pins exact matching, not prefix.
    app = await serve();
    for (const origin of [
      "http://localhost:5173.evil.example",
      "http://tauri.localhost.evil.example",
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/agent/chat",
        headers: { origin },
        payload: {},
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("still lets the desktop app through, on either platform's protocol", async () => {
    app = await serve();
    for (const origin of ["tauri://localhost", "http://tauri.localhost"]) {
      const res = await app.inject({
        method: "POST",
        url: "/agent/chat",
        headers: { origin },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("still lets the Vite dev server through, on either loopback spelling", async () => {
    app = await serve();
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"]) {
      const res = await app.inject({
        method: "POST",
        url: "/agent/chat",
        headers: { origin },
        payload: {},
      });
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("still serves a caller that sends no Origin at all", async () => {
    app = await serve();
    const res = await app.inject({
      method: "POST",
      url: "/agent/chat",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("honours origins declared in the environment, and only those", async () => {
    app = await serve(" http://192.168.1.50:5173 , http://proxy.lan ,");

    for (const origin of ["http://192.168.1.50:5173", "http://proxy.lan"]) {
      const res = await app.inject({
        method: "POST",
        url: "/agent/chat",
        headers: { origin },
        payload: {},
      });
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
    }

    const neighbour = await app.inject({
      method: "POST",
      url: "/agent/chat",
      headers: { origin: "http://192.168.1.51:5173" },
      payload: {},
    });
    expect(neighbour.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("is just the built-ins when the variable is unset or empty", async () => {
    expect(allowedOrigins(undefined)).toEqual(allowedOrigins(""));
    expect(allowedOrigins(" , ,")).toEqual(allowedOrigins(undefined));
    expect(allowedOrigins(undefined)).toContain("tauri://localhost");
  });

  // @fastify/cors defaults to GET/HEAD/POST, so PUT and DELETE failed silently in
  // the browser while curl worked.
  it("lets the browser use the verbs the app actually needs", async () => {
    app = await serve();
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/agent/prompt",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PUT",
      },
    });

    const allowed = String(preflight.headers["access-control-allow-methods"])
      .split(",")
      .map((m) => m.trim());
    expect(allowed).toEqual(expect.arrayContaining(["PUT", "DELETE"]));
  });

  it("carries a real PUT through with a readable reply", async () => {
    app = await serve();
    const res = await app.inject({
      method: "PUT",
      url: "/agent/prompt",
      headers: { origin: "http://localhost:5173" },
      payload: { maxTokens: 4096 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
  });
});
