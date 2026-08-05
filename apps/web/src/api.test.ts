import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { authHeaders } from "./serverAddress";

// api() sets one header conditionally, and getting it wrong is invisible until a
// real server rejects it: Fastify 400s an empty body sent with
// application/json, so a JSON content-type on a bodyless request breaks launch,
// revert, and cancel — none of which app.inject-based route tests can see,
// because inject sends no such header.

vi.mock("./serverAddress", () => ({
  getServerUrl: vi.fn(() => "http://server:3000"),
  authHeaders: vi.fn(() => ({})),
  getAgentToken: vi.fn(),
}));

const mockFetch = vi.fn();
const headersOf = (): Record<string, string> =>
  mockFetch.mock.calls[0]![1].headers;

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  });
  vi.mocked(authHeaders).mockReturnValue({});
});
afterEach(() => vi.clearAllMocks());

describe("content-type", () => {
  it("is omitted on a bodyless request, so Fastify does not 400 an empty body", async () => {
    await api("/compute/targets/local/launch", { method: "POST" });
    expect(headersOf()["Content-Type"]).toBeUndefined();
  });

  it("is set when there is a body to describe", async () => {
    await api("/compute/targets/local/load", {
      method: "POST",
      body: JSON.stringify({ model: "x" }),
    });
    expect(headersOf()["Content-Type"]).toBe("application/json");
  });

  it("is omitted on a plain GET", async () => {
    await api("/compute/targets");
    expect(headersOf()["Content-Type"]).toBeUndefined();
  });
});

describe("auth", () => {
  it("carries the bearer whether or not there is a body", async () => {
    vi.mocked(authHeaders).mockReturnValue({ Authorization: "Bearer t" });
    await api("/compute/targets/local/launch", { method: "POST" });
    expect(headersOf().Authorization).toBe("Bearer t");
  });
});

describe("responses", () => {
  it("returns undefined for a 204 rather than parsing an empty body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("no body to parse");
      },
    });
    expect(await api("/auth/devices/x", { method: "DELETE" })).toBeUndefined();
  });

  it("surfaces the server's message on an error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: "already running" }),
    });
    await expect(api("/x")).rejects.toThrow("already running");
  });
});
