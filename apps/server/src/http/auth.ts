import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DeviceStore } from "../devices/store";

// The gate for every endpoint that *acts* rather than moves data.
//
// /sync/tasks runs without auth on purpose (single user, LAN — docs/SYNC.md).
// The agent and lab routes are a different class: they run models with write
// and delete tools, spawn training jobs, write files, and cost GPU. They carry
// their own gate so that posture never has to be relaxed for them.
//
// Two kinds of bearer are accepted, and the order matters.
//
// A **device token** (../devices/store) is the one to use: issued per device,
// stored only as a hash, and revocable on its own without disturbing anything
// else. A **shared secret** from PENUMBRA_AGENT_TOKEN is the older scheme, kept
// because it is how existing deployments already authenticate — and because a
// server reachable only off-loopback needs some way to enrol its first device.

/** Loopback callers are inside the trust boundary the v0 model assumes. It is
 *  also the enrolment path: the first device is issued from the machine the
 *  server runs on, where there is no credential to present yet. */
function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/** The bearer presented, or null. */
function bearerOf(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length) || null;
}

/**
 * Compare without leaking the answer through timing.
 *
 * `!==` on strings returns at the first differing byte, which in principle lets
 * a caller learn a shared secret one character at a time. Only the shared
 * secret needs this — a device token is found by hash lookup, so there is no
 * per-character comparison to observe.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch. The lengths are not the secret,
  // so returning early on them leaks nothing worth having.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface AuthOptions {
  /** PENUMBRA_AGENT_TOKEN, when one is set. */
  token?: string;
  /** Issued device tokens. Absent only in tests that exercise the old path. */
  devices?: DeviceStore;
}

export function requireAuth({ token, devices }: AuthOptions) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const bearer = bearerOf(req.headers.authorization);

    if (bearer) {
      if (devices?.verify(bearer)) return;
      if (token && safeEqual(bearer, token)) return;
      // Something was presented and it was not good. Kept distinct from
      // presenting nothing: this is a credential to replace, not one to obtain.
      await reply.code(401).send({
        error: "unauthorized",
        message: "That access token is not valid, or has been revoked.",
      });
      return;
    }

    // Nothing presented. A server with a shared secret set requires it from
    // everyone, loopback included — unchanged from when that was the only
    // scheme.
    if (token) {
      await reply.code(401).send({
        error: "unauthorized",
        message: "This server requires an access token.",
      });
      return;
    }

    if (isLoopback(req.ip)) return;

    await reply.code(403).send({
      error: "local_only",
      message:
        "This route serves loopback only. Add a device from the server machine, or set PENUMBRA_AGENT_TOKEN.",
    });
  };
}
