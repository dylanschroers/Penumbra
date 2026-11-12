import { issueDeviceInput } from "@penumbra/shared";
import type { FastifyInstance } from "fastify";
import { isLoopback, requireAuth, sharedSecret } from "../http/auth";
import type { DeviceStore } from "./store";

// Behind the gate they administer: loopback enrols the first device, whose
// token then enrols the next from anywhere.

export interface DeviceRouteOptions {
  devices: DeviceStore;
  token?: string;
}

export function registerDeviceRoutes(
  app: FastifyInstance,
  { devices, token = process.env.PENUMBRA_AGENT_TOKEN }: DeviceRouteOptions,
): void {
  const preHandler = requireAuth({ token, devices });

  // Ungated so an uncredentialed device can learn whether it may enrol. Uses the
  // gate's own `sharedSecret` helper so both agree on an empty env var.
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
    // The only response that ever contains the token.
    return reply.code(201).send(devices.issue(parsed.data.label));
  });

  app.delete<{ Params: { id: string } }>(
    "/auth/devices/:id",
    { preHandler },
    async (req, reply) => {
      if (!devices.revoke(req.params.id)) {
        // Unknown and already-revoked both mean "no access", so one answer.
        return reply.code(404).send({
          error: "not_found",
          message: "No device with that id still has access.",
        });
      }
      return reply.code(204).send();
    },
  );
}
