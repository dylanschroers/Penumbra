import { randomUUID } from "node:crypto";
import type {
  BenchmarkResult,
  LabJob,
  LabJobKind,
  LabJobState,
  LabRun,
} from "@penumbra/shared";
import type Database from "better-sqlite3";

// The job table, not the SSE stream, is the source of truth: every state
// change is written before it is relayed. Not synced: these describe this GPU
// host only.

export interface LabStore {
  /** `runId` ties an export to its run. */
  createJob(kind: LabJobKind, runId?: string): LabJob;
  getJob(id: string): LabJob | undefined;
  listJobs(limit?: number): LabJob[];
  updateJob(
    id: string,
    patch: Partial<Pick<LabJob, "state" | "progress" | "detail" | "error">>,
  ): LabJob | undefined;
  failJob(id: string, error: unknown): void;

  createRun(input: Omit<LabRun, "id" | "createdAt">): LabRun;
  setRunArtifacts(
    id: string,
    patch: Partial<Pick<LabRun, "outputDir" | "ggufPath" | "hubRepo">>,
  ): LabRun | undefined;
  getRun(id: string): LabRun | undefined;
  listRuns(): LabRun[];

  recordScores(result: BenchmarkResult): void;
  listScores(): BenchmarkResult[];
}

const JOB_COLUMNS = `id, kind, state, progress, detail, error, run_id AS runId,
  created_at AS createdAt, updated_at AS updatedAt`;
const RUN_COLUMNS = `id, job_id AS jobId, base_model AS baseModel, dataset,
  output_dir AS outputDir, gguf_path AS ggufPath, hub_repo AS hubRepo,
  provider, created_at AS createdAt`;

