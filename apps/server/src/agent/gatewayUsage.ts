import {
  type GatewayLimit,
  type GatewayUsage,
  normalizeBaseUrl,
} from "@penumbra/shared";
import type { GatewayConfig } from "./GatewayEngine";

// Usage as GoModel counts it, read through its admin API with the same key chat
// uses. Limits come from its rate-limit rules (one per provider limit the user
// has declared); today's totals from its usage log.

const TIMEOUT_MS = 3000;

interface RateLimitRow {
  subject: string;
  period_seconds: number;
  max_requests?: number;
  max_tokens?: number;
  requests_used?: number;
  tokens_used?: number;
  window_end: string;
}

async function get<T>(
  config: GatewayConfig,
  path: string,
  headers = {},
): Promise<T> {
  const res = await fetch(`${normalizeBaseUrl(config.baseURL)}${path}`, {
    headers: {
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gateway ${path} responded ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchGatewayUsage(
  config: GatewayConfig,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Promise<GatewayUsage> {
  const [limits, today] = await Promise.all([
    get<{ rate_limits?: RateLimitRow[]; server_time: string }>(
      config,
      "/admin/rate-limits",
    ),
    get<{ total_requests?: number; total_tokens?: number }>(
      config,
      "/admin/usage/summary?days=1",
      { "X-GoModel-Timezone": timeZone },
    ),
  ]);
  const rows: GatewayLimit[] = [];
  for (const r of limits.rate_limits ?? []) {
    const base = {
      subject: r.subject,
      periodSeconds: r.period_seconds,
      resetsAt: r.window_end,
    };
    if (r.max_requests) {
      rows.push({
        ...base,
        unit: "requests",
        used: r.requests_used ?? 0,
        max: r.max_requests,
      });
    }
    if (r.max_tokens) {
      rows.push({
        ...base,
        unit: "tokens",
        used: r.tokens_used ?? 0,
        max: r.max_tokens,
      });
    }
  }
  return {
    limits: rows,
    today: {
      requests: today.total_requests ?? 0,
      tokens: today.total_tokens ?? 0,
    },
    serverTime: limits.server_time,
  };
}
