import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGatewayUsage } from "./gatewayUsage";

const config = {
  baseURL: "http://g:8090/",
  model: "route",
  apiKey: "gw-key",
  label: "GoModel",
};

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchGatewayUsage", () => {
  it("turns GoModel's rules and summary into limits and today's totals", async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith("/admin/rate-limits")
        ? json({
            server_time: "2026-11-06T18:32:34Z",
            rate_limits: [
              {
                subject: "openai-nvidia",
                period_seconds: 60,
                max_requests: 40,
                requests_used: 12,
                max_tokens: 0,
                tokens_used: 900,
                window_end: "2026-11-06T18:33:00Z",
              },
            ],
          })
        : json({ total_requests: 59, total_tokens: 249373 }),
    );
    vi.stubGlobal("fetch", fetch);

    expect(await fetchGatewayUsage(config, "America/New_York")).toEqual({
      limits: [
        {
          subject: "openai-nvidia",
          unit: "requests",
          used: 12,
          max: 40,
          periodSeconds: 60,
          resetsAt: "2026-11-06T18:33:00Z",
        },
      ],
      today: { requests: 59, tokens: 249373 },
      serverTime: "2026-11-06T18:32:34Z",
    });
    const summary = fetch.mock.calls.find(([u]) => u.includes("/summary"));
    expect(summary?.[0]).toBe("http://g:8090/admin/usage/summary?days=1");
    expect(summary?.[1]?.headers).toMatchObject({
      Authorization: "Bearer gw-key",
      "X-GoModel-Timezone": "America/New_York",
    });
  });

  it("throws when the gateway refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401 }) as Response),
    );
    await expect(fetchGatewayUsage(config)).rejects.toThrow(/401/);
  });
});
