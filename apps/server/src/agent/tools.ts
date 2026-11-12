import {
  AGENT_SYSTEM,
  agentTools,
  type BenchmarkResult,
  completeTaskTool,
  composeSystem,
  createTaskTool,
  deleteTaskTool,
  fetchWeather,
  finetuneRequest,
  getWeatherTool,
  jobStatusTool,
  LAB_POLICY,
  type LabJob,
  type LabRun,
  labHistoryTool,
  labTools,
  listDatasetsTool,
  listModelsTool,
  listTasksTool,
  runBenchmarkTool,
  type SyncTask,
  startFinetuneTool,
  type ToolBindings,
  type ToolContract,
  type ToolSpec,
  toDatasetSource,
  toToolSpec,
} from "@penumbra/shared";
import type { z } from "zod";
import type { LabService } from "../lab/routes";
import type { ServerTaskStore } from "../store/tasks";

// Tier 1 mirror of apps/web/src/agent/tools.ts, bound to the server store.

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

function findByTitle(tasks: SyncTask[], title: string): SyncTask | undefined {
  const q = title.trim().toLowerCase();
  return (
    tasks.find((t) => t.title.toLowerCase() === q) ??
    tasks.find((t) => t.title.toLowerCase().includes(q))
  );
}

/**
 * Unparseable model dates are dropped rather than failing the stricter store
 * schema.
 */
