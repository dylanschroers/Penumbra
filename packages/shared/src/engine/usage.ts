import { z } from "zod";

// How much of a gateway's provider limits the user has spent, for the usage bar.
// The numbers come from the gateway's own counters (GoModel's rate-limit rules
// and usage log), because the free providers report nothing back themselves.

export const gatewayLimit = z.object({
  /** What the rule caps, e.g. the provider "openai-nvidia". */
  subject: z.string(),
  /** What is being counted. */
  unit: z.enum(["requests", "tokens"]),
  used: z.number(),
  max: z.number(),
  /** Length of the window, e.g. 60 for "per minute". */
  periodSeconds: z.number(),
  /** When the current window ends, as the gateway's clock reads it. */
  resetsAt: z.string(),
});

export const gatewayUsage = z.object({
  limits: z.array(gatewayLimit),
  /** Totals since local midnight on the server. */
  today: z.object({ requests: z.number(), tokens: z.number() }),
  /** The gateway's clock when it answered, so `resetsAt` can be turned into a
   *  countdown without trusting the client's clock to match. */
  serverTime: z.string(),
});

export type GatewayLimit = z.infer<typeof gatewayLimit>;
export type GatewayUsage = z.infer<typeof gatewayUsage>;
