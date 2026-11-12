import {
  agentTools,
  completeTaskTool,
  createTaskTool,
  deleteTaskTool,
  fetchWeather,
  getWeatherTool,
  listTasksTool,
  type TaskRow,
  type ToolContract,
  type ToolSpec,
  toToolSpec,
} from "@penumbra/shared";
import type { z } from "zod";
import { getDb } from "../db/client";
import { requestSync, SYNC_EVENT } from "../sync/SyncClient";

// Tier 0 bindings over the local store.

export type { ToolSpec } from "@penumbra/shared";
export { AGENT_SYSTEM } from "@penumbra/shared";

export const toolSpecs: ToolSpec[] = agentTools.map(toToolSpec);

interface BoundTool {
  contract: ToolContract;
  run: (args: unknown) => Promise<string>;
}

/** Safe: runTool parses args with the contract schema before calling run. */
function bind<A extends z.ZodTypeAny>(
  contract: ToolContract<A>,
  run: (args: z.output<A>) => Promise<string>,
): BoundTool {
  return { contract, run: run as BoundTool["run"] };
}

// Tool writes bypass the Tasks module, so refresh the UI and push now rather
// than waiting for the 15s sync.
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

/** Unparseable model dates are dropped rather than failing the store schema. */
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

  // Shared with Tier 1; see tools/weather.ts.
  bind(getWeatherTool, fetchWeather),
];

const registry = new Map(bindings.map((b) => [b.contract.name, b]));

/** Validation failures are returned as text so the model can correct itself. */
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
    if (tool.contract.permission !== "read") notifyDataChanged();
    return result;
  } catch (err) {
    return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