function toIso(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** 0 bytes means unknown size, not empty. */
function roughSize(bytes: number): string {
  if (!bytes) return "size unknown";
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : `${Math.round(bytes / 1e6)} MB`;
}

function jobLine(job: LabJob): string {
  // runJob sets progress to 1 when a job is marked done, so a settled job's
  // percentage is meaningless ("failed 60%", "cancelled 100%").
  const moving = job.state === "running" || job.state === "queued";
  const pct =
    moving && job.progress !== null
      ? ` ${Math.round(job.progress * 100)}%`
      : "";
  // Benchmark detail is a tqdm frame with carriage returns; flatten it.
  const why = (job.error ?? job.detail)?.replace(/\s+/g, " ").trim();
  return `${job.kind} ${job.id}: ${job.state}${pct}${why ? ` — ${why}` : ""}`;
}

const RECENT_JOBS = 5;

/**
 * Results go back into the model's context, so lists are capped and say what
 * they cut.
 */
const MAX_ROWS = 8;
/** A general suite carries ~20 metrics per score. */
const MAX_METRICS = 4;

function capped<T>(rows: T[], note = ""): [T[], string[]] {
  const shown = rows.slice(0, MAX_ROWS);
  return [
    shown,
    rows.length > shown.length
      ? [`(showing ${shown.length} of ${rows.length}${note})`]
      : [],
  ];
}

/** Full ids stay on jobs, the only ones a tool takes back. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Both separators: paths come from whichever host trained the run. */
function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** `ggufPath` is often the save dir, whose last segment is just "gguf". */
function artifactName(ggufPath: string): string | null {
  const name = basename(ggufPath);
  return name.includes(".") ? name : null;
}

/** A run with no output dir cannot be exported. */
function formatRuns(runs: LabRun[]): string {
  if (!runs.length) return "No fine-tuning runs have finished yet.";
  const [shown, note] = capped(runs, ", newest first");
  const lines = shown.map((r) => {
    const named = r.ggufPath ? artifactName(r.ggufPath) : null;
    const artifact = r.ggufPath
      ? `exported${named ? ` to ${named}` : ""}${
          r.hubRepo ? `, pushed to ${r.hubRepo}` : ""
        }`
      : r.outputDir
        ? "trained, not exported"
        : "no checkpoint";
    return `- ${shortId(r.id)}: ${r.baseModel} on ${basename(r.dataset)} — ${artifact} (${r.provider})`;
  });
  return [...lines, ...note].join("\n");
}

function formatScores(scores: BenchmarkResult[]): string {
  if (!scores.length) return "No benchmark scores have been recorded yet.";
  const [shown, note] = capped(scores, ", newest first");
  const lines = shown.map((s) => {
    const metrics = s.scores
      .slice(0, MAX_METRICS)
      .map((t) => `${t.task} ${t.metric} ${Number(t.value.toFixed(3))}`)
      .join(", ");
    const more =
      s.scores.length > MAX_METRICS
        ? ` (+${s.scores.length - MAX_METRICS} more metrics)`
        : "";
    // Lead with `servedModel`: Studio serves whatever is resident, so the
    // requested `model` is only a label.
    const what =
      s.servedModel && s.servedModel !== s.model
        ? `${s.servedModel} (requested ${s.model})`
        : (s.servedModel ?? s.model);
    return `- ${s.suite} on ${what} @ ${s.target}, ${s.samplesPerTask} samples, ${s.at.slice(0, 10)}: ${metrics}${more}`;
  });
  // Never omitted: a subset score is not a leaderboard number.
  return [
    ...lines,
    ...note,
    "Scores are subset runs at the sample count shown, not full-suite results.",
  ].join("\n");
}

/**
 * Every binding returns a sentence, refusals included. Work-starting tools
 * return a job id, since the work outlives the turn.
 */
function labBindings(lab: LabService): BoundTool[] {
  return [
    bind(listModelsTool, async () => {
      const { target, models, inventoryError } = await lab.models();
      const [shown, note] = capped(models);
      const lines = shown.map(
        (m) =>
          `- ${m.id} [${m.format}, ${roughSize(m.sizeBytes)}]${
            m.loaded ? " — loaded" : ""
          }`,
      );
      lines.push(...note);
      if (models.length && !models.some((m) => m.loaded)) {
        lines.push("Nothing is loaded, so a benchmark cannot run yet.");
      }
      // A failed inventory and an empty one look identical here.
      if (inventoryError) {
        lines.push(
          `(the rest of the inventory could not be read: ${inventoryError})`,
        );
      }
      return lines.length
        ? `Models on ${target}:\n${lines.join("\n")}`
        : `${target} has no models available and nothing loaded.`;
    }),

    bind(listDatasetsTool, async () => {
      const files = await lab.datasets();
      if (!files.length) {
        return "No datasets have been uploaded to the training host yet.";
      }
      const [shown, note] = capped(files);
      const lines = shown.map(
        (f) => `- ${f.name} (${roughSize(f.size)}) — ${f.path}`,
      );
      return [...lines, ...note].join("\n");
    }),

    bind(startFinetuneTool, async (args) => {
      // Parsed through the wire schema so chat gets the same defaults as the form.
      const started = await lab.finetune(
        finetuneRequest.parse({
          baseModel: args.baseModel,
          dataset: toDatasetSource(args.dataset),
          maxSteps: args.maxSteps,
          provider: args.provider,
        }),
      );
      return started.ok
        ? `Started fine-tune job ${started.jobId} (run ${started.runId}): ${args.baseModel} on ${args.dataset}, ${args.maxSteps} steps. It runs in the background — check job_status for progress.`
        : `Cannot start fine-tuning: ${started.message}.`;
    }),

    bind(runBenchmarkTool, async (args) => {
      const started = await lab.benchmark({
        suite: args.suite,
        samplesPerTask: args.samplesPerTask,
        model: args.model,
      });
      return started.ok
        ? // Two tools, because the job answers "is it finished" and only the
          // score table answers "what did it get" — the job's own detail line at
          // that point is the last progress frame the harness printed.
          `Started benchmark job ${started.jobId}: ${args.suite}, ${args.samplesPerTask} samples per task. It runs in the background — check job_status for progress, then lab_history for the scores.`
        : `Cannot start the benchmark: ${started.message}.`;
    }),

    bind(jobStatusTool, async (args) => {
      if (args.jobId) {
        const job = lab.job(args.jobId);
        return job ? jobLine(job) : `There is no job with id ${args.jobId}.`;
      }
      const recent = lab.jobs().slice(0, RECENT_JOBS);
      return recent.length
        ? recent.map(jobLine).join("\n")
        : "No Model Lab jobs have run yet.";
    }),

    bind(labHistoryTool, async (args) =>
      args.what === "runs"
        ? formatRuns(lab.runs())
        : formatScores(lab.scores()),
    ),
  ];
}

/** `lab` is optional: a deployment may have no GPU host or Studio. */
export function createServerTools(
  store: ServerTaskStore,
  lab?: LabService,
): ToolBindings {
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

    // Shared with Tier 0; see tools/weather.ts.
    bind(getWeatherTool, fetchWeather),
  ];

  if (lab) bindings.push(...labBindings(lab));

  const registry = new Map(bindings.map((b) => [b.contract.name, b]));

  /** Validation failures are returned as text so the model can correct itself. */
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

  // Lab tools and LAB_POLICY travel together. main.ts recomposes the prompt with
  // the persona and must pass the same extra.
  return lab
    ? {
        tools: [...toolSpecs, ...labTools.map(toToolSpec)],
        system: composeSystem(undefined, LAB_POLICY),
        runTool,
      }
    : { tools: toolSpecs, system: AGENT_SYSTEM, runTool };
}
