import {
  type BenchmarkResult,
  type DatasetSource,
  type FinetuneRequest,
  type LabJob,
  type LabRun,
  looksLocalPath,
  STORAGE_NAMESPACE,
} from "@penumbra/shared";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { ComputeTargets } from "../../compute/ComputeTargets";
import { useCompute } from "../../compute/useCompute";
import { isFsAvailable, readHead } from "../../fs/fsClient";
import { datasetFormat, scanDatasets } from "./datasetLibrary";
import {
  analyzeHead,
  type DatasetPreview,
  type DatasetSchema,
} from "./datasetPreview";
import { scanModels } from "./modelLibrary";
import { Section, type SectionState, useSections } from "./Section";
import { type FileLibrary, useFileLibrary } from "./useFileLibrary";
import { type ExportRequestInput, useLab } from "./useLab";

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

// The Model Lab: fine-tune a model, export it, and benchmark it. Card chrome
// belongs to the shell's dock card / focus pane, so this renders only inner
// content.
//
// Scores from the two suite families are shown side by side and never averaged
// — a model can gain reasoning ability while getting worse at calling
// create_task (docs/MODEL_LAB.md → Suites).

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

/**
 * A timestamp as an age — "just now", "12 min ago", "3 days ago" — falling back
 * to a date past a week. Which run is the latest is the question the list is
 * scanned for, and an age answers it without reading two clocks.
 */
