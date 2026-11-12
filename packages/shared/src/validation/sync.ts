import { z } from "zod";
import { task } from "./task";

export const syncTask = task.extend({
  // SQLite returns NULL, not undefined, for empty columns.
  notes: z.string().max(10_000).nullish(),
  dueAt: z.string().datetime().nullish(),
  deletedAt: z.string().datetime().nullable(),
  rev: z.number().int().nullable(),
});

export const pushTasksInput = z.object({
  rows: z.array(syncTask),
});

// `serverId` identifies the database that issued a response; on an unfamiliar
// one the client reconciles (docs/SYNC.md → Epochs).

export const pushTasksResult = z.object({
  cursor: z.number().int(),
  serverId: z.string(),
});

export const pullTasksResult = z.object({
  rows: z.array(syncTask),
  cursor: z.number().int(),
  serverId: z.string(),
});

export type SyncTask = z.infer<typeof syncTask>;
export type PushTasksInput = z.infer<typeof pushTasksInput>;
export type PushTasksResult = z.infer<typeof pushTasksResult>;
export type PullTasksResult = z.infer<typeof pullTasksResult>;
