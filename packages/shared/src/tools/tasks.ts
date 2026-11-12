import { z } from "zod";
import { createTaskInput, taskPriority, taskStatus } from "../validation/task";
import type { ToolContract } from "./contract";

// Field schemas reuse ../validation/task.ts.

export const createTaskTool = {
  name: "create_task",
  description: "Add a task to the user's to-do list.",
  permission: "write",
  args: z.object({
    title: createTaskInput.shape.title.describe("Short task title"),
    priority: taskPriority.describe("Task priority").default("medium"),
    // Looser than the stored dueAt: the model is weak at dates, so the runner
    // coerces or drops it.
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

export const taskTools = [
  createTaskTool,
  listTasksTool,
  completeTaskTool,
  deleteTaskTool,
] as const;

// Lives here so the eval tests the prompt the app ships. Split in two so a
// user-editable persona can never touch tool policy or identity.
//
// The assistant is deliberately unnamed, and the policy names no product or
// vendor, even in a negation: a small model given "never claim to be X" says
// X. Identity facts are appended per turn by OpenAiEngine.runAgent.

export const AGENT_POLICY =
  "You are an assistant that helps the user manage their tasks and look up " +
  "the current weather. You have no " +
  "name of your own. When the user asks who or what you are, answer with the " +
  "model and backend stated at the end of these instructions, and nothing " +
  "else: no name, no maker, no origin story. If no model is stated there, say " +
  "plainly that you do not know which model you are. " +
  "Use the provided tools ONLY when the user asks you to view or change their " +
  "tasks, or asks what the weather is; for general questions or chit-chat, " +
  "just answer. After a tool runs, tell the user briefly what happened.";

export const AGENT_PERSONA_DEFAULT =
  "Format replies in Markdown: use lists, **emphasis**, and fenced code blocks " +
  "where they help. Write plainly. Your reply must contain no emoji and no " +
  "emoticons.";

/** The prompt shares a small model's context window. */
export const AGENT_PERSONA_MAX = 4000;

/**
 * Order: fixed policy, tier policy, persona; the engine appends identity facts
 * last. A persona must never read as outranking policy. With no `extra` the
 * output is byte-identical to the old one, which keeps AGENT_SYSTEM stable for
 * the eval.
 */
export function composeSystem(persona?: string, extra?: string): string {
  const tail = (persona ?? AGENT_PERSONA_DEFAULT).trim();
  return [AGENT_POLICY, extra?.trim(), tail].filter(Boolean).join(" ");
}

/** Benchmarks are pinned to this: lab_scores doesn't record the prompt. */
export const AGENT_SYSTEM = composeSystem();
