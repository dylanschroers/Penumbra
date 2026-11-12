import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DeviceStore } from "../devices/store";

// Gate for routes that act rather than move data. /sync/tasks is ungated on
// purpose. Accepts a device token (preferred) or PENUMBRA_AGENT_TOKEN, which
// also lets an off-loopback-only server enrol its first device.

/** Loopback is the trust boundary and the enrolment path. */
export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function bearerOf(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length) || null;
}

/** Only the shared secret needs this; device tokens are looked up by hash. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on length mismatch; lengths aren't secret.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * An empty `PENUMBRA_AGENT_TOKEN=` means no secret. Everything reporting on the
 * gate must use this so they agree.
 */
export function sharedSecret(raw: string | undefined): string | undefined {
  return raw || undefined;
}

export interface AuthOptions {
  token?: string;
  devices?: DeviceStore;
}

export function requireAuth({ token, devices }: AuthOptions) {
  const secret = sharedSecret(token);
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const bearer = bearerOf(req.headers.authorization);

    if (bearer) {
      if (devices?.verify(bearer)) return;
      if (secret && safeEqual(bearer, secret)) return;
      // 401: something was presented and rejected.
      await reply.code(401).send({
        error: "unauthorized",
        message: "That access token is not valid, or has been revoked.",
      });
      return;
    }

    // A set shared secret is required from everyone, loopback included.
    if (secret) {
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
