import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { msUntilReset, UsageMeter } from "./UsageMeter";

const limit = {
  subject: "openai-nvidia",
  unit: "requests" as const,
  used: 30,
  max: 40,
  periodSeconds: 60,
  resetsAt: "2026-11-06T18:33:00Z",
};
const reading = {
  usage: {
    limits: [limit],
    today: { requests: 59, tokens: 249373 },
    serverTime: "2026-11-06T18:32:34Z",
  },
  receivedAt: 1_000_000,
};

afterEach(() => vi.useRealTimers());

describe("msUntilReset", () => {
  it("counts down on the gateway's clock, not the client's", () => {
    expect(
      msUntilReset(limit, reading.usage.serverTime, 1_000_000, 1_000_000),
    ).toBe(26_000);
    expect(
      msUntilReset(limit, reading.usage.serverTime, 1_000_000, 1_010_000),
    ).toBe(16_000);
  });
});

describe("UsageMeter", () => {
  it("shows the limit, how full it is, the reset, and today's totals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<UsageMeter reading={reading} />));
    expect(host.textContent).toContain("nvidia · 30/40 requests per min");
    expect(host.textContent).toContain("resets in 26s");
    expect(host.textContent).toContain("Today: 59 requests · 249k tokens");
    expect(host.querySelector(".usage__fill--high")).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(host.textContent).toContain("resets in 16s");
    await act(async () => root.unmount());
  });

  it("leaves out the countdown while nothing is used", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const idle = {
      ...reading,
      usage: { ...reading.usage, limits: [{ ...limit, used: 0 }] },
    };
    await act(async () => root.render(<UsageMeter reading={idle} />));
    expect(host.textContent).not.toContain("resets");
    await act(async () => root.unmount());
  });
});
