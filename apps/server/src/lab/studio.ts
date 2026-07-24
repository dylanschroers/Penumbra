import {
  normalizeBaseUrl,
  readSseFrames,
  type SseFrame,
} from "@penumbra/shared";

// Typed client for Unsloth Studio's training, dataset, and export APIs.
//
// Credentials come from the same environment variables UnslothEngine uses, so
// inference and training can never end up pointed at different Studios. The key
// is *unscoped admin* — it can start jobs and write files — which is why it
// lives on the server and no client ever sees it
// (docs/model_lab_plan.md → Deployment topology).

const DEFAULT_BASE_URL = "http://127.0.0.1:8888";

export interface StudioConfig {
  baseURL?: string;
  apiKey?: string;
  env?: Record<string, string | undefined>;
}

/** Studio's report of a training run. Only the fields we consume are typed. */
export interface StudioRun {
  id?: string;
  run_id?: string;
  output_dir?: string;
  status?: string;
}

export interface TrainingStart {
  model_name: string;
  training_type: string;
  /** Required by Studio. "auto" detects the dataset's shape; the alternatives
   *  are alpaca, chatml, mistral, raw, custom, generic. */
  format_type: string;
  local_datasets?: string[];
  hf_dataset?: string;
  learning_rate: number;
  max_steps: number;
  lora_r: number;
  load_in_4bit: boolean;
}

/**
 * Studio's export state. There is deliberately no `status` field: progress is
 * reported as "is an export running" plus the outcome of the last operation.
 * Verified against a live Studio — an earlier version of this client polled a
 * non-existent `status` and would have waited forever.
 */
export interface ExportStatus {
  is_export_active?: boolean;
  /** Monotonic op counter. Compare against a pre-export baseline to tell our
   *  operation apart from one that already finished. */
  last_op_seq?: number;
  /** "success" | "error" | "cancelled". */
  last_op_status?: string | null;
  last_op_output_path?: string | null;
  last_op_error?: string | null;
}

/** One decoded SSE frame from Studio's progress stream. */
export type StudioProgress = SseFrame<Record<string, unknown>>;

/**
 * Studio's readiness as the lab reports it:
 * - `ready` — answering and authorized.
 * - `unauthorized` — up, but the key is missing or wrong (a 401/403). This is a
 *   *different* fix from "not running", so it is not collapsed into `stopped`.
 * - `stopped` — unreachable, or answering with some other error.
 */
export type StudioReachability = "ready" | "unauthorized" | "stopped";

export class StudioClient {
  readonly baseURL: string;
  private readonly headers: Record<string, string>;

  constructor(config: StudioConfig = {}) {
    const env = config.env ?? process.env;
    const key = config.apiKey ?? env.UNSLOTH_API_KEY;
    this.baseURL = normalizeBaseUrl(
      config.baseURL ?? env.UNSLOTH_BASE_URL ?? DEFAULT_BASE_URL,
    );
    // Studio rejects an empty bearer as malformed, so omit the header entirely
    // when there is no key (a trusted-LAN instance may run without one).
    this.headers = key ? { Authorization: `Bearer ${key}` } : {};
  }

  private async json<T>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(`${this.baseURL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
        ...init.headers,
      },
      signal,
    });
    if (!res.ok) {
      // Include the body. Studio answers a malformed request with a 422 whose
      // detail names the offending field; without it the caller sees only
      // "responded 422" and has to reproduce the call by hand to learn why.
      const detail = await res.text().catch(() => "");
      throw new Error(
        `studio ${path} responded ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    return (await res.json()) as T;
  }

  /**
   * The lab's readiness probe. Distinguishes "up but the key is wrong" from
   * "not running", because a 401 sends you looking in the wrong place
   * otherwise — the reason this returns three states rather than a boolean.
   */
  async probe(): Promise<StudioReachability> {
    try {
      const res = await fetch(`${this.baseURL}/v1/models`, {
        headers: this.headers,
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return "ready";
      if (res.status === 401 || res.status === 403) return "unauthorized";
      return "stopped";
    } catch {
      return "stopped";
    }
  }

  /** True when Studio is answering and authorized. Kept for callers that only
   *  need a yes/no; `probe()` carries the reason. */
  async reachable(): Promise<boolean> {
    return (await this.probe()) === "ready";
  }

  /**
   * Start a training run. Studio permits only one at a time and answers a
   * second request with `status: "error"` rather than a non-2xx, so that case
   * is detected here and raised as a distinct, catchable error.
   */
  async startTraining(body: TrainingStart): Promise<void> {
    const result = await this.json<{ status?: string; message?: string }>(
      "/api/train/start",
      { method: "POST", body: JSON.stringify(body) },
    );
    if (result.status === "error") {
      throw new TrainingBusyError(result.message ?? "studio refused to start");
    }
  }

  async stopTraining(): Promise<void> {
    await this.json("/api/train/stop", { method: "POST" });
  }

  async listRuns(): Promise<StudioRun[]> {
    const body = await this.json<{ runs?: StudioRun[] } | StudioRun[]>(
      "/api/train/runs",
    );
    return Array.isArray(body) ? body : (body.runs ?? []);
  }

  /** Stream training progress. Yields decoded frames until the stream ends. */
  async *trainingProgress(
    signal?: AbortSignal,
  ): AsyncGenerator<StudioProgress> {
    const res = await fetch(`${this.baseURL}/api/train/progress`, {
      headers: this.headers,
      signal,
    });
    if (!res.ok) throw new Error(`studio progress responded ${res.status}`);
    if (!res.body) return;
    // "skip": one malformed frame must not kill a run that may have hours left.
    yield* readSseFrames<Record<string, unknown>>(res.body, {
      onParseError: "skip",
    });
  }

  async loadCheckpoint(checkpointPath: string): Promise<void> {
    await this.json("/api/export/load-checkpoint", {
      method: "POST",
      body: JSON.stringify({ checkpoint_path: checkpointPath }),
    });
  }

  /** Note the doubled segment: the export router mounts at `/api/export` and
   *  declares this route as `/export/gguf`, so the real path is
   *  `/api/export/export/gguf`. `/api/export/gguf` answers 405. Verified live —
   *  the plan's shorthand for this endpoint was wrong. */
  async exportGguf(saveDirectory: string, quantization: string): Promise<void> {
    await this.json("/api/export/export/gguf", {
      method: "POST",
      body: JSON.stringify({
        save_directory: saveDirectory,
        quantization_method: quantization,
      }),
    });
  }

  async exportStatus(): Promise<ExportStatus> {
    return this.json("/api/export/status");
  }
}

/** Studio allows one training run at a time; a second start is a 409, not a
 *  crash. Typed so the route can say so plainly. */
export class TrainingBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainingBusyError";
  }
}
