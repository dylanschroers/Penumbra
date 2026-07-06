import { z } from "zod";
import { task } from "./task";

// Wire format for Plane A sync. A "sync row" is a full task row plus the two
// sync columns: a tombstone and the server-assigned version. Both halves of the
// exchange (client push, server pull) speak this shape, so it is the single
// contract the delta-sync rides on. See docs/SYNC.md.

/** A task as it travels over the sync wire. */
export const syncTask = task.extend({
  // A sync row is a *stored* row, where the optional columns are NULL (not
  // absent) when empty — that's what SQLite hands back. The base `task` schema
  // marks these `.optional()` (undefined-only), so widen them to `.nullish()`
  // here or the server rejects every task with no notes / no due date.
  notes: z.string().max(10_000).nullish(),
  dueAt: z.string().datetime().nullish(),
  // Soft-delete tombstone. Present (an ISO datetime) means the row is deleted;
  // a sync row therefore always carries the *full* row, deleted or not.
  deletedAt: z.string().datetime().nullable(),
  // Server-assigned monotonic version. Null only for a locally-created row that
  // has never been accepted by the server (i.e. on the way up in a push).
  rev: z.number().int().nullable(),
});

/** Client → server: rows the client believes are dirty. */
export const pushTasksInput = z.object({
  rows: z.array(syncTask),
});

// Every server response carries `serverId`, the identity of the database that
// issued it. Revs and cursors are only meaningful within one database's
// lifetime (an "epoch"): a client that sees an unfamiliar serverId must
// reconcile — forget its revs and re-offer every row. See docs/SYNC.md.

/** Server → client (push ack): the server's high-water cursor after applying. */
export const pushTasksResult = z.object({
  cursor: z.number().int(),
  serverId: z.string(),
});

/** Server → client (pull): rows with rev past the client's cursor, plus the
 * new high-water cursor to store for next time. */
export const pullTasksResult = z.object({
  rows: z.array(syncTask),
  cursor: z.number().int(),
  serverId: z.string(),
});

export type SyncTask = z.infer<typeof syncTask>;
export type PushTasksInput = z.infer<typeof pushTasksInput>;
export type PushTasksResult = z.infer<typeof pushTasksResult>;
export type PullTasksResult = z.infer<typeof pullTasksResult>;
