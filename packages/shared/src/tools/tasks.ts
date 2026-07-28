import { z } from "zod";
import { createTaskInput, taskPriority, taskStatus } from "../validation/task";
import type { ToolContract } from "./contract";

// Contracts for the task tools — the set the Tier-0 embedded model can call.
// Kept small on purpose: a small model stays reliable with a handful of
// well-described tools (docs/AGENT_DESIGN.md §7). Field schemas are reused from
// ../validation/task.ts wherever the rule is the same, so a constraint like
// the title length lives in exactly one place.

export const createTaskTool = {
  name: "create_task",
  description: "Add a task to the user's to-do list.",
  permission: "write",
  args: z.object({
    title: createTaskInput.shape.title.describe("Short task title"),
    priority: taskPriority.describe("Task priority").default("medium"),
    // Looser than the stored dueAt (.datetime()): the model is weak at dates
    // (AGENT_DESIGN.md §7), so the contract accepts any string and the runner
    // coerces it with a deterministic parser — or drops it — before storage.
    dueAt: z.string().describe("Due date/time, ISO 8601 if known").optional(),
    notes: createTaskInput.shape.notes,
  }),
} satisfies ToolContract;

export const listTasksTool = {
  name: "list_tasks",
  description: "List the user's tasks, optionally filtered by status.",
  permission: "read",
  args: z.object({
    status: taskStatus.describe("Only tasks with this status").optional(),
  }),
} satisfies ToolContract;

export const completeTaskTool = {
  name: "complete_task",
  description: "Mark a task as done, matched by its title.",
  permission: "write",
  args: z.object({
    title: z.string().min(1).describe("Title of the task to mark as done"),
  }),
} satisfies ToolContract;

export const deleteTaskTool = {
  name: "delete_task",
  description: "Delete a task, matched by its title.",
  permission: "act",
  args: z.object({
    title: z.string().min(1).describe("Title of the task to delete"),
  }),
} satisfies ToolContract;

/** Every task tool contract, in the order the model sees them. */
export const taskTools = [
  createTaskTool,
  listTasksTool,
  completeTaskTool,
  deleteTaskTool,
] as const;

/** System prompt for the task-tool turn. Lives beside the contracts (not in
 * client code) because the eval harness must test the exact prompt the app
 * ships — prompt and tool set regress together. */
export const AGENT_SYSTEM =
  "You are Penumbra, a local personal assistant. You can manage the user's tasks " +
  "with the provided tools. Call a tool ONLY when the user asks you to view or " +
  "change their tasks; for general questions or chit-chat, just answer. After a " +
  "tool runs, tell the user briefly what happened. Format your replies in " +
  "Markdown: use lists, **emphasis**, and fenced code blocks where they help.";
