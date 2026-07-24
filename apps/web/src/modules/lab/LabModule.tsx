import type { BenchmarkResult, DatasetSource, LabJob } from "@penumbra/shared";
import { type FormEvent, useEffect, useState } from "react";
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
  const [colabURL, setColabURL] = useState("");
  const [colabKey, setColabKey] = useState("");
  const [providerOpen, setProviderOpen] = useState(false);

  // Escape closes the compute popover, matching the backdrop click.
  useEffect(() => {
    if (!providerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProviderOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [providerOpen]);

  const suites = lab.status?.suites ?? [];
  const selected = suites.find((s) => s.id === suite);
  const lmEvalMissing =
    selected?.kind === "general" && lab.status?.lmEval === "missing";

  // Where a fine-tune would land right now: local Studio when it's up, else the
  // Colab fallback if it's reachable. null means nothing can train.
  const colab = lab.status?.colab;
  const trainTarget: "local" | "colab" | null =
    lab.status?.studio === "ready"
      ? "local"
      : colab?.studio === "ready"
        ? "colab"
        : null;

  function onSaveColab(event: FormEvent) {
    event.preventDefault();
    void lab.setColab(colabURL.trim(), colabKey);
    // Don't keep the bearer in component state once it's been handed off.
    setColabKey("");
  }

  function onFinetune(event: FormEvent) {
    event.preventDefault();
    void lab.finetune({
      baseModel,
      dataset: toDatasetSource(dataset),
      learningRate: 2e-4,
      maxSteps,
      loraR: 16,
      // Studio detects the dataset shape; surfaced as a control only if
      // detection turns out to guess wrong often enough to matter.
      format: "auto",
    });
  }

  function onBenchmark(event: FormEvent) {
    event.preventDefault();
    void lab.benchmark(benchModel, suite, samples);
  }

  return (
    <div className="lab">
      <div className="lab__status">
        {/* The Studio pill doubles as the compute-provider control: click it to
            open the popover that configures the Colab fallback. */}
        <button
          type="button"
          className={`lab__pill lab__pill--${lab.status?.studio ?? "stopped"} lab__pill--action`}
          onClick={() => setProviderOpen((open) => !open)}
          aria-haspopup="dialog"
          aria-expanded={providerOpen}
          title="Configure compute providers"
        >
          Studio: {lab.status?.studio ?? "unreachable"}
          {colab?.configured && ` · Colab: ${colab.studio}`}
          <span className="lab__pill-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        <span className="lab__pill">
          lm-eval: {lab.status?.lmEval ?? "unknown"}
        </span>

        {providerOpen && (
          <>
            {/* A transparent backdrop so a click anywhere outside dismisses. */}
            <button
              type="button"
              className="lab__popover-backdrop"
              aria-label="Close compute providers"
              onClick={() => setProviderOpen(false)}
            />
            <div
              className="lab__popover"
              role="dialog"
              aria-label="Compute providers"
            >
              <div className="lab__popover-head">
                <span
                  className={`lab__pill lab__pill--${lab.status?.studio ?? "stopped"}`}
                >
                  Local Studio: {lab.status?.studio ?? "unreachable"}
                </span>
              </div>
              {lab.status?.studio === "unauthorized" && (
                <p className="lab__provider-note lab__provider-note--warn">
                  Studio is running but rejected the server's key. Set
                  UNSLOTH_API_KEY on the server (apps/server/.env) and restart
                  it.
                </p>
              )}

              {/* Colab fallback. The key is sent to the server and never read
                  back, so this field is always blank on load — re-enter it to
                  change the endpoint. */}
              <form className="lab__form" onSubmit={onSaveColab}>
                <span className="lab__popover-label">Colab fallback</span>
                <input
                  aria-label="Colab endpoint URL"
                  placeholder="https://xxxx.trycloudflare.com"
                  value={colabURL}
                  onChange={(e) => setColabURL(e.target.value)}
                />
                <input
                  aria-label="Colab API key"
                  type="password"
                  placeholder="Bearer token (optional on a trusted tunnel)"
                  value={colabKey}
                  onChange={(e) => setColabKey(e.target.value)}
                />
                <div className="lab__provider-actions">
                  <button type="submit" disabled={!colabURL.trim()}>
                    {colab?.configured ? "Update" : "Save"}
                  </button>
                  {colab?.configured && (
                    <button type="button" onClick={() => void lab.clearColab()}>
                      Remove
                    </button>
                  )}
                </div>
                {colab?.configured && (
                  <p className="lab__provider-note">
                    Fallback: {colab.baseURL} — {colab.studio}
                  </p>
                )}
              </form>
            </div>
          </>
        )}
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
                guaranteed failure, so the button is disabled instead. It also
                stays disabled when neither the local nor the Colab trainer is
                reachable — the server would only reject it (no_trainer). */}
          <button
            type="submit"
            disabled={
              !baseModel.trim() ||
              !dataset.trim() ||
              lab.running ||
              trainTarget === null
            }
          >
            {lab.running
              ? "A job is running…"
              : trainTarget === "colab"
                ? "Start fine-tune on Colab"
                : "Start fine-tune"}
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
