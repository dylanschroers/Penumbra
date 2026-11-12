import { describe, expect, it } from "vitest";
import { trustProxyFromEnv } from "./trustProxy";

// The regression to guard: a boolean honoured as "trust everyone".

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

  // "true" would let a direct client spoof a loopback X-Forwarded-For.
  it("refuses a boolean rather than trusting every proxy", () => {
    expect(() => trustProxyFromEnv("true")).toThrow(/boolean/);
    expect(() => trustProxyFromEnv("TRUE")).toThrow();
    expect(() => trustProxyFromEnv("false")).toThrow();
  });
});
