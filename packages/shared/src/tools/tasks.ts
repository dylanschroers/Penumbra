import { z } from "zod";
import { createTaskInput, taskPriority, taskStatus } from "../validation/task";
import type { ToolContract } from "./contract";

// Contracts for the task tools. Part of what the model is offered, not all of
// it — ./registry.ts assembles the advertised set.
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

// The system prompt lives beside the tool contracts, not in client code, because
// the eval harness must test the prompt the app ships — prompt and tool set
// regress together.
//
// It is in two parts because one of them is editable. Everything that decides
// *whether a tool runs* and *whether the assistant tells the truth about itself*
// stays fixed; only tone and formatting can be changed. A persona box that could
// delete "call a tool ONLY when…" would silently break task creation, and one
// that could reinstate a name would undo the fix below by hand.
//
// The assistant is deliberately unnamed. Calling it "Penumbra" made a small
// model treat the app's name as its own identity and improvise the rest: asked
// what model it was, it announced itself as "Penumbra, developed by Anthropic",
// inventing both the persona and the vendor. A model cannot know what it is
// running as unless it is told, so the identity *facts* are appended per turn by
// the engine (see OpenAiEngine.runAgent) rather than written in here, where they
// would be a guess frozen into a constant.
//
// Note what this does NOT say. An earlier version forbade the wrong answers by
// name — "never claim to be Penumbra, and never claim to be made by Anthropic"
// — and measurably caused them: asked who it was, Qwen3-1.7B replied "developed
// by the company Anthropic", a word it had only ever seen here. A negation
// still puts the token in the context, and a small model reaches for what is
// there. So the rule is stated positively, with the answer to give supplied
// rather than the answers to avoid enumerated, and no proper noun appears at
// all. Adding one back reintroduces it as a thing to say.

/** The half a user cannot edit: tool policy and honesty about what it is. */
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

/** The half a user can edit: tone and formatting, nothing load-bearing. */
export const AGENT_PERSONA_DEFAULT =
  "Format replies in Markdown: use lists, **emphasis**, and fenced code blocks " +
  "where they help. Write plainly. Your reply must contain no emoji and no " +
  "emoticons.";

/** Longer than this is refused: the prompt shares a context window with the
 *  conversation, and small models have little of it to spare. */
export const AGENT_PERSONA_MAX = 4000;

/**
 * The full prompt: fixed policy, then any tier-specific policy, then the
 * persona in force.
 *
 * Policy leads so that a persona cannot appear to override it by being read
 * first, and the engine appends the identity facts after both — last, because
 * recency is what a small model weighs most.
 *
 * `extra` is more fixed policy, for a tier that can do something this one
 * cannot: today the server passing LAB_POLICY, because it alone can run the
 * Model Lab. It sits above the persona for the same reason AGENT_POLICY does —
 * it decides when tools fire, and an editable string must not be read as
 * outranking it. Omitting it reproduces the old output exactly, which is what
 * keeps AGENT_SYSTEM byte-stable for the eval.
 */
export function composeSystem(persona?: string, extra?: string): string {
  const tail = (persona ?? AGENT_PERSONA_DEFAULT).trim();
  return [AGENT_POLICY, extra?.trim(), tail].filter(Boolean).join(" ");
}

/**
 * The shipped prompt, with no persona override applied.
 *
 * Benchmarks are pinned to this on purpose. lab_scores records the model and
 * target that produced a score but not the prompt, so letting an editable
 * string into the eval would make two runs incomparable with nothing in the row
 * saying why — the same silent wrongness as a score attributed to weights that
 * never ran (docs/MODEL_LAB.md → Suites).
 */
export const AGENT_SYSTEM = composeSystem();