/** For databases created before the column existed. */
function addColumn(
  db: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function createLabStore(db: Database.Database): LabStore {
  db.exec(`
CREATE TABLE IF NOT EXISTS lab_jobs (
  id text PRIMARY KEY NOT NULL,
  kind text NOT NULL,
  state text NOT NULL,
  progress real,
  detail text,
  error text,
  run_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
-- created_at alone ties when two jobs land in the same millisecond, so every
-- listing breaks the tie on rowid, which is monotonic.
CREATE INDEX IF NOT EXISTS lab_jobs_created_idx ON lab_jobs (created_at DESC);
CREATE TABLE IF NOT EXISTS lab_runs (
  id text PRIMARY KEY NOT NULL,
  job_id text NOT NULL,
  base_model text NOT NULL,
  dataset text NOT NULL,
  output_dir text,
  gguf_path text,
  hub_repo text,
  provider text NOT NULL DEFAULT 'local',
  created_at text NOT NULL
);
-- One row per task metric. Both benchmark families land here; suite_kind is
-- what keeps a general score from being compared against a personal one.
CREATE TABLE IF NOT EXISTS lab_scores (
  id text PRIMARY KEY NOT NULL,
  suite text NOT NULL,
  suite_kind text NOT NULL,
  model text NOT NULL,
  served_model text,
  target text NOT NULL DEFAULT 'local',
  samples_per_task integer NOT NULL,
  at text NOT NULL,
  duration_ms integer NOT NULL,
  task text NOT NULL,
  metric text NOT NULL,
  value real NOT NULL
);
CREATE INDEX IF NOT EXISTS lab_scores_at_idx ON lab_scores (at DESC);
`);

  addColumn(db, "lab_runs", "provider", "text NOT NULL DEFAULT 'local'");
  addColumn(db, "lab_runs", "hub_repo", "text");
  addColumn(db, "lab_jobs", "run_id", "text");
  // Older scores' served model is unknowable, hence null.
  addColumn(db, "lab_scores", "target", "text NOT NULL DEFAULT 'local'");
  addColumn(db, "lab_scores", "served_model", "text");

  const insertJob = db.prepare(
    `INSERT INTO lab_jobs (id, kind, state, progress, detail, error, run_id, created_at, updated_at)
     VALUES (@id, @kind, @state, NULL, NULL, NULL, @runId, @now, @now)`,
  );
  const selectJob = db.prepare(
    `SELECT ${JOB_COLUMNS} FROM lab_jobs WHERE id = ?`,
  );
  const selectJobs = db.prepare(
    `SELECT ${JOB_COLUMNS} FROM lab_jobs
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  );
  // COALESCE keeps omitted fields unchanged.
  const patchJob = db.prepare(
    `UPDATE lab_jobs SET
       state = COALESCE(@state, state),
       progress = COALESCE(@progress, progress),
       detail = COALESCE(@detail, detail),
       error = COALESCE(@error, error),
       updated_at = @now
     WHERE id = @id`,
  );

  const insertRun = db.prepare(
    `INSERT INTO lab_runs (id, job_id, base_model, dataset, output_dir, gguf_path, hub_repo, provider, created_at)
     VALUES (@id, @jobId, @baseModel, @dataset, @outputDir, @ggufPath, @hubRepo, @provider, @createdAt)`,
  );
  const selectRun = db.prepare(
    `SELECT ${RUN_COLUMNS} FROM lab_runs WHERE id = ?`,
  );
  const selectRuns = db.prepare(
    `SELECT ${RUN_COLUMNS} FROM lab_runs ORDER BY created_at DESC, rowid DESC`,
  );
  const patchRun = db.prepare(
    `UPDATE lab_runs SET
       output_dir = COALESCE(@outputDir, output_dir),
       gguf_path = COALESCE(@ggufPath, gguf_path),
       hub_repo = COALESCE(@hubRepo, hub_repo)
     WHERE id = @id`,
  );

  const insertScore = db.prepare(
    `INSERT INTO lab_scores (id, suite, suite_kind, model, served_model, target,
                             samples_per_task, at, duration_ms, task, metric, value)
     VALUES (@id, @suite, @suiteKind, @model, @servedModel, @target,
             @samplesPerTask, @at, @durationMs, @task, @metric, @value)`,
  );
  const selectScores = db.prepare(
    `SELECT suite, suite_kind AS suiteKind, model, served_model AS servedModel,
            target, samples_per_task AS samplesPerTask,
            at, duration_ms AS durationMs, task, metric, value
     FROM lab_scores ORDER BY at DESC, rowid ASC`,
  );

  // After a restart, running/queued jobs belong to a dead process: they can't
  // progress or be cancelled, and the form disables itself while one exists.
  // Marked failed, not cancelled: nobody stopped them.
  db.prepare(
    `UPDATE lab_jobs
        SET state = 'failed',
            error = 'Interrupted: the server restarted while this was running.',
            updated_at = @now
      WHERE state IN ('running', 'queued')`,
  ).run({ now: new Date().toISOString() });

  return {
    createJob(kind, runId) {
      const id = randomUUID();
      insertJob.run({
        id,
        kind,
        state: "queued",
        runId: runId ?? null,
        now: new Date().toISOString(),
      });
      return selectJob.get(id) as LabJob;
    },
    getJob: (id) => selectJob.get(id) as LabJob | undefined,
    listJobs: (limit = 50) => selectJobs.all(limit) as LabJob[],
    updateJob(id, patch) {
      patchJob.run({
        id,
        state: (patch.state as LabJobState | undefined) ?? null,
        progress: patch.progress ?? null,
        detail: patch.detail ?? null,
        error: patch.error ?? null,
        now: new Date().toISOString(),
      });
      return selectJob.get(id) as LabJob | undefined;
    },
    failJob(id, error) {
      this.updateJob(id, {
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    },

    createRun(input) {
      const run: LabRun = {
        ...input,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      insertRun.run(run);
      return run;
    },
    setRunArtifacts(id, patch) {
      patchRun.run({
        id,
        outputDir: patch.outputDir ?? null,
        ggufPath: patch.ggufPath ?? null,
        hubRepo: patch.hubRepo ?? null,
      });
      return selectRun.get(id) as LabRun | undefined;
    },
    getRun: (id) => selectRun.get(id) as LabRun | undefined,
    listRuns: () => selectRuns.all() as LabRun[],

    recordScores(result) {
      const write = db.transaction((r: BenchmarkResult) => {
        for (const s of r.scores) {
          insertScore.run({
            id: randomUUID(),
            suite: r.suite,
            suiteKind: r.suiteKind,
            model: r.model,
            servedModel: r.servedModel ?? null,
            target: r.target,
            samplesPerTask: r.samplesPerTask,
            at: r.at,
            durationMs: r.durationMs,
            task: s.task,
            metric: s.metric,
            value: s.value,
          });
        }
      });
      write(result);
    },
    listScores() {
      type Row = BenchmarkResult["scores"][number] &
        Omit<BenchmarkResult, "scores">;
      const byRun = new Map<string, BenchmarkResult>();
      for (const row of selectScores.all() as Row[]) {
        // Target is part of the key: same model name on two machines is two
        // measurements.
        const key = `${row.at}|${row.suite}|${row.model}|${row.target}`;
        const existing = byRun.get(key);
        const score = { task: row.task, metric: row.metric, value: row.value };
        if (existing) existing.scores.push(score);
        else
          byRun.set(key, {
            suite: row.suite,
            suiteKind: row.suiteKind,
            model: row.model,
            servedModel: row.servedModel ?? null,
            target: row.target,
            samplesPerTask: row.samplesPerTask,
            at: row.at,
            durationMs: row.durationMs,
            scores: [score],
          });
      }
      return [...byRun.values()];
    },
  };
}
