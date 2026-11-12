import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import {
  type AvailableModel,
  type ModelCatalogEntry,
  normalizeBaseUrl,
  pickLoadedModel,
  readSseFrames,
  type SseFrame,
} from "@penumbra/shared";

// Typed client for Studio's training, dataset, and export APIs. The key is an
// unscoped admin key and stays server-side.

export const DEFAULT_STUDIO_URL = "http://127.0.0.1:8888";

export interface StudioConfig {
  baseURL?: string;
  apiKey?: string;
  env?: Record<string, string | undefined>;
}

export interface StudioRun {
  id?: string;
  run_id?: string;
  output_dir?: string;
  /**
   * "running" | "completed" | "stopped" | "error". The only place a crash shows:
   * the progress stream ends the same either way.
   */
  status?: string;
  error_message?: string | null;
}

/** `load_id` is what to hand back to load or train, not always the display id. */
export interface StudioLocalModel {
  id?: string;
  load_id?: string;
  display_name?: string;
  size_bytes?: number;
  model_format?: string;
  capabilities?: { can_chat?: boolean; requires_variant?: boolean };
}

/**
 * Filtered out: Studio's inventory lists Ollama models, but its load route
 * never resolves these refs (`materialize_ollama_model_ref` is never called),
 * so loading one fails. Drop this if a later Studio wires it up.
 */
const OLLAMA_REF_PREFIX = "ollama-manifest:";

export interface GgufVariant {
  quant?: string;
  filename?: string;
  size_bytes?: number;
  downloaded?: boolean;
}

/** Shared by the benchmark form and the compute panel so they agree. */
export function toAvailableModels(
  models: StudioLocalModel[],
  served: string | null,
): AvailableModel[] {
  const mapped = models.map((m) => {
    const id = m.load_id ?? m.id ?? "";
    return {
      id,
      label: m.display_name ?? id,
      format: m.model_format ?? "unknown",
      sizeBytes: m.size_bytes ?? 0,
      requiresVariant: m.capabilities?.requires_variant ?? false,
      // Compared on the served id, which /v1/models reports and scores record.
      loaded: !!served && (id === served || m.id === served),
    };
  });

  // Colab often serves a model its disk inventory doesn't list, and it's the only
  // one a benchmark can measure, so add it.
  if (served && !mapped.some((m) => m.loaded)) {
    mapped.push({
      id: served,
      label: served,
      // From /v1/models, which says nothing about the file format.
      format: "unknown",
      sizeBytes: 0,
      requiresVariant: false,
      loaded: true,
    });
  }
  return mapped;
}

/**
 * Either call may fail without blanking the picker, but failures are reported
 * in `inventoryError`: an empty shelf and a failed call need different fixes,
 * and "couldn't ask what's loaded" must not read as "nothing is loaded".
 */
export async function readInventory(client: StudioClient): Promise<{
  models: AvailableModel[];
  inventoryError: string | null;
}> {
  const attempt = async <T>(
    work: Promise<T>,
    fallback: T,
  ): Promise<[T, string | null]> =>
    work.then(
      (value) => [value, null] as [T, string | null],
      (err: unknown) => [
        fallback,
        err instanceof Error ? err.message : String(err),
      ],
    );

  const [[models, listError], [served, servedError]] = await Promise.all([
    attempt<StudioLocalModel[]>(client.listLocalModels(), []),
    attempt<string | null>(client.loadedModel(), null),
  ]);

  return {
    models: toAvailableModels(models, served),
    // The resident-model error wins: it decides whether a benchmark can run.
    inventoryError: servedError ?? listError,
  };
}

/** The token is passed through, never stored or logged. */
export interface HubTarget {
  repoId: string;
  hfToken?: string;
  private?: boolean;
}

export interface TrainingStart {
  model_name: string;
  training_type: string;
  /** "auto" | alpaca | chatml | mistral | raw | custom | generic. */
  format_type: string;
  local_datasets?: string[];
  hf_dataset?: string;
  learning_rate: number;
  max_steps: number;
  lora_r: number;
  load_in_4bit: boolean;
}

/**
 * No `status` field: an export reports whether one is active plus the last
 * op's outcome.
 */
export interface ExportStatus {
  is_export_active?: boolean;
  /** Compare against a pre-export baseline. */
  last_op_seq?: number;
  last_op_status?: string | null;
  last_op_output_path?: string | null;
  last_op_error?: string | null;
}

export type StudioProgress = SseFrame<Record<string, unknown>>;

/**
 * `unauthorized`: up, bad key (a different fix from stopped). `not_studio`: a
 * 200 that isn't Studio's API (sign-in page, proxy, web UI); later calls would
 * fail on HTML and look like "no model loaded".
 */
