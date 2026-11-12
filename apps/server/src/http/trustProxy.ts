// Behind a reverse proxy the socket peer is the proxy (usually loopback), so
// every request would pass the loopback gate. Trust only the proxy itself, by
// address, CIDR, or hop count, never a boolean. The proxy must set
// X-Forwarded-For itself (nginx: `proxy_set_header X-Forwarded-For
// $remote_addr`), not pass a client's through.

/**
 * Unset: trust the socket peer. Digits: hop count. Otherwise IP/CIDR list.
 * "true"/"false" are rejected at boot.
 */
export function trustProxyFromEnv(
  value: string | undefined,
): number | string | false {
  const v = value?.trim();
  if (!v) return false;
  if (/^(true|false)$/i.test(v)) {
    throw new Error(
      "PENUMBRA_TRUST_PROXY must be the proxy's address/CIDR or a hop count, " +
        "not a boolean — trusting every proxy lets a direct client spoof " +
        "X-Forwarded-For and appear local.",
    );
  }
  return /^\d+$/.test(v) ? Number(v) : v;
}
