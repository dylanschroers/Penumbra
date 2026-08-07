import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { requireAuth } from "./auth";
import { allowedOrigins, corsOptions } from "./cors";

// The hole this closes, stated once: `origin: true` reflected whatever Origin a
// caller sent, and ./auth exempts loopback when no token is set. A browser
// dials localhost *from* 127.0.0.1, so any page the user happened to have open
// could POST /agent/chat and read the reply.
//
// Everything below goes through the real plugin. The bug was never in a
// predicate of ours — it was in what got handed to @fastify/cors — and now that
// the policy *is* a list, the matching is the plugin's to do, so asserting on
// the list alone would prove nothing about what the server answers.

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * A server wired exactly as main.ts wires it, with no token set.
 *
 * Registers `corsOptions(...)` rather than rebuilding the options here. The
 * hand-mirrored version of this helper is how the missing `methods` survived:
 * it reproduced the incomplete config and then proved the origin half worked.
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

    // The POST still reaches the handler — CORS is enforced in the browser, not
    // on the wire — but with no allow-origin header the response is unreadable
    // to the page that asked for it, which is the whole protection.
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
    // Both of these are registrable, and prefix matching would pass both. The
    // list is only as good as the plugin's comparison, so pin that it is exact.
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
    // curl, a native fetch, another service. They get no allow-origin header
    // and do not care: it is a header only a browser reads. ./auth gates them.
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
    // The server is meant to be reachable from another machine, so the origin
    // serving the web build cannot be predicted — only declared.
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

  // A preflight the plugin answers without the verb is a request the browser
  // never sends: no log line, no status, just "Failed to fetch" in the page.
  // @fastify/cors defaults to the three simple methods, so every PUT and DELETE
  // in the app — prompt save, prompt reset, forget target, revoke device — was
  // refused in the browser while curl sailed through.
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
