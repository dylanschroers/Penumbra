import { normalizeBaseUrl } from "@penumbra/shared";

// The Penumbra server's address and gate, for the plain request/response routes
// (/lab/*, /compute/*). Everything goes through the server and never to Studio
// directly: the Studio key is an unscoped admin credential that must not reach a
// browser (docs/MODEL_LAB.md → Deployment topology).
//
// SyncClient deliberately keeps its own copy of the server URL, because that one
// is user-editable at runtime; this is the build-time default.

export const SERVER_URL = normalizeBaseUrl(
  import.meta.env.VITE_SERVER_URL ?? "http://localhost:3000",
);

export const TOKEN = import.meta.env.VITE_AGENT_TOKEN;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) {
    // The server's error codes are meaningful (busy, no_checkpoint,
    // lm_eval_missing, address_required); surface them rather than a bare
    // status.
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `server responded ${res.status}`);
  }
  return (await res.json()) as T;
}
