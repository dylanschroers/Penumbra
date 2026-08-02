import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { requireAuth } from "./auth";
import { corsOriginPolicy, isAllowedOrigin, parseAllowedOrigins } from "./cors";

// The hole this closes, stated once: `origin: true` reflected whatever Origin a
// caller sent, and ./auth exempts loopback when no token is set. A browser
// dials localhost *from* 127.0.0.1, so any page the user happened to have open
// could POST /agent/chat and read the reply. The unit tests below pin the
// policy; the integration block proves it through the real plugin, because the
// bug was never in a predicate — it was in what got handed to @fastify/cors.

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("isAllowedOrigin", () => {
  it("allows the desktop app on every platform's protocol", () => {
    expect(isAllowedOrigin("tauri://localhost")).toBe(true);
    expect(isAllowedOrigin("http://tauri.localhost")).toBe(true);
  });

  it("allows the Vite dev server on either loopback spelling", () => {
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5173")).toBe(true);
  });

  it("refuses an origin nobody configured", () => {
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
  });

  it("refuses a lookalike that merely starts the same", () => {
    // Substring matching would pass both of these, and both are registrable.
    expect(isAllowedOrigin("http://localhost:5173.evil.example")).toBe(false);
    expect(isAllowedOrigin("http://tauri.localhost.evil.example")).toBe(false);
  });

  it("treats a missing Origin as not-a-browser rather than as hostile", () => {
    // curl, a native fetch, another service. CORS governs what a page may read
    // and has nothing to say about these; ./auth is still in front of them.
    expect(isAllowedOrigin(undefined)).toBe(true);
  });

  it("allows an origin named in the environment", () => {
    // The server is meant to be reachable from another machine, so the origin
    // serving the web build cannot be predicted — only declared.
    expect(
      isAllowedOrigin("http://192.168.1.50:5173", ["http://192.168.1.50:5173"]),
    ).toBe(true);
    expect(
      isAllowedOrigin("http://192.168.1.51:5173", ["http://192.168.1.50:5173"]),
    ).toBe(false);
  });
});

describe("parseAllowedOrigins", () => {
  it("splits a comma-separated list and trims it", () => {
    expect(parseAllowedOrigins(" a , b ,c ")).toEqual(["a", "b", "c"]);
  });

  it("reads unset or empty as no extra origins", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins(" , ,")).toEqual([]);
  });
});

describe("through @fastify/cors, unauthenticated (the default posture)", () => {
  /** A server wired exactly as main.ts wires it, with no token set. */
  async function serve(allowedFromEnv?: string): Promise<FastifyInstance> {
    const instance = Fastify();
    await instance.register(cors, { origin: corsOriginPolicy(allowedFromEnv) });
    instance.post(
      "/agent/chat",
      { preHandler: requireAuth(undefined) },
      async () => ({ ok: true }),
    );
    return instance;
  }

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

    // The POST still reaches the handler — CORS is enforced in the browser, not
    // on the wire — but with no allow-origin header the response is unreadable
    // to the page that asked for it, which is the whole protection.
    const post = await app.inject({
      method: "POST",
      url: "/agent/chat",
      headers: { origin: "https://evil.example" },
      payload: {},
    });
    expect(post.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("still lets the desktop app through", async () => {
    app = await serve();
    const res = await app.inject({
      method: "POST",
      url: "/agent/chat",
      headers: { origin: "tauri://localhost" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "tauri://localhost",
    );
  });

  it("still serves a caller that sends no Origin at all", async () => {
    app = await serve();
    const res = await app.inject({
      method: "POST",
      url: "/agent/chat",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it("honours an origin declared in the environment", async () => {
    app = await serve("http://192.168.1.50:5173");
    const res = await app.inject({
      method: "POST",
      url: "/agent/chat",
      headers: { origin: "http://192.168.1.50:5173" },
      payload: {},
    });
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://192.168.1.50:5173",
    );
  });
});
