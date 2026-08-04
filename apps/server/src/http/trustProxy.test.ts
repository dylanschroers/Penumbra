import { describe, expect, it } from "vitest";
import { trustProxyFromEnv } from "./trustProxy";

// This value decides what req.ip means, and req.ip decides who the auth gate
// treats as local. The case that must never regress is a boolean being honoured
// as "trust everyone" — that is the hole the whole setting exists to close.

describe("trustProxyFromEnv", () => {
  it("defaults to false, preserving the socket peer as req.ip", () => {
    expect(trustProxyFromEnv(undefined)).toBe(false);
    expect(trustProxyFromEnv("")).toBe(false);
    expect(trustProxyFromEnv("   ")).toBe(false);
  });

  it("reads an all-digit value as a hop count", () => {
    expect(trustProxyFromEnv("1")).toBe(1);
    expect(trustProxyFromEnv(" 2 ")).toBe(2);
  });

  it("passes an address or CIDR through for proxy-addr", () => {
    expect(trustProxyFromEnv("127.0.0.1")).toBe("127.0.0.1");
    expect(trustProxyFromEnv("10.0.0.0/8, 127.0.0.1")).toBe(
      "10.0.0.0/8, 127.0.0.1",
    );
  });

  // The footgun: "true" would trust X-Forwarded-For from any peer, so a direct
  // client could spoof a loopback address. Rejected loudly at boot instead.
  it("refuses a boolean rather than trusting every proxy", () => {
    expect(() => trustProxyFromEnv("true")).toThrow(/boolean/);
    expect(() => trustProxyFromEnv("TRUE")).toThrow();
    expect(() => trustProxyFromEnv("false")).toThrow();
  });
});
