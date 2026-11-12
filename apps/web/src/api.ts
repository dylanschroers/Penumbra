// Everything goes through the Penumbra server, never Studio. Address and
// bearer are read per request from ./serverAddress so the status pill's
// changes apply everywhere.

import { authHeaders, getServerUrl } from "./serverAddress";

export { getAgentToken, getServerUrl } from "./serverAddress";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Only with a body: Fastify rejects an empty body declared as JSON
  // (FST_ERR_CTP_EMPTY_JSON_BODY).
  const headers: Record<string, string> = { ...authHeaders() };
  if (init?.body != null) headers["Content-Type"] = "application/json";

  const res = await fetch(`${getServerUrl()}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `server responded ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
