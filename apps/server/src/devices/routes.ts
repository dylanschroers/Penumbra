import { issueDeviceInput } from "@penumbra/shared";
import type { FastifyInstance } from "fastify";
import { isLoopback, requireAuth, sharedSecret } from "../http/auth";
import type { DeviceStore } from "./store";

// Managing which devices may call the gated routes.
//
// These sit behind the same gate they administer, which is deliberate and is
// what makes the bootstrap work: on a server with nothing set up, loopback is
// allowed, so the first device is added from the machine the server runs on.
// After that the device token it was issued reaches this route from anywhere,
// and can add the next one.
//
// The alternative — leaving these open so a device could enrol itself — would
// mean anyone who can reach the port can grant themselves access, which is the
// whole thing the gate exists to prevent.

export interface DeviceRouteOptions {
  devices: DeviceStore;
  token?: string;
}

export function registerDeviceRoutes(
  app: FastifyInstance,
  { devices, token = process.env.PENUMBRA_AGENT_TOKEN }: DeviceRouteOptions,
): void {
  const preHandler = requireAuth({ token, devices });

  // Ungated on purpose: a device with no credential still needs to learn whether
  // it can enrol one. Says only what the gate's own 401-vs-403 already would —
  // and says it by asking the gate's own helper, so an empty
  // PENUMBRA_AGENT_TOKEN reads as no secret here exactly as it does there.
  app.get("/auth/context", async (req) => ({
    loopback: isLoopback(req.ip),
    requiresToken: sharedSecret(token) !== undefined,
  }));

  app.get("/auth/devices", { preHandler }, async () => devices.list());

  app.post("/auth/devices", { preHandler }, async (req, reply) => {
    const parsed = issueDeviceInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: "A device needs a label to be told apart from the others.",
      });
    }
    // 201 with the token in the body. This is the only response that will ever
    // contain it, which the client has to know so it can show it once rather
    // than assume it can fetch it back later.
    return reply.code(201).send(devices.issue(parsed.data.label));
  });

  app.delete<{ Params: { id: string } }>(
    "/auth/devices/:id",
    { preHandler },
    async (req, reply) => {
      if (!devices.revoke(req.params.id)) {
        // Unknown and already-revoked collapse into one answer on purpose:
        // both mean "this id has no access", which is what was asked for.
        return reply.code(404).send({
          error: "not_found",
          message: "No device with that id still has access.",
        });
      }
      return reply.code(204).send();
    },
  );
}
