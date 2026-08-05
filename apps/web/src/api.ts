// The Penumbra server's gate, for the plain request/response routes (/lab/*,
// /compute/*, /agent/prompt). Everything goes through the server and never to
// Studio directly: the Studio key is an unscoped admin credential that must not
// reach a browser (docs/MODEL_LAB.md → Deployment topology).
//
// The address comes from ./serverAddress, read per request. It used to be a
// build-time constant here while SyncClient held a separate runtime-editable
// one, so setting an address in the status pill moved sync and the pill but not
// the Lab — the pill then reported "Connected" about a server this file was not
// calling.

import { authHeaders, getServerUrl } from "./serverAddress";

export { getAgentToken, getServerUrl } from "./serverAddress";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Declare the JSON content-type only when there is a body to describe. Fastify
  // rejects an empty body sent with `application/json`
  // (FST_ERR_CTP_EMPTY_JSON_BODY), so a bodyless POST or DELETE — launch Studio,
  // revert a target, cancel a job — would 400 before its handler ran if this
  // header rode along unconditionally. A GET never carried a body either; the
  // header only ever survived on those because Fastify skips body parsing there.
  const headers: Record<string, string> = { ...authHeaders() };
  if (init?.body != null) headers["Content-Type"] = "application/json";

  // Address and bearer both read per request, never captured: the status pill
  // can change either between one call and the next.
  const res = await fetch(`${getServerUrl()}${path}`, { ...init, headers });
  if (!res.ok) {
    // The server's error codes are meaningful (busy, no_checkpoint,
    // lm_eval_missing, address_required); surface them rather than a bare
    // status.
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `server responded ${res.status}`);
  }
  // A 204 carries no body — parsing one as JSON would throw. Revoking a device
  // is the caller that returns one.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