export type StudioReachability =
  | "ready"
  | "unauthorized"
  | "not_studio"
  | "stopped";

/** A Colab tunnel may take seconds to answer. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Not a latency budget: /api/hub/local scans several caches. Without a bound,
 * a Studio that went quiet froze an agent turn. Long operations use
 * SLOW_CALL_TIMEOUT_MS.
 */
const REQUEST_TIMEOUT_MS = 60_000;

const SLOW_CALL_TIMEOUT_MS = 15 * 60_000;

/**
 * The served model comes from the same `/v1/models` read as readiness, so the
 * panel's poll picks up loads made elsewhere.
 */
export interface StudioProbe {
  state: StudioReachability;
  served: string | null;
}

export class StudioClient {
  readonly baseURL: string;
  private readonly headers: Record<string, string>;

  constructor(config: StudioConfig = {}) {
    const env = config.env ?? process.env;
    const key = config.apiKey ?? env.UNSLOTH_API_KEY;
    this.baseURL = normalizeBaseUrl(
      config.baseURL ?? env.UNSLOTH_BASE_URL ?? DEFAULT_STUDIO_URL,
    );
    // Studio rejects an empty bearer as malformed.
    this.headers = key ? { Authorization: `Bearer ${key}` } : {};
  }

  private async json<T>(
    path: string,
    init: RequestInit = {},
    signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ): Promise<T> {
    // A multipart body sets its own content type with the boundary.
    const multipart = init.body instanceof FormData;
    let res: Response;
    try {
      res = await fetch(`${this.baseURL}${path}`, {
        ...init,
        headers: {
          ...(multipart ? {} : { "Content-Type": "application/json" }),
          ...this.headers,
          ...init.headers,
        },
        signal,
      });
    } catch (err) {
      // The message is what the user sees inside an agent turn.
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`studio ${path} did not respond in time`);
      }
      throw err;
    }
    if (!res.ok) {
      // Studio's 422 body names the offending field.
      const detail = await res.text().catch(() => "");
      throw new StudioHttpError(
        res.status,
        `studio ${path} responded ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    return (await res.json()) as T;
  }

  async probe(): Promise<StudioProbe> {
    const nothing = (state: StudioReachability): StudioProbe => ({
      state,
      served: null,
    });
    try {
      const res = await fetch(`${this.baseURL}/v1/models`, {
        headers: this.headers,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        return nothing("unauthorized");
      }
      if (!res.ok) return nothing("stopped");

      // A 200 isn't proof of Studio: proxies, tunnels, Colab's sign-in redirect, or
      // Studio's web UI all answer 200 with HTML. A real listing has an array
      // `data`; Studio 404s unknown /v1 paths rather than serving its SPA.
      const body = (await res.json().catch(() => null)) as {
        data?: ModelCatalogEntry[];
      } | null;
      if (!Array.isArray(body?.data)) return nothing("not_studio");
      // pickLoadedModel: on-disk entries must not be reported as served.
      return { state: "ready", served: pickLoadedModel(body.data) ?? null };
    } catch {
      return nothing("stopped");
    }
  }

  async reachable(): Promise<boolean> {
    return (await this.probe()).state === "ready";
  }

  /**
   * Studio serves whatever is loaded and ignores the request's `model`, so this
   * is what a run actually measures. Uses pickLoadedModel.
   */
  async loadedModel(): Promise<string | null> {
    const body = await this.json<{ data?: ModelCatalogEntry[] }>("/v1/models");
    return pickLoadedModel(body.data ?? []) ?? null;
  }

  /**
   * Everything Studio can serve (its models dir, HF cache, LM Studio, Ollama),
   * unlike `/v1/models`, which is what's resident. Chat-capable rows only.
   */
  async listLocalModels(): Promise<StudioLocalModel[]> {
    const body = await this.json<{ models?: StudioLocalModel[] }>(
      "/api/hub/local",
    );
    return (body.models ?? []).filter(
      (m) =>
        m.capabilities?.can_chat !== false &&
        !(m.load_id ?? m.id ?? "").startsWith(OLLAMA_REF_PREFIX),
    );
  }

  /** Prefers the local cache over the HuggingFace API. */
  async ggufVariants(
    repoId: string,
  ): Promise<{ variants: GgufVariant[]; defaultVariant?: string }> {
    const q = new URLSearchParams({
      repo_id: repoId,
      prefer_local_cache: "true",
      offline: "true",
    });
    const body = await this.json<{
      variants?: GgufVariant[];
      default_variant?: string;
    }>(`/api/hub/gguf-variants?${q}`);
    return {
      variants: body.variants ?? [],
      defaultVariant: body.default_variant,
    };
  }

  /**
   * Evicts whatever was loaded. Resolves a GGUF quant if none is named, since
   * Studio won't guess. Weights page in before it answers, hence the long
   * timeout.
   */
  async loadModel(modelPath: string, variant?: string): Promise<void> {
    await this.json(
      "/api/inference/load",
      {
        method: "POST",
        body: JSON.stringify({
          model_path: modelPath,
          ...(variant ? { gguf_variant: variant } : {}),
        }),
      },
      AbortSignal.timeout(15 * 60_000),
    );
  }

  /**
   * A transformers load shows in `/api/inference/status`, a GGUF load only in
   * `/api/inference/load-progress`. Never throws.
   */
  async loadInFlight(): Promise<boolean> {
    const probe = <T>(path: string): Promise<T | null> =>
      this.json<T>(path, {}, AbortSignal.timeout(10_000)).catch(() => null);

    const [status, progress] = await Promise.all([
      probe<{ loading?: string[] }>("/api/inference/status"),
      probe<{ phase?: string | null }>("/api/inference/load-progress"),
    ]);
    const phase = progress?.phase ?? null;
    return (status?.loading?.length ?? 0) > 0 || (!!phase && phase !== "ready");
  }

  /**
   * Studio answers a second concurrent run with `status: "error"`, not a
   * non-2xx.
   */
  async startTraining(body: TrainingStart): Promise<void> {
    // Studio loads the base model before answering.
    const result = await this.json<{ status?: string; message?: string }>(
      "/api/train/start",
      { method: "POST", body: JSON.stringify(body) },
      AbortSignal.timeout(SLOW_CALL_TIMEOUT_MS),
    );
    if (result.status === "error") {
      throw new TrainingBusyError(result.message ?? "studio refused to start");
    }
  }

  /**
   * Studio only trains from paths under its own dataset roots, and our upload
   * root is elsewhere, so datasets go through Studio's upload. Streamed from
   * disk.
   */
  async uploadDataset(localPath: string): Promise<string> {
    const form = new FormData();
    form.append("file", await openAsBlob(localPath), basename(localPath));
    const res = await this.json<{ stored_path?: string; filename?: string }>(
      "/api/datasets/upload",
      { method: "POST", body: form },
      AbortSignal.timeout(SLOW_CALL_TIMEOUT_MS),
    );
    if (!res.stored_path) {
      throw new Error("studio accepted the dataset but returned no path");
    }
    return res.stored_path;
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

  async *trainingProgress(
    signal?: AbortSignal,
  ): AsyncGenerator<StudioProgress> {
    const res = await fetch(`${this.baseURL}/api/train/progress`, {
      headers: this.headers,
      signal,
    });
    if (!res.ok) throw new Error(`studio progress responded ${res.status}`);
    if (!res.body) return;
    yield* readSseFrames<Record<string, unknown>>(res.body, {
      onParseError: "skip",
    });
  }

  async loadCheckpoint(checkpointPath: string): Promise<void> {
    await this.json(
      "/api/export/load-checkpoint",
      {
        method: "POST",
        body: JSON.stringify({ checkpoint_path: checkpointPath }),
      },
      AbortSignal.timeout(SLOW_CALL_TIMEOUT_MS),
    );
  }

  /**
   * The doubled segment is real: the router mounts at `/api/export` and
   * declares `/export/gguf`. `/api/export/gguf` answers 405. With `hub`, Studio
   * also pushes to the Hub, the only way an artifact leaves an ephemeral
   * trainer.
   */
  async exportGguf(
    saveDirectory: string,
    quantization: string,
    hub?: HubTarget,
  ): Promise<void> {
    await this.json(
      "/api/export/export/gguf",
      {
        method: "POST",
        body: JSON.stringify({
          save_directory: saveDirectory,
          quantization_method: quantization,
          // Studio ignores repo_id/hf_token without push_to_hub.
          ...(hub
            ? {
                push_to_hub: true,
                repo_id: hub.repoId,
                ...(hub.hfToken ? { hf_token: hub.hfToken } : {}),
                ...(hub.private === undefined ? {} : { private: hub.private }),
              }
            : {}),
        }),
      },
      // Usually outlives its request; the caller's polling settles it.
      AbortSignal.timeout(SLOW_CALL_TIMEOUT_MS),
    );
  }

  async exportStatus(): Promise<ExportStatus> {
    return this.json("/api/export/status");
  }
}

/**
 * The status distinguishes Studio refusing from a hop in between giving up;
 * only the latter may still be running.
 */
export class StudioHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StudioHttpError";
  }
}

export class TrainingBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainingBusyError";
  }
}
