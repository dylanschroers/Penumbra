import { type GatewayUsage, gatewayUsage } from "@penumbra/shared";
import { useEffect, useState } from "react";
import { authHeaders, getServerUrl } from "../../serverAddress";

const POLL_MS = 5000;

export interface UsageReading {
  usage: GatewayUsage;
  /** Local time the reading arrived, to count down from. */
  receivedAt: number;
}

/** Gateway limits and today's totals, polled while `enabled`. Null until the
 *  first reading, and again whenever the server has no gateway to ask. */
export function useGatewayUsage(enabled: boolean): UsageReading | null {
  const [reading, setReading] = useState<UsageReading | null>(null);

  useEffect(() => {
    if (!enabled) {
      setReading(null);
      return;
    }
    let live = true;
    const poll = async () => {
      try {
        const res = await fetch(`${getServerUrl()}/agent/usage`, {
          headers: authHeaders(),
          signal: AbortSignal.timeout(POLL_MS),
        });
        const parsed = res.ok ? gatewayUsage.safeParse(await res.json()) : null;
        if (!live) return;
        setReading(
          parsed?.success
            ? { usage: parsed.data, receivedAt: Date.now() }
            : null,
        );
      } catch {
        // Keep the last reading; the next poll may get through.
      }
    };
    void poll();
    const id = setInterval(() => {
      if (!document.hidden) void poll();
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [enabled]);

  return reading;
}
