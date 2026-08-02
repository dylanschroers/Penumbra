import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { requireAuth } from "./auth";
import { allowedOrigins } from "./cors";

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

/** A server wired exactly as main.ts wires it, with no token set. */
async function serve(allowedFromEnv?: string): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cors, { origin: allowedOrigins(allowedFromEnv) });
  instance.post(
    "/agent/chat",
    { preHandler: requireAuth(undefined) },
    async () => ({ ok: true }),
  );
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
});
