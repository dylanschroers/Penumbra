import { z } from "zod";

// Wire contracts for device access tokens: which devices may call the gated
// routes, and how one is added or taken away.
//
// Shared rather than server-local for the reason the compute contracts are: the
// panel that manages these is a client, and the two have to agree about the
// shape or they drift silently.
//
// Note what the device schema does not carry: the token. It exists in cleartext
// exactly once, in the response to a mint, and is a hash everywhere after that.

export const device = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
  /** Null until the device has presented its token at least once — which is
   *  how "I minted this and never managed to paste it in" is visible. */
  lastSeenAt: z.string().nullable(),
  /** Set when access was taken away. Revoked devices stay listed: "this used to
   *  have access and no longer does" is the question an audit asks. */
  revokedAt: z.string().nullable(),
});

/** A label is required because the list is for telling devices apart, and a
 *  page of unnamed rows cannot answer which one to revoke. */
export const issueDeviceInput = z.object({
  label: z.string().min(1).max(80),
});

/**
 * What a client is allowed to see about device management, from where it sits.
 *
 * The client cannot know its own vantage point relative to the server — whether
 * it is calling from the server's own machine or across the network — so the
 * server reports it. Ungated, because a device with no credential yet still
 * needs to learn whether it is in a position to enrol one.
 *
 * `loopback` is the whole basis for hiding admin controls off-machine for now.
 * A later admin flag will widen that, but until then "same machine" is the only
 * thing that grants management, and only the server can attest to it.
 */
export const authContext = z.object({
  loopback: z.boolean(),
  /** Whether a shared secret is set, so the UI can say a token is needed rather
   *  than let the user find out by being refused. No more than the gate's own
   *  401-vs-403 already discloses. */
  requiresToken: z.boolean(),
});

/**
 * The mint response. The only time the token is ever returned.
 *
 * Separate from `device` so this cannot be handed back by a listing route by
 * accident — the type simply has no token field to fill.
 */
export const issuedDevice = z.object({
  device,
  token: z.string(),
});

export type Device = z.infer<typeof device>;
export type IssueDeviceInput = z.infer<typeof issueDeviceInput>;
export type IssuedDevice = z.infer<typeof issuedDevice>;
export type AuthContext = z.infer<typeof authContext>;
