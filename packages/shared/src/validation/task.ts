import { z } from "zod";

export const taskPriority = z.enum(["low", "medium", "high"]);
export const taskStatus = z.enum(["todo", "doing", "done"]);

/** What a client sends to create a task. */
export const createTaskInput = z.object({
  title: z.string().min(1).max(200),
  notes: z.string().max(10_000).optional(),
  priority: taskPriority.default("medium"),
  dueAt: z.string().datetime().optional(),
});

/** A fully-persisted task (Plane A — owned, synced). */
export const task = createTaskInput.extend({
  id: z.string(),
  userId: z.string(),
  status: taskStatus,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * Fields a client may change on an existing task — all optional, and defined
 * WITHOUT defaults (unlike createTaskInput) so that omitting a field means
 * "leave it unchanged" rather than "reset it".
 */
export const updateTaskInput = z.object({
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(10_000).optional(),
  priority: taskPriority.optional(),
  status: taskStatus.optional(),
  dueAt: z.string().datetime().optional(),
});

// Types are *inferred* from the schemas above, so they can never drift from
// the validation rules. This is the single-source-of-truth idea in practice.
export type TaskPriority = z.infer<typeof taskPriority>;
export type TaskStatus = z.infer<typeof taskStatus>;
export type CreateTaskInput = z.infer<typeof createTaskInput>;
export type UpdateTaskInput = z.infer<typeof updateTaskInput>;
export type Task = z.infer<typeof task>;
