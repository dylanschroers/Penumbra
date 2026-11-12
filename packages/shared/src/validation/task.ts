import { z } from "zod";

export const taskPriority = z.enum(["low", "medium", "high"]);
export const taskStatus = z.enum(["todo", "doing", "done"]);

export const createTaskInput = z.object({
  title: z.string().min(1).max(200),
  notes: z.string().max(10_000).optional(),
  priority: taskPriority.default("medium"),
  dueAt: z.string().datetime().optional(),
});

export const task = createTaskInput.extend({
  id: z.string(),
  userId: z.string(),
  status: taskStatus,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** No defaults, so an omitted field means "leave unchanged". */
export const updateTaskInput = z.object({
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(10_000).optional(),
  priority: taskPriority.optional(),
  status: taskStatus.optional(),
  dueAt: z.string().datetime().optional(),
});

export type TaskPriority = z.infer<typeof taskPriority>;
export type TaskStatus = z.infer<typeof taskStatus>;
export type CreateTaskInput = z.infer<typeof createTaskInput>;
export type UpdateTaskInput = z.infer<typeof updateTaskInput>;
export type Task = z.infer<typeof task>;
