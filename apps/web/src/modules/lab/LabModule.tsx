import type {
  BenchmarkResult,
  DatasetSource,
  FinetuneRequest,
  LabJob,
} from "@penumbra/shared";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { isFsAvailable, readHead } from "../../fs/fsClient";
import { datasetFormat, scanDatasets } from "./datasetLibrary";
import {
  analyzeHead,
  type DatasetPreview,
  type DatasetSchema,
} from "./datasetPreview";
import { scanModels } from "./modelLibrary";
import { type FileLibrary, useFileLibrary } from "./useFileLibrary";
import { useLab } from "./useLab";

/** Studio's `format_type` options, offered in the finetune form. */
type FormatType = FinetuneRequest["format"];
const FORMAT_OPTIONS: FormatType[] = [
  "auto",
  "alpaca",
  "chatml",
  "mistral",
  "raw",
  "custom",
  "generic",
];

// The head we read to preview a dataset — enough for the schema and a few
// records, small enough to stay instant on a multi-GB file.
const PREVIEW_BYTES = 64 * 1024;

/** A value that names a file on this device — an absolute path or `~` — versus a
 *  HuggingFace id (`org/name`), which needs no transfer. Only local picks are
 *  uploaded to the host before a run. */
const looksLocalPath = (v: string): boolean => /^(~|\/|[A-Za-z]:[\\/])/.test(v);

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

/** Bytes → a rough human size. Model and dataset files are large, so GB/MB. */
function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/**
 * An on-device library panel: pick a folder, see the matching files in it, and
 * click one to fill a form field with its path. Used for both the model and
 * dataset libraries — they differ only in what they scan for and how each row
 * renders. Desktop-only (needs disk access); the web build shows a hint instead.
 *
 * Selecting an item fills the field with its *client* path. Transferring the
 * file to the Studio host is a later step, so for now a HuggingFace id typed in
 * the field is what trains end to end.
 */
