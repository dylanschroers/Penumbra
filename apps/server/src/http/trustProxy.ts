// How much of X-Forwarded-For to believe, from the environment.
//
// Fastify's req.ip is the socket peer by default — whoever opened the TCP
// connection. The auth gate leans on that: a loopback peer is inside the trust
// boundary and is the path that enrols the first device (http/auth.ts). Put a
// reverse proxy in front, though, and the peer is the proxy — usually
// 127.0.0.1 on the same host — so every forwarded request would read as
// loopback and anyone reaching the proxy could mint themselves a device token.
//
// `trustProxy` fixes that by reading the client from X-Forwarded-For instead.
// But it has to trust *only the actual proxy*: `true` trusts the header from
// any peer, which lets a direct client spoof `X-Forwarded-For: 127.0.0.1` and
// appear local. So this takes an address, a CIDR, or a hop count — never a
// blanket boolean — and the two `req.ip` readers inherit the corrected value
// with no change of their own.
//
// The proxy side is not optional: it must *set* X-Forwarded-For to the real
// client (nginx `proxy_set_header X-Forwarded-For $remote_addr`), not pass a
// client-supplied one through. No server setting can recover a header the proxy
// forwards unfiltered.

/**
 * Parse PENUMBRA_TRUST_PROXY into the value Fastify's `trustProxy` expects.
 *
 * - unset / blank → `false`: trust the socket peer, exactly today's behaviour.
 * - all digits → a number: trust that many proxy hops from the socket.
 * - anything else → the string: an IP or CIDR (comma-separated) for proxy-addr.
 *
 * A boolean is rejected rather than honoured. "true" would trust every peer's
 * forwarded header — the very hole this exists to close — so making it an error
 * at boot is safer than letting it mean what it says, or silently ignoring it.
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
