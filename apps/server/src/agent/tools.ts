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

// The server half of the tool registry — the Tier-1 mirror of
// apps/web/src/agent/tools.ts. Same shape deliberately: each shared contract is
// bound to a runner, the model-facing specs derive from those same contracts,
// and every model-emitted call is validated against the contract's schema
// before anything executes. Only the backing store differs (the server's
// SQLite, not the browser's), which is the whole point of Tier 1: the turn runs
// with no client in the loop (docs/SYNC.md → Server-side writes).

/** The model-facing tool list, derived from the shared contracts. */
export const toolSpecs: ToolSpec[] = agentTools.map(toToolSpec);

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

/** Bytes as a rough size. Lab artifacts are large and their exact size is never
 *  the question, so GB or MB is as far as this goes. A model of unknown size
 *  reports 0 bytes, which is not a measurement and must not read as one. */
function roughSize(bytes: number): string {
  if (!bytes) return "size unknown";
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : `${Math.round(bytes / 1e6)} MB`;
}

/** One job as a line to relay: what it is, where it got to, and why it stopped
 *  if it did. */
function jobLine(job: LabJob): string {
  // A percentage, but only while it still means something. A settled job's last
  // progress figure says where it stopped reporting, not what it achieved, and
  // runJob sets progress to 1 the moment a job is marked done — so carrying it
  // onto a terminal row produces "failed 60%", or "cancelled 100%", which is
  // the opposite of what happened.
  const moving = job.state === "running" || job.state === "queued";
  const pct =
    moving && job.progress !== null
      ? ` ${Math.round(job.progress * 100)}%`
      : "";
  // Whatever the underlying tool last wrote, and for a benchmark that is a tqdm
  // frame with carriage returns in it. Flattened, or one row breaks the list it
  // is part of.
  const why = (job.error ?? job.detail)?.replace(/\s+/g, " ").trim();
  return `${job.kind} ${job.id}: ${job.state}${pct}${why ? ` — ${why}` : ""}`;
}

/** How many recent jobs an unfiltered job_status reports. Enough to cover a
 *  pipeline's worth of stages, short enough to stay a readable answer. */
const RECENT_JOBS = 5;

/**
 * How many rows any other list may show.
 *
 * Every one of these results is fed back into the conversation, where it
 * competes with the prompt and the thread for the model's context. A live lab
 * here already holds eight models and a dozen runs, so the lists are capped and
 * say what they cut — which is more use to a reader than a truncated list that
 * looks whole.
 */
const MAX_ROWS = 8;
/** Metrics per score. A general suite carries twenty, which would drown the
 *  other rows on its own. */
const MAX_METRICS = 4;

/** Rows worth reporting, and the note that says so when some were dropped. */
function capped<T>(rows: T[], note = ""): [T[], string[]] {
  const shown = rows.slice(0, MAX_ROWS);
  return [
    shown,
    rows.length > shown.length
      ? [`(showing ${shown.length} of ${rows.length}${note})`]
      : [],
  ];
}

/** Enough of a uuid to name a row without spending the context on all 36.
 *  Full ids stay on jobs, which are the only ones a tool takes back. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** The last path segment, for a dataset or checkpoint named by a long path.
 *  Both separators: a run's paths come from whichever host trained it. */
function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * The file an export produced, when it produced a named one.
 *
 * `ggufPath` is Studio's output path when it reports one and the save directory
 * otherwise, so on most real runs the last segment is the literal word "gguf" —
 * "exported to gguf" says nothing. A segment with no extension is a directory,
 * and the fact that matters is already in the sentence without it.
 */
function artifactName(ggufPath: string): string | null {
  const name = basename(ggufPath);
  return name.includes(".") ? name : null;
}

/** Past fine-tunes, said in terms of what can be done with them next — which is
 *  the only reason to ask. A run with no output dir produced no checkpoint and
 *  cannot be exported. */
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

/** Recorded scores, with the two things that decide whether a number means what
 *  it appears to mean: what actually answered, and how few samples it saw. */
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
    // `servedModel` leads and `model` is named only when the two differ. Studio
    // serves whatever is resident regardless of what a run asked for, so the
    // requested id is a label and the served one is what the numbers describe —
    // relaying the label alone is how a score gets read as measuring weights
    // that never ran.
    const what =
      s.servedModel && s.servedModel !== s.model
        ? `${s.servedModel} (requested ${s.model})`
        : (s.servedModel ?? s.model);
    return `- ${s.suite} on ${what} @ ${s.target}, ${s.samplesPerTask} samples, ${s.at.slice(0, 10)}: ${metrics}${more}`;
  });
  // Never omitted: a 20-sample score is not a leaderboard number and must not be
  // relayed as one.
  return [
    ...lines,
    ...note,
    "Scores are subset runs at the sample count shown, not full-suite results.",
  ].join("\n");
}

/**
 * Bind the Model Lab contracts to the lab running in this process.
 *
 * Every one of these returns a sentence rather than throwing, including the
 * refusals: "the local Studio is not answering" is an ordinary outcome the
 * model should pass on, not a bug. The two that start work return a job id and
 * say so, because the work outlives the turn — a tool that waited would hold a
 * conversation open for an hour and still time out (docs/MODEL_LAB.md → Job
 * records).
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
      // Which one is resident decides what a benchmark would actually measure,
      // so its absence is worth saying rather than leaving to be inferred from
      // the lack of a marker on any row.
      if (models.length && !models.some((m) => m.loaded)) {
        lines.push("Nothing is loaded, so a benchmark cannot run yet.");
      }
      // An inventory that failed is reported rather than passed off as an empty
      // shelf: the two look identical here and need different fixes.
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
      // Parsed through the wire schema so a run started from a conversation
      // gets exactly the defaults — learning rate, LoRA rank, format — that the
      // form's would, rather than a second set defined here.
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

/**
 * Build the agent's tool bindings over a server task store.
 *
 * `lab` is optional because the Model Lab is the one capability a deployment
 * can genuinely be without — no GPU host, no Studio — and advertising tools
 * that cannot run is worse than not advertising them.
 */
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

    // Bound identically on Tier 0. This tool reaches no store, so the two tiers
    // share one implementation rather than mirroring it (see tools/weather.ts).
    bind(getWeatherTool, fetchWeather),
  ];

  if (lab) bindings.push(...labBindings(lab));

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

  // The lab half of the prompt travels with the lab half of the tool set, so a
  // deployment without one is never told it has the other. main.ts recomposes
  // this with the editable persona and must pass the same extra.
  return lab
    ? {
        tools: [...toolSpecs, ...labTools.map(toToolSpec)],
        system: composeSystem(undefined, LAB_POLICY),
        runTool,
      }
    : { tools: toolSpecs, system: AGENT_SYSTEM, runTool };
}
