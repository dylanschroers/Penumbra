import {
  AGENT_SYSTEM,
  completeTaskTool,
  createTaskTool,
  deleteTaskTool,
  listTasksTool,
  type SyncTask,
  type ToolBindings,
  type ToolContract,
  type ToolSpec,
  taskTools,
  toToolSpec,
} from "@ghost/shared";
import type { z } from "zod";
import type { ServerTaskStore } from "../store/tasks";

// The server half of the tool registry — the Tier-1 mirror of
// apps/web/src/agent/tools.ts. Same shape deliberately: each shared contract is
// bound to a runner, the model-facing specs derive from those same contracts,
// and every model-emitted call is validated against the contract's schema
// before anything executes. Only the backing store differs (the server's
// SQLite, not the browser's), which is the whole point of Tier 1: the turn runs
// with no client in the loop (docs/UNSLOTH_TIER1_PLAN.md §2).

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

function findByTitle(tasks: SyncTask[], title: string): SyncTask | undefined {
  const q = title.trim().toLowerCase();
  return (
    tasks.find((t) => t.title.toLowerCase() === q) ??
    tasks.find((t) => t.title.toLowerCase().includes(q))
  );
}

/** Coerce a model-supplied date to a valid ISO string, or drop it. The model is
 *  weak at dates (AGENT_DESIGN.md §7 — a live run had it invent a 2023 due
 *  date), so anything JS can't parse is discarded rather than passed on to fail
 *  the store's stricter schema. */
function toIso(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Build the agent's tool bindings over a server task store. */
export function createServerTools(store: ServerTaskStore): ToolBindings {
  const bindings: BoundTool[] = [
    bind(createTaskTool, async (args) => {
      const task = store.createTask({
        title: args.title,
        priority: args.priority,
        dueAt: toIso(args.dueAt),
        notes: args.notes,
      });
      return `Created task "${task.title}" (${task.priority} priority).`;
    }),

    bind(listTasksTool, async (args) => {
      let tasks = store.listTasks();
      if (args.status) tasks = tasks.filter((t) => t.status === args.status);
      if (!tasks.length) return "No matching tasks.";
      return tasks
        .map((t) => `- ${t.title} [${t.status}, ${t.priority}]`)
        .join("\n");
    }),

    bind(completeTaskTool, async (args) => {
      const t = findByTitle(store.listTasks(), args.title);
      if (!t) return `No task matching "${args.title}".`;
      store.updateTask(t.id, { status: "done" });
      return `Marked "${t.title}" as done.`;
    }),

    bind(deleteTaskTool, async (args) => {
      const t = findByTitle(store.listTasks(), args.title);
      if (!t) return `No task matching "${args.title}".`;
      store.deleteTask(t.id);
      return `Deleted "${t.title}".`;
    }),
  ];

  const registry = new Map(bindings.map((b) => [b.contract.name, b]));

  /** Execute one tool call. Returns a short human-readable result that is both
   *  streamed to the client and fed back to the model — including validation
   *  failures, which the model can often correct on its next step when told
   *  exactly what was wrong. */
  const runTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
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
      return await tool.run(parsed.data);
    } catch (err) {
      return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  return { tools: toolSpecs, system: AGENT_SYSTEM, runTool };
}
