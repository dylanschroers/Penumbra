import type { GatewayLimit } from "@penumbra/shared";
import { useEffect, useState } from "react";
import type { UsageReading } from "./useGatewayUsage";

const PERIOD: Record<number, string> = {
  60: "min",
  3600: "hour",
  86400: "day",
};

function period(seconds: number): string {
  return PERIOD[seconds] ?? `${seconds}s`;
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Milliseconds until `limit` resets, measured on the gateway's clock as of the
 *  reading and run forward by local time since, so a skewed client clock cannot
 *  move it. */
export function msUntilReset(
  limit: GatewayLimit,
  serverTime: string,
  receivedAt: number,
  now: number,
): number {
  const atReading = Date.parse(limit.resetsAt) - Date.parse(serverTime);
  return atReading - (now - receivedAt);
}

function Row({
  limit,
  reading,
  now,
}: {
  limit: GatewayLimit;
  reading: UsageReading;
  now: number;
}) {
  const share = limit.max > 0 ? Math.min(1, limit.used / limit.max) : 0;
  const level = share >= 0.9 ? "full" : share >= 0.7 ? "high" : "ok";
  const name = limit.subject.replace(/^openai-/, "");
  const left = msUntilReset(
    limit,
    reading.usage.serverTime,
    reading.receivedAt,
    now,
  );
  return (
    <div className="usage__row">
      <span className="usage__label">
        {name} · {compact(limit.used)}/{compact(limit.max)} {limit.unit} per{" "}
        {period(limit.periodSeconds)}
      </span>
      <span className="usage__bar" aria-hidden="true">
        <span
          className={`usage__fill usage__fill--${level}`}
          style={{ width: `${share * 100}%` }}
        />
      </span>
      <span className="usage__reset">
        {limit.used > 0 ? `resets in ${countdown(left)}` : ""}
      </span>
    </div>
  );
}

/** The gateway's provider limits as bars, with today's totals beneath. */
export function UsageMeter({ reading }: { reading: UsageReading }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const { limits, today } = reading.usage;
  return (
    <div className="usage">
      {limits.map((limit) => (
        <Row
          key={`${limit.subject}:${limit.unit}:${limit.periodSeconds}`}
          limit={limit}
          reading={reading}
          now={now}
        />
      ))}
      <div className="usage__today">
        Today: {today.requests.toLocaleString()} requests ·{" "}
        {compact(today.tokens)} tokens
      </div>
    </div>
  );
}
