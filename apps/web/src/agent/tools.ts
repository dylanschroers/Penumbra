import type { z } from "zod";
import {
  taskTools,
  createTaskTool,
  listTasksTool,
  completeTaskTool,
  deleteTaskTool,
  toToolSpec,
  type ToolContract,
  type ToolSpec,
  type TaskRow,
} from "@ghost/shared";
import { getDb } from "../db/client";
import { requestSync, SYNC_EVENT } from "../sync/SyncClient";

// The client half of the tool registry: each shared contract (name, permission,
// Zod arg schema — packages/shared/src/tools) is bound here to a runner against
// the local store. The wire specs the model sees are derived from the same
// contracts, and runTool validates every model-emitted call against them before
// anything executes — so the schema the model is shown, the validation rule,
// and the eval harness (scripts/tool-eval.ts) can never drift apart.

export { AGENT_SYSTEM } from "@ghost/shared";
export type { ToolSpec } from "@ghost/shared";

/** The model-facing tool list, derived from the shared contracts. */
export const toolSpecs: ToolSpec[] = taskTools.map(toToolSpec);

interface BoundTool {
  contract: ToolContract;
  run: (args: unknown) => Promise<string>;
}

/** Pair a contract with its runner. The cast is safe because runTool always
 * parses arguments with the contract's schema before calling run. */
function bind<A extends z.ZodTypeAny>(
  contract: ToolContract<A>,
  run: (args: z.output<A>) => Promise<string>,
): BoundTool {
  return { contract, run: run as BoundTool["run"] };
}

// A tool mutation writes straight to the store via getDb(), bypassing the Tasks
// module's own mutation path — so nudge the UI to re-read (useTasks listens for
// SYNC_EVENT) and nudge the sync loop so the edit pushes now instead of waiting
// for the 15s interval.
function notifyDataChanged(): void {
  window.dispatchEvent(new Event(SYNC_EVENT));
  requestSync();
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
 *  rather than passed on to fail the store's stricter schema. */
function toIso(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const bindings: BoundTool[] = [
  bind(createTaskTool, async (args) => {
    const task = await getDb().createTask({
      title: args.title,
      priority: args.priority,
      dueAt: toIso(args.dueAt),
      notes: args.notes,
    });
    return `Created task "${task.title}" (${task.priority} priority).`;
  }),

  bind(listTasksTool, async (args) => {
    let tasks = await getDb().listTasks();
    if (args.status) tasks = tasks.filter((t) => t.status === args.status);
    if (!tasks.length) return "No matching tasks.";
    return tasks
      .map((t) => `- ${t.title} [${t.status}, ${t.priority}]`)
      .join("\n");
  }),

  bind(completeTaskTool, async (args) => {
    const db = getDb();
    const t = findByTitle(await db.listTasks(), args.title);
    if (!t) return `No task matching "${args.title}".`;
    await db.updateTask(t.id, { status: "done" });
    return `Marked "${t.title}" as done.`;
  }),

  bind(deleteTaskTool, async (args) => {
    const db = getDb();
    const t = findByTitle(await db.listTasks(), args.title);
    if (!t) return `No task matching "${args.title}".`;
    await db.deleteTask(t.id);
    return `Deleted "${t.title}".`;
  }),
];

const registry = new Map(bindings.map((b) => [b.contract.name, b]));

/** Execute one tool call. Returns a short human-readable result that is both
 *  shown in the UI and fed back to the model as the tool's output — including
 *  validation failures, which the model can often correct on its next step
 *  when told exactly what was wrong. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = registry.get(name);
  if (!tool) return `Unknown tool: ${name}`;

  const parsed = tool.contract.args.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`)
      .join("; ");
    return `Invalid arguments for ${name} — ${issues}`;
  }

  try {
    const result = await tool.run(parsed.data);
    // Non-read tools may have changed the store; refresh the UI and push. A
    // no-op run (e.g. "no task matching") triggers a harmless extra refresh.
    if (tool.contract.permission !== "read") notifyDataChanged();
    return result;
  } catch (err) {
    return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
