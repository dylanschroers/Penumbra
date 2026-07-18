import type { BenchmarkResult, DatasetSource, LabJob } from "@penumbra/shared";
import { type FormEvent, useState } from "react";
import { useLab } from "./useLab";

// The Model Lab: fine-tune a model, export it, and benchmark it. Card chrome
// belongs to the workspace ModuleFrame, so this renders only inner content.
//
// Scores from the two suite families are shown side by side and never averaged
// — a model can gain reasoning ability while getting worse at calling
// create_task (docs/model_lab_plan.md M3).

type Tab = "finetune" | "runs" | "benchmarks";

/**
 * Decide whether a dataset string names a HuggingFace repo or a file on the
 * Studio host. HF ids look like `owner/name` and never start with a path
 * marker, so leading `.` or `/` is the discriminator — as is a data file
 * extension, which no HF repo id carries.
 */
export function toDatasetSource(value: string): DatasetSource {
  const trimmed = value.trim();
  const looksLikePath =
    trimmed.startsWith(".") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    /\.(jsonl|json|csv|parquet)$/i.test(trimmed);
  return looksLikePath
    ? { kind: "local", path: trimmed }
    : { kind: "hf", id: trimmed };
}

function JobLine({ job }: { job: LabJob }) {
  const pct = job.progress === null ? null : Math.round(job.progress * 100);
  return (
    <li className={`lab__job lab__job--${job.state}`}>
      <span className="lab__job-kind">{job.kind}</span>
      <span className="lab__job-state">{job.state}</span>
      {pct !== null && <span className="lab__job-pct">{pct}%</span>}
      <span className="lab__job-detail">{job.error ?? job.detail ?? ""}</span>
    </li>
  );
}

/** One benchmark run. Values are rates unless the metric says otherwise. */
function ScoreRow({ result }: { result: BenchmarkResult }) {
  return (
    <tr>
      <td>{new Date(result.at).toLocaleString()}</td>
      <td>{result.model}</td>
      <td>
        <span className={`lab__kind lab__kind--${result.suiteKind}`}>
          {result.suiteKind}
        </span>{" "}
        {result.suite}
      </td>
      {/* Always shown: a 20-sample score is not a leaderboard number. */}
      <td>n={result.samplesPerTask}</td>
      <td>
        {result.scores.map((s) => (
          <div key={`${s.task}:${s.metric}`} className="lab__score">
            <span>{s.task}</span>
            <span>
              {s.metric === "avg_ms"
                ? `${Math.round(s.value)}ms`
                : s.value.toFixed(3)}
            </span>
          </div>
        ))}
      </td>
    </tr>
  );
}

export function LabModule() {
  const lab = useLab();
  const [tab, setTab] = useState<Tab>("finetune");
  const [baseModel, setBaseModel] = useState("");
  const [dataset, setDataset] = useState("");
  const [maxSteps, setMaxSteps] = useState(60);
  const [benchModel, setBenchModel] = useState("");
  const [suite, setSuite] = useState("penumbra-tools-v1");
  const [samples, setSamples] = useState(20);

  const suites = lab.status?.suites ?? [];
  const selected = suites.find((s) => s.id === suite);
  const lmEvalMissing =
    selected?.kind === "general" && lab.status?.lmEval === "missing";

  function onFinetune(event: FormEvent) {
    event.preventDefault();
    void lab.finetune({
      baseModel,
      dataset: toDatasetSource(dataset),
      learningRate: 2e-4,
      maxSteps,
      loraR: 16,
    });
  }

  function onBenchmark(event: FormEvent) {
    event.preventDefault();
    void lab.benchmark(benchModel, suite, samples);
  }

  return (
    <div className="lab">
      <div className="lab__status">
        <span
          className={`lab__pill lab__pill--${lab.status?.studio ?? "stopped"}`}
        >
          Studio: {lab.status?.studio ?? "unreachable"}
        </span>
        <span className="lab__pill">
          lm-eval: {lab.status?.lmEval ?? "unknown"}
        </span>
      </div>

      <nav className="lab__tabs">
        {(["finetune", "runs", "benchmarks"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? "lab__tab lab__tab--active" : "lab__tab"}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>

      {lab.error && <p className="lab__error">⚠️ {lab.error}</p>}

      {tab === "finetune" && (
        <form className="lab__form" onSubmit={onFinetune}>
          <input
            aria-label="Base model"
            placeholder="Base model (e.g. unsloth/Llama-3.2-1B-Instruct)"
            value={baseModel}
            onChange={(e) => setBaseModel(e.target.value)}
          />
          <input
            aria-label="Dataset"
            placeholder="Dataset — HF id, or ./path for a local file"
            value={dataset}
            onChange={(e) => setDataset(e.target.value)}
          />
          <label className="lab__field">
            Max steps
            <input
              type="number"
              min={1}
              value={maxSteps}
              onChange={(e) => setMaxSteps(Number(e.target.value))}
            />
          </label>
          {/* Studio runs one training job at a time; asking for a second is a
              guaranteed failure, so the button is disabled instead. */}
          <button
            type="submit"
            disabled={
              !baseModel.trim() ||
              !dataset.trim() ||
              lab.running ||
              lab.status?.studio !== "ready"
            }
          >
            {lab.running ? "A job is running…" : "Start fine-tune"}
          </button>
        </form>
      )}

      {tab === "runs" && (
        <ul className="lab__runs">
          {lab.runs.length === 0 && (
            <li className="lab__empty">No runs yet.</li>
          )}
          {lab.runs.map((run) => (
            <li key={run.id} className="lab__run">
              <span className="lab__run-model">{run.baseModel}</span>
              <span className="lab__run-dataset">{run.dataset}</span>
              {run.ggufPath ? (
                <span className="lab__run-gguf">exported</span>
              ) : (
                <button
                  type="button"
                  disabled={!run.outputDir || lab.running}
                  onClick={() => void lab.exportRun(run.id)}
                >
                  Export GGUF
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {tab === "benchmarks" && (
        <>
          <form className="lab__form" onSubmit={onBenchmark}>
            <input
              aria-label="Model to benchmark"
              placeholder="Model id"
              value={benchModel}
              onChange={(e) => setBenchModel(e.target.value)}
            />
            <select
              aria-label="Suite"
              value={suite}
              onChange={(e) => setSuite(e.target.value)}
            >
              {suites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <label className="lab__field">
              Samples per task
              <input
                type="number"
                min={1}
                value={samples}
                onChange={(e) => setSamples(Number(e.target.value))}
              />
            </label>
            <button
              type="submit"
              disabled={!benchModel.trim() || lab.running || lmEvalMissing}
            >
              {lmEvalMissing ? "lm-eval not installed" : "Run benchmark"}
            </button>
          </form>

          <table className="lab__scores">
            <thead>
              <tr>
                <th>When</th>
                <th>Model</th>
                <th>Suite</th>
                <th>Samples</th>
                <th>Scores</th>
              </tr>
            </thead>
            <tbody>
              {lab.scores.map((r) => (
                <ScoreRow key={`${r.at}-${r.suite}-${r.model}`} result={r} />
              ))}
            </tbody>
          </table>
        </>
      )}

      <ul className="lab__jobs">
        {lab.jobs.slice(0, 5).map((job) => (
          <JobLine key={job.id} job={job} />
        ))}
      </ul>
    </div>
  );
}
