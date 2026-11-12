import { z } from "zod";

// The token is never in `device`: it exists in cleartext only in the mint
// response.

export const device = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
  /** Null until the token is first presented. */
  lastSeenAt: z.string().nullable(),
  /** Revoked devices stay listed. */
  revokedAt: z.string().nullable(),
});

export const issueDeviceInput = z.object({
  label: z.string().min(1).max(80),
});

/**
 * Ungated: a device with no credential still needs to learn whether it can
 * enrol one. `loopback` is the only thing that grants device management.
 */
export const authContext = z.object({
  loopback: z.boolean(),
  requiresToken: z.boolean(),
});

/**
 * The only response that carries the token; a separate type so a listing can't
 * leak it.
 */
export const issuedDevice = z.object({
  device,
  token: z.string(),
});

export type Device = z.infer<typeof device>;
export type IssueDeviceInput = z.infer<typeof issueDeviceInput>;
export type IssuedDevice = z.infer<typeof issuedDevice>;
export type AuthContext = z.infer<typeof authContext>;
