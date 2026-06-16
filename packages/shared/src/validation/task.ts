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

// Types are *inferred* from the schemas above, so they can never drift from
// the validation rules. This is the single-source-of-truth idea in practice.
export type TaskPriority = z.infer<typeof taskPriority>;
export type TaskStatus = z.infer<typeof taskStatus>;
export type CreateTaskInput = z.infer<typeof createTaskInput>;
export type Task = z.infer<typeof task>;
