import { getDb } from "../db/client";
import { SYNC_EVENT } from "../sync/SyncClient";
import type { TaskRow } from "@ghost/shared";

// The tools the embedded model can call. Each maps to a real DbApi operation on
// the local SQLite store, so a tool call actually changes the app. Kept small
// on purpose — the Tier-0 model stays reliable with a handful of tools
// (docs/AGENT_DESIGN.md §7). Reminders and notes are intentionally absent: no
// store backs them yet, and a tool must never be a no-op the model can "call".

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

const PRIORITY = ["low", "medium", "high"];
const STATUS = ["todo", "doing", "done"];

export const toolSpecs: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Add a task to the user's to-do list.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short task title" },
          priority: { type: "string", enum: PRIORITY },
          dueAt: { type: "string", description: "Due date/time, ISO 8601 if known" },
          notes: { type: "string" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "List the user's tasks, optionally filtered by status.",
      parameters: {
        type: "object",
        properties: { status: { type: "string", enum: STATUS } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "Mark a task as done, matched by its title.",
      parameters: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "Delete a task, matched by its title.",
      parameters: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    },
  },
];

/** The model turn's system prompt: who it is and when to use tools. */
export const AGENT_SYSTEM =
  "You are Ghost, a local personal assistant. You can manage the user's tasks " +
  "with the provided tools. Call a tool ONLY when the user asks you to view or " +
  "change their tasks; for general questions or chit-chat, just answer. After a " +
  "tool runs, tell the user briefly what happened.";

// A tool mutation writes straight to the store via getDb(), which bypasses the
// Tasks module's own mutation path — so nudge it to re-read. useTasks already
// listens for SYNC_EVENT ("local data changed"), so reuse it.
function notifyDataChanged(): void {
  window.dispatchEvent(new Event(SYNC_EVENT));
}

function findByTitle(tasks: TaskRow[], title: string): TaskRow | undefined {
  const q = title.trim().toLowerCase();
  return (
    tasks.find((t) => t.title.toLowerCase() === q) ??
    tasks.find((t) => t.title.toLowerCase().includes(q))
  );
}

/** Coerce a model-supplied date to a valid ISO string, or drop it. The model is
 *  weak at dates (AGENT_DESIGN.md §7), so anything JS can't parse is discarded
 *  rather than passed on to fail schema validation. */
function toIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Execute one tool call. Returns a short human-readable result that is both
 *  shown in the UI and fed back to the model as the tool's output. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const db = getDb();
  try {
    switch (name) {
      case "create_task": {
        const title = String(args.title ?? "").trim().slice(0, 200);
        if (!title) return "A task needs a title.";
        const priority = PRIORITY.includes(args.priority as string)
          ? (args.priority as "low" | "medium" | "high")
          : "medium";
        const task = await db.createTask({
          title,
          priority,
          dueAt: toIso(args.dueAt),
          notes: typeof args.notes === "string" ? args.notes : undefined,
        });
        notifyDataChanged();
        return `Created task "${task.title}" (${task.priority} priority).`;
      }
      case "list_tasks": {
        let tasks = await db.listTasks();
        if (typeof args.status === "string") {
          tasks = tasks.filter((t) => t.status === args.status);
        }
        if (!tasks.length) return "No matching tasks.";
        return tasks
          .map((t) => `- ${t.title} [${t.status}, ${t.priority}]`)
          .join("\n");
      }
      case "complete_task": {
        const t = findByTitle(await db.listTasks(), String(args.title ?? ""));
        if (!t) return `No task matching "${String(args.title ?? "")}".`;
        await db.updateTask(t.id, { status: "done" });
        notifyDataChanged();
        return `Marked "${t.title}" as done.`;
      }
      case "delete_task": {
        const t = findByTitle(await db.listTasks(), String(args.title ?? ""));
        if (!t) return `No task matching "${String(args.title ?? "")}".`;
        await db.deleteTask(t.id);
        notifyDataChanged();
        return `Deleted "${t.title}".`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
