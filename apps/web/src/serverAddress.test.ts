import { STORAGE_NAMESPACE } from "@penumbra/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  authHeaders,
  getAgentToken,
  getServerUrl,
  setAgentToken,
  setServerUrlValue,
} from "./serverAddress";

// The address and the bearer are one fact split across two fields, and both are
// read per request by api(), RemoteEngine, and the uploads. What is pinned here
// is the part that fails silently: a bearer that is absent, empty, or stale
// produces a 401 or a 403 from routes the status pill never checks.

const TOKEN_KEY = `${STORAGE_NAMESPACE}.server.agent-token.v1`;

beforeEach(() => localStorage.clear());

describe("server address", () => {
  it("normalizes an address set at runtime", () => {
    setServerUrlValue("192.168.1.50:3000/");
    expect(getServerUrl()).toBe("http://192.168.1.50:3000");
  });

  it("is readable immediately after being set, with no reload", () => {
    setServerUrlValue("http://studio.lan:3000");
    expect(getServerUrl()).toBe("http://studio.lan:3000");
  });
});

describe("agent token", () => {
  it("sends no Authorization header when there is no bearer", () => {
    setAgentToken("");
    expect(getAgentToken()).toBeUndefined();
    // Omitted rather than empty: an empty bearer reads as malformed, and a
    // loopback server running without a token would reject it.
    expect(authHeaders()).toEqual({});
  });

  it("sends the bearer once one is set", () => {
    setAgentToken("secret");
    expect(authHeaders()).toEqual({ Authorization: "Bearer secret" });
  });

  it("keeps a deliberately cleared bearer cleared", () => {
    setAgentToken("secret");
    setAgentToken("");
    expect(getAgentToken()).toBeUndefined();
    // The distinction that matters: an empty stored value is a choice, and must
    // not fall back to whatever VITE_AGENT_TOKEN was compiled in.
    expect(localStorage.getItem(TOKEN_KEY)).toBe("");
  });

  it("takes effect on the next call rather than the next reload", () => {
    setAgentToken("first");
    expect(authHeaders()).toEqual({ Authorization: "Bearer first" });
    setAgentToken("second");
    expect(authHeaders()).toEqual({ Authorization: "Bearer second" });
  });

  it("survives a reload", () => {
    setAgentToken("persisted");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("persisted");
  });

  // Changing one must not silently drop the other: toggling between two known
  // servers would otherwise lose a working credential every time.
  it("leaves the address alone", () => {
    setServerUrlValue("http://studio.lan:3000");
    setAgentToken("secret");
    expect(getServerUrl()).toBe("http://studio.lan:3000");
  });
});