function LibraryPanel<T>({
  title,
  library,
  selected,
  onSelect,
  itemKey,
  emptyHint,
  unavailableHint,
  renderItem,
}: {
  title: string;
  library: FileLibrary<T>;
  selected: string;
  onSelect: (path: string) => void;
  /** The item's absolute path — its selection value and list key. */
  itemKey: (item: T) => string;
  emptyHint: string;
  unavailableHint: string;
  renderItem: (item: T) => ReactNode;
}) {
  if (!library.available) {
    return <p className="lab__library-note">{unavailableHint}</p>;
  }

  return (
    <div className="lab__library">
      <div className="lab__library-head">
        <span className="lab__library-title">{title}</span>
        <div className="lab__library-actions">
          <button type="button" onClick={() => void library.pick()}>
            {library.dir ? "Change folder" : "Choose folder"}
          </button>
          {library.dir && (
            <>
              <button
                type="button"
                onClick={() => void library.rescan()}
                disabled={library.scanning}
              >
                {library.scanning ? "Scanning…" : "Rescan"}
              </button>
              <button type="button" onClick={library.clear}>
                Clear
              </button>
            </>
          )}
        </div>
      </div>

      {library.dir && <p className="lab__library-path">{library.dir}</p>}
      {library.error && <p className="lab__library-error">⚠️ {library.error}</p>}
      {library.dir && !library.scanning && library.items.length === 0 && (
        <p className="lab__library-note">{emptyHint}</p>
      )}

      {library.items.length > 0 && (
        <ul className="lab__lib-list">
          {library.items.map((item) => {
            const path = itemKey(item);
            return (
              <li key={path}>
                <button
                  type="button"
                  className="lab__lib-item"
                  aria-pressed={selected === path}
                  onClick={() => onSelect(path)}
                  title={path}
                >
                  {renderItem(item)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Shorten a value for a preview cell. */
function previewText(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/** Render one dataset record by its detected schema — chat turns for
 *  conversational data, labelled fields for Alpaca, raw JSON otherwise. */
function RecordView({
  record,
  schema,
}: {
  record: unknown;
  schema: DatasetSchema;
}) {
  const rec =
    typeof record === "object" && record !== null
      ? (record as Record<string, unknown>)
      : null;

  const turns =
    rec && schema === "chatml" && Array.isArray(rec.messages)
      ? { list: rec.messages, roleKey: "role", textKey: "content" }
      : rec && schema === "sharegpt" && Array.isArray(rec.conversations)
        ? { list: rec.conversations, roleKey: "from", textKey: "value" }
        : null;

  if (turns) {
    return (
      <div className="lab__preview-turns">
        {turns.list.slice(0, 6).map((t) => {
          const m = (typeof t === "object" && t ? t : {}) as Record<
            string,
            unknown
          >;
          const role = String(m[turns.roleKey] ?? "?");
          const content = previewText(m[turns.textKey]);
          return (
            <div
              className="lab__preview-turn"
              key={`${role}:${content.slice(0, 32)}`}
            >
              <span className="lab__preview-role">{role}</span>
              <span className="lab__preview-content">{content}</span>
            </div>
          );
        })}
      </div>
    );
  }

  if (rec && schema === "alpaca") {
    return (
      <div className="lab__preview-turns">
        {(["instruction", "input", "output"] as const).map((field) =>
          rec[field] == null || rec[field] === "" ? null : (
            <div className="lab__preview-turn" key={field}>
              <span className="lab__preview-role">{field}</span>
              <span className="lab__preview-content">
                {previewText(rec[field])}
              </span>
            </div>
          ),
        )}
      </div>
    );
  }

  return <pre className="lab__preview-json">{previewText(record)}</pre>;
}

/**
 * Reads the head of the selected dataset (desktop only), then shows its detected
 * schema, a record count, any validation issues, and the first few records — so
 * a bad file or a preference dataset is caught before a run starts. Reports the
 * detected `format_type` up so the finetune form can preselect it.
 */
function DatasetPreviewPanel({
  dataset,
  onDetectFormat,
}: {
  dataset: string;
  onDetectFormat: (format: FormatType) => void;
}) {
  const [preview, setPreview] = useState<DatasetPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const path = dataset.trim();
  const format = datasetFormat(path);

  useEffect(() => {
    // Only a local dataset file on desktop can be read; an HF id or a bare name
    // has no head to preview.
    if (!isFsAvailable || !format) {
      setPreview(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    readHead(path, PREVIEW_BYTES)
      .then((head) => {
        if (cancelled) return;
        const result = analyzeHead(head.content, format, head.truncated);
        setPreview(result);
        onDetectFormat(result.formatType);
      })
      .catch((err) => {
        if (cancelled) return;
        setPreview(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, format, onDetectFormat]);

  if (!isFsAvailable || !format) return null;

  return (
    <div className="lab__preview">
      {loading && <p className="lab__library-note">Reading dataset…</p>}
      {error && <p className="lab__library-error">⚠️ {error}</p>}
      {preview && (
        <>
          <div className="lab__preview-head">
            <span className="lab__lib-badge lab__lib-badge--hf">
              {preview.schema}
            </span>
            <span className="lab__preview-meta">
              format: {preview.formatType} ·{" "}
              {preview.exact
                ? `${preview.count} records`
                : `${preview.count}+ records (sampled)`}
            </span>
          </div>
          {preview.issues.length > 0 && (
            <ul className="lab__preview-issues">
              {preview.issues.map((issue) => (
                <li
                  key={issue.message}
                  className={`lab__preview-issue lab__preview-issue--${issue.level}`}
                >
                  {issue.level === "error" ? "⛔" : "⚠️"} {issue.message}
                </li>
              ))}
            </ul>
          )}
          <div className="lab__preview-records">
            {preview.records.slice(0, 3).map((record) => (
              <div
                className="lab__preview-record"
                key={previewText(record).slice(0, 48)}
              >
                <RecordView record={record} schema={preview.schema} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function LabModule() {
  const lab = useLab();
  const modelLibrary = useFileLibrary("penumbra.lab.modelDir", scanModels);
  const datasetLibrary = useFileLibrary(
    "penumbra.lab.datasetDir",
    scanDatasets,
  );
  const [tab, setTab] = useState<Tab>("finetune");
  const [baseModel, setBaseModel] = useState("");
  const [dataset, setDataset] = useState("");
  // Studio's format_type. Preselected from the dataset preview's detection, but
  // an explicit choice here always wins.
  const [format, setFormat] = useState<FormatType>("auto");
  const [maxSteps, setMaxSteps] = useState(60);
  const [benchModel, setBenchModel] = useState("");
  const [suite, setSuite] = useState("penumbra-tools-v1");
  const [samples, setSamples] = useState(20);
  const [colabURL, setColabURL] = useState("");
  const [colabKey, setColabKey] = useState("");
  const [providerOpen, setProviderOpen] = useState(false);
  // Transfer state for the pre-run upload of a local model/dataset to the host.
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

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

  // Report upload progress as a percentage when the total is known, else as the
  // bytes sent so far.
  const uploadReporter = (label: string) => (done: number, total: number) => {
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    setUploadMsg(
      total > done ? `${label} ${pct}%` : `${label} ${formatSize(done)}`,
    );
  };

  async function onFinetune(event: FormEvent) {
    event.preventDefault();
    let modelRef = baseModel.trim();
    let datasetRef = dataset.trim();

    // A local pick names a file only this device can read; send it to the host
    // first and train from the path it returns. HF ids pass through untouched.
    if (
      isFsAvailable &&
      (looksLocalPath(modelRef) || looksLocalPath(datasetRef))
    ) {
      setUploading(true);
      try {
        if (looksLocalPath(modelRef)) {
          modelRef = await lab.uploadModel(
            modelRef,
            uploadReporter("Uploading model…"),
          );
        }
        if (looksLocalPath(datasetRef)) {
          datasetRef = await lab.uploadDataset(
            datasetRef,
            uploadReporter("Uploading dataset…"),
          );
        }
        setUploadMsg(null);
      } catch (err) {
        setUploadMsg(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
        return;
      } finally {
        setUploading(false);
      }
    }

    void lab.finetune({
      baseModel: modelRef,
      dataset: toDatasetSource(datasetRef),
      learningRate: 2e-4,
      maxSteps,
      loraR: 16,
      // Preselected from the dataset preview's detection; overridable in the form.
      format,
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
        <div className="lab__finetune">
          <LibraryPanel
            title="Model library"
            library={modelLibrary}
            selected={baseModel}
            onSelect={setBaseModel}
            itemKey={(m) => m.path}
            unavailableHint="Open the desktop app to browse models on this device — the web preview can't read your filesystem."
            emptyHint="No models here. Pick a folder holding .gguf files or HuggingFace model directories (a folder with a config.json)."
            renderItem={(m) => (
              <>
                <span className={`lab__lib-badge lab__lib-badge--${m.kind}`}>
                  {m.kind}
                </span>
                <span className="lab__lib-name">{m.name}</span>
                {m.size !== null && (
                  <span className="lab__lib-size">{formatSize(m.size)}</span>
                )}
              </>
            )}
          />
          <LibraryPanel
            title="Dataset library"
            library={datasetLibrary}
            selected={dataset}
            onSelect={setDataset}
            itemKey={(d) => d.path}
            unavailableHint="Open the desktop app to browse datasets on this device — the web preview can't read your filesystem."
            emptyHint="No datasets here. Pick a folder holding .jsonl, .json, .csv, or .parquet files."
            renderItem={(d) => (
              <>
                <span className="lab__lib-badge">{d.format}</span>
                <span className="lab__lib-name">{d.name}</span>
                {d.size !== null && (
                  <span className="lab__lib-size">{formatSize(d.size)}</span>
                )}
              </>
            )}
          />
          <DatasetPreviewPanel dataset={dataset} onDetectFormat={setFormat} />
          <form className="lab__form" onSubmit={onFinetune}>
            <input
              aria-label="Base model"
              placeholder="Base model — pick from the library, or a HuggingFace id"
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
              Format
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as FormatType)}
              >
                {FORMAT_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label className="lab__field">
              Max steps
              <input
                type="number"
                min={1}
                value={maxSteps}
                onChange={(e) => setMaxSteps(Number(e.target.value))}
              />
            </label>
            {uploadMsg && <p className="lab__library-note">{uploadMsg}</p>}
            {/* Studio runs one training job at a time; asking for a second is a
                guaranteed failure, so the button is disabled instead. It also
                stays disabled when neither the local nor the Colab trainer is
                reachable — the server would only reject it (no_trainer) — and
                while a local model/dataset is being transferred to the host. */}
            <button
              type="submit"
              disabled={
                !baseModel.trim() ||
                !dataset.trim() ||
                lab.running ||
                uploading ||
                trainTarget === null
              }
            >
              {uploading
                ? "Uploading…"
                : lab.running
                  ? "A job is running…"
                  : trainTarget === "colab"
                    ? "Start fine-tune on Colab"
                    : "Start fine-tune"}
            </button>
          </form>
        </div>
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
