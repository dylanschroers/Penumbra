import { describe, expect, it } from "vitest";
import { normalizeBaseUrl } from "./index";

describe("normalizeBaseUrl", () => {
  it("leaves a well-formed URL alone", () => {
    expect(normalizeBaseUrl("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    expect(normalizeBaseUrl("https://penumbra.example")).toBe(
      "https://penumbra.example",
    );
  });

  // The case that silently broke sync: a relative path answered by the dev
  // server's SPA fallback with 200 and a body of HTML.
  it("adds a scheme to a bare host:port", () => {
    expect(normalizeBaseUrl("172.29.78.53:3000")).toBe(
      "http://172.29.78.53:3000",
    );
    expect(normalizeBaseUrl("localhost:8080")).toBe("http://localhost:8080");
  });

  it("strips trailing slashes so paths do not double up", () => {
    expect(normalizeBaseUrl("http://localhost:3000/")).toBe(
      "http://localhost:3000",
    );
    expect(normalizeBaseUrl("http://localhost:3000///")).toBe(
      "http://localhost:3000",
    );
  });

  it("tolerates surrounding whitespace from a .env line", () => {
    expect(normalizeBaseUrl("  http://localhost:3000  ")).toBe(
      "http://localhost:3000",
    );
  });
});