export function formatWhen(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const plural = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? "" : "s"} ago`;

  const secs = Math.round((now - then) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return plural(mins, "min");
  const hours = Math.round(mins / 60);
  if (hours < 24) return plural(hours, "hr");
  const days = Math.round(hours / 24);
  if (days <= 7) return plural(days, "day");
  return new Date(then).toLocaleDateString();
}

/** The age of a timestamp, with the exact time a hover away. */
function When({ at, className }: { at: string; className: string }) {
  return (
    <time
      className={className}
      dateTime={at}
      title={new Date(at).toLocaleString()}
    >
      {formatWhen(at)}
    </time>
  );
}

function JobLine({ job }: { job: LabJob }) {
  const pct = job.progress === null ? null : Math.round(job.progress * 100);
  return (
    <li className={`lab__job lab__job--${job.state}`}>
      <span className="lab__job-kind">{job.kind}</span>
      <span className="lab__job-state">{job.state}</span>
      {pct !== null && <span className="lab__job-pct">{pct}%</span>}
      <When at={job.updatedAt} className="lab__job-when" />
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
  library,
  selected,
  onSelect,
  itemKey,
  emptyHint,
  unavailableHint,
  renderItem,
}: {
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
      {/* The section header holds the title; these act on the folder it names. */}
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

/** GGUF quantizations worth offering. Q4_K_M is the usual default: a ~4x
 *  smaller file that most people can actually run. */
const QUANTIZATIONS = ["Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0", "BF16"];

/**
 * Settings for one export. Beyond the quantization, this is where a run gets
 * published to the HuggingFace Hub — which for a Colab run is not a nicety:
 * Studio writes the artifact to the trainer's own disk and serves nothing for
 * download, so a push is the only way it outlives the session.
 *
 * The token is held here only while the form is open and is sent with the one
 * request. It is never stored, echoed back, or written to the job record.
 */
function ExportForm({
  run,
  busy,
  onSubmit,
  onCancel,
}: {
  run: LabRun;
  busy: boolean;
  onSubmit: (req: ExportRequestInput) => void;
  onCancel: () => void;
}) {
  const [quantization, setQuantization] = useState(QUANTIZATIONS[0]);
  // Pre-armed for a Colab run, where not pushing means losing the artifact.
  const [toHub, setToHub] = useState(run.provider === "colab");
  const [repoId, setRepoId] = useState("");
  const [hfToken, setHfToken] = useState("");
  const [isPrivate, setPrivate] = useState(true);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({
      runId: run.id,
      quantization,
      ...(toHub
        ? {
            repoId: repoId.trim(),
            private: isPrivate,
            ...(hfToken ? { hfToken } : {}),
          }
        : {}),
    });
  }

  return (
    <form className="lab__export" onSubmit={submit}>
      <label className="lab__field">
        Quantization
        <select
          value={quantization}
          onChange={(e) => setQuantization(e.target.value)}
        >
          {QUANTIZATIONS.map((q) => (
            <option key={q} value={q}>
              {q}
            </option>
          ))}
        </select>
      </label>

      <label className="lab__check">
        <input
          type="checkbox"
          checked={toHub}
          onChange={(e) => setToHub(e.target.checked)}
        />
        Push to the HuggingFace Hub
      </label>

      {/* Where the bytes go. Studio writes to its own disk and serves nothing
          for download, and that disk is only this machine when the run says
          local — a detail worth stating before a five-minute quantization. */}
      <p className="lab__library-note">
        Writes to <code>{run.outputDir}/gguf</code> on the {run.provider}{" "}
        trainer.{" "}
        {toHub
          ? "The Hub push is what brings it anywhere else."
          : "Nothing is downloaded to this device."}
      </p>

      {run.provider === "colab" && !toHub && (
        <p className="lab__library-error">
          ⚠️ This run trained on Colab. Without a push, the export stays on that
          machine and is lost when the session ends.
        </p>
      )}

      {toHub && (
        <>
          <input
            aria-label="Hub repository"
            placeholder="Repository — username/model-name"
            value={repoId}
            onChange={(e) => setRepoId(e.target.value)}
          />
          <input
            aria-label="HuggingFace token"
            type="password"
            placeholder="Write token (needed unless the trainer already has one)"
            value={hfToken}
            onChange={(e) => setHfToken(e.target.value)}
          />
          <label className="lab__check">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setPrivate(e.target.checked)}
            />
            Private repository
          </label>
        </>
      )}

      <div className="lab__export-actions">
        <button type="submit" disabled={busy || (toHub && !repoId.trim())}>
          {busy ? "A job is running…" : "Start export"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** What a collapsed library section still says: how much the chosen folder
 *  holds, or that there is nothing to open yet. */
function libraryMeta<T>(library: FileLibrary<T>): string {
  if (!library.available) return "desktop only";
  if (!library.dir) return "no folder";
  if (library.scanning) return "scanning…";
  return `${library.items.length} found`;
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
  sections,
}: {
  dataset: string;
  onDetectFormat: (format: FormatType) => void;
  sections: SectionState;
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
    <Section
      id="dataset-preview"
      title="Dataset preview"
      meta={loading ? "reading…" : preview ? preview.schema : null}
      state={sections}
    >
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
    </Section>
  );
}

export function LabModule() {
  const lab = useLab();
  // Which Studio trains, benchmarks, and answers chat. Shared with the chat
  // pill rather than owned here.
  const compute = useCompute();
  const modelLibrary = useFileLibrary(
    `${STORAGE_NAMESPACE}.lab.model-dir.v1`,
    scanModels,
    "penumbra.lab.modelDir",
  );
  const datasetLibrary = useFileLibrary(
    `${STORAGE_NAMESPACE}.lab.dataset-dir.v1`,
    scanDatasets,
    "penumbra.lab.datasetDir",
  );
  const sections = useSections();
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
  const [providerOpen, setProviderOpen] = useState(false);
  // Transfer state for the pre-run upload of a local model/dataset to the host.
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  /** Run id whose export form is open, if any. */
  const [exporting, setExporting] = useState<string | null>(null);

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
  // Colab fallback if it's reachable. null means nothing can train. Read from
  // the compute targets rather than a Lab-owned status, since training shares
  // them with chat and benchmarking.
  const localTarget = compute.state?.targets.find((t) => t.id === "local");
  const colabTarget = compute.state?.targets.find((t) => t.id === "colab");
  const trainTarget: "local" | "colab" | null =
    localTarget?.state === "ready"
      ? "local"
      : colabTarget?.state === "ready"
        ? "colab"
        : null;

  // Colab trains on a machine that has never seen this filesystem. It fetches a
  // model name from HuggingFace, so a path reaches it as a malformed repo id —
  // and uploading gigabytes to *this* host first wouldn't help, since the model
  // still has to exist over there. Caught before the run rather than after.
  const remoteNeedsHfModel =
    trainTarget === "colab" && looksLocalPath(baseModel.trim());

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

    if (remoteNeedsHfModel) return;

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
        {/* The compute pill doubles as the control: click it to open the
            shared targets panel — the same one the chat pill opens, because it
            is the same setting. */}
        <button
          type="button"
          className={`lab__pill lab__pill--${localTarget?.state ?? "stopped"} lab__pill--action`}
          onClick={() => setProviderOpen((open) => !open)}
          aria-haspopup="dialog"
          aria-expanded={providerOpen}
          title="Configure compute targets"
        >
          Studio: {localTarget?.state ?? "unreachable"}
          {colabTarget?.configured && ` · Colab: ${colabTarget.state}`}
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
              aria-label="Close compute targets"
              onClick={() => setProviderOpen(false)}
            />
            <div
              className="lab__popover"
              role="dialog"
              aria-label="Compute targets"
            >
              <ComputeTargets compute={compute} />
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
          <Section
            id="model-library"
            title="Model library"
            meta={libraryMeta(modelLibrary)}
            state={sections}
          >
            <LibraryPanel
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
          </Section>
          <Section
            id="dataset-library"
            title="Dataset library"
            meta={libraryMeta(datasetLibrary)}
            state={sections}
          >
            <LibraryPanel
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
          </Section>
          <DatasetPreviewPanel
            dataset={dataset}
            onDetectFormat={setFormat}
            sections={sections}
          />
          <Section id="finetune-form" title="Fine-tune" state={sections}>
            <form className="lab__form" onSubmit={onFinetune}>
              <input
                aria-label="Base model"
                placeholder="Base model — pick from the library, or a HuggingFace id"
                value={baseModel}
                onChange={(e) => setBaseModel(e.target.value)}
              />
              {remoteNeedsHfModel && (
                <p className="lab__library-error">
                  ⚠️ Training would run on Colab, which can't read a file on this
                  device. Give the base model as a HuggingFace id — the dataset
                  still uploads.
                </p>
              )}
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
                  remoteNeedsHfModel ||
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
          </Section>
        </div>
      )}

      {tab === "runs" && (
        <ul className="lab__runs">
          {lab.runs.length === 0 && (
            <li className="lab__empty">No runs yet.</li>
          )}
          {lab.runs.map((run) => {
            // The export job for this row, if one has ever run. Jobs come back
            // newest first, so the first match is the current attempt.
            const job = lab.jobs.find(
              (j) => j.kind === "export" && j.runId === run.id,
            );
            const active = job?.state === "queued" || job?.state === "running";
            return (
              <li key={run.id}>
                <div className="lab__run">
                  {/* Newest first, so the top row is the latest run — the
                      timestamp is what confirms it against a run started
                      elsewhere. */}
                  <When at={run.createdAt} className="lab__run-when" />
                  <span className="lab__run-model">{run.baseModel}</span>
                  {/* Where the checkpoint physically is. A Colab run's artifacts
                      live on a machine that goes away, which decides whether the
                      export needs a Hub push. */}
                  <span
                    className={`lab__run-where lab__run-where--${run.provider}`}
                  >
                    {run.provider}
                  </span>
                  <span className="lab__run-dataset">{run.dataset}</span>
                  {run.ggufPath ? (
                    <span
                      className="lab__run-gguf"
                      title={`${run.ggufPath} (on the ${run.provider} trainer)`}
                    >
                      {run.hubRepo ? `pushed → ${run.hubRepo}` : "exported"}
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={!run.outputDir || lab.running}
                      onClick={() =>
                        setExporting(exporting === run.id ? null : run.id)
                      }
                    >
                      {active ? "Exporting…" : "Export GGUF"}
                    </button>
                  )}
                </div>

                {/* An export takes minutes and writes to a machine that may not
                    be this one. Without a line here the only sign anything
                    happened was a row that didn't change. */}
                {job && (active || job.state === "failed") && (
                  <p
                    className={
                      job.state === "failed"
                        ? "lab__run-status lab__run-status--failed"
                        : "lab__run-status"
                    }
                  >
                    {job.state === "failed" ? "⛔ " : "⏳ "}
                    {job.error ?? job.detail ?? job.state}
                  </p>
                )}
                {run.ggufPath && !run.hubRepo && (
                  <p className="lab__run-status">
                    Written to {run.ggufPath} on the {run.provider} trainer —
                    not pushed anywhere.
                  </p>
                )}

                {exporting === run.id && (
                  <ExportForm
                    run={run}
                    busy={lab.running}
                    onCancel={() => setExporting(null)}
                    onSubmit={(req) => {
                      setExporting(null);
                      void lab.exportRun(req);
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {tab === "benchmarks" && (
        <div className="lab__benchmarks">
          <Section id="benchmark-form" title="Run a benchmark" state={sections}>
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
          </Section>

          <Section
            id="scores"
            title="Scores"
            meta={`${lab.scores.length} recorded`}
            state={sections}
          >
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
          </Section>
        </div>
      )}

      {/* The job strip: just the latest, as a live line for the run in flight
          and the last thing to have failed. The full history is the Runs tab. */}
      <ul className="lab__jobs">
        {lab.jobs.slice(0, 1).map((job) => (
          <JobLine key={job.id} job={job} />
        ))}
      </ul>
    </div>
  );
}
