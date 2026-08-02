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

// Typed client for Unsloth Studio's training, dataset, and export APIs.
//
// Credentials come from the same environment variables UnslothEngine uses, so
// inference and training can never end up pointed at different Studios. The key
// is *unscoped admin* — it can start jobs and write files — which is why it
// lives on the server and no client ever sees it
// (docs/MODEL_LAB.md → Deployment topology).

/** Studio's default address. Exported so the credential store resolves the same
 *  fallback this client would. */
export const DEFAULT_STUDIO_URL = "http://127.0.0.1:8888";

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
  /** "running" | "completed" | "stopped" | "error". The run record is the only
   *  place a crash is reported — the progress stream ends the same way either
   *  way (see `startTraining`'s caller). */
  status?: string;
  error_message?: string | null;
}

/** One row of Studio's local inventory. Only the fields we consume are typed;
 *  `load_id` is the identifier to hand back to load or train, which is not
 *  always the display id. */
export interface StudioLocalModel {
  id?: string;
  load_id?: string;
  display_name?: string;
  size_bytes?: number;
  model_format?: string;
  capabilities?: { can_chat?: boolean; requires_variant?: boolean };
}

/**
 * Studio's id scheme for a model discovered in an Ollama store.
 *
 * These are filtered out of the listings, because Studio cannot load one. Its
 * inventory hands out these opaque references, and its own load route never
 * decodes them: `materialize_ollama_model_ref` in
 * hub/services/models/ollama.py exists for exactly this and, per that module's
 * own docstrings, is what "the load route later calls" — but nothing anywhere
 * calls it, and routes/inference.py does not mention ollama at all. Sent one,
 * Studio treats the whole string as a path, fails to read config.json, selects
 * the transformers runtime for what its own listing calls a GGUF, and dies in
 * AutoConfig. Offering a model that cannot load is worse than not offering it.
 *
 * Drop this filter if a later Studio wires the resolver up.
 */
const OLLAMA_REF_PREFIX = "ollama-manifest:";

/** One quantization of a GGUF repo. `downloaded` is the difference between
 *  loading in seconds and pulling gigabytes first. */
export interface GgufVariant {
  quant?: string;
  filename?: string;
  size_bytes?: number;
  downloaded?: boolean;
}

/**
 * Map Studio's inventory to the wire shape the pickers use.
 *
 * Shared by the two routes that offer models — the benchmark form's, resolved
 * by role, and the compute panel's, resolved by target — so the two cannot
 * disagree about what a model is called or which one is resident.
 */
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
      // Compared on the served id, which is what /v1/models reports and what a
      // score is recorded against.
      loaded: !!served && (id === served || m.id === served),
    };
  });

  // A target can serve a model its inventory never mentions, and Colab is where
  // that is normal rather than exotic: /api/hub/local scans disk (models dir, HF
  // cache, LM Studio, Ollama) while /v1/models reports the resident backend's
  // own identifier, so a model loaded from a checkpoint dir, under an id the
  // scan spells differently, or through an inventory call that failed outright,
  // is listed nowhere. Without this the served model — the only one a benchmark
  // can actually measure — is the one option the picker does not offer, and the
  // form then disables itself against a Studio with a model sitting loaded on
  // the GPU.
  if (served && !mapped.some((m) => m.loaded)) {
    mapped.push({
      id: served,
      label: served,
      // Unknown rather than guessed: this row comes from /v1/models, which says
      // what is answering and nothing about the file behind it.
      format: "unknown",
      sizeBytes: 0,
      requiresVariant: false,
      loaded: true,
    });
  }
  return mapped;
}

/**
 * What a target can serve and what it is serving, as the pickers need it.
 *
 * Shared by the two routes that offer models — the benchmark form's, resolved by
 * role, and the compute panel's, resolved by target — so neither can disagree
 * with the other about a model's name or which one is resident.
 *
 * Either call is allowed to fail: a picker that lost its list is recoverable, an
 * error that blanks the panel is not. But a failure is *reported* rather than
 * swallowed, because "this target has nothing on it" and "the call asking it
 * failed" look identical as an empty list and need completely different fixes.
 * That is doubly true of the resident model: swallowing that one turns "we could
 * not ask what is loaded" into "nothing is loaded", which is a lie the benchmark
 * form then repeats.
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
    // The resident lookup first: it is the one whose failure is invisible in the
    // list, and the one that decides whether a benchmark can run at all.
    inventoryError: servedError ?? listError,
  };
}

/** Where to publish an export, so it outlives the machine that produced it.
 *  The token belongs to the user and is passed straight through — never stored,
 *  never logged. */
export interface HubTarget {
  repoId: string;
  hfToken?: string;
  private?: boolean;
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
 * - `ready` — answering, authorized, and answering as *Studio*.
 * - `unauthorized` — up, but the key is missing or wrong (a 401/403). This is a
 *   *different* fix from "not running", so it is not collapsed into `stopped`.
 * - `not_studio` — something answered 200 that is not Studio's API: a sign-in
 *   page, a proxy's own response, a web UI on the port. Kept apart from `ready`
 *   because it is the failure that lies — every later call fails on a body that
 *   is not JSON, and "no model is loaded" is what that looks like from the
 *   inside.
 * - `stopped` — unreachable, or answering with some other error.
 */
export type StudioReachability =
  | "ready"
  | "unauthorized"
  | "not_studio"
  | "stopped";

/** The readiness probe's budget. Generous next to a localhost round trip
 *  because the target may be a tunnel to another continent, and a Colab that
 *  takes two seconds to answer is up, not down. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * What one probe learned.
 *
 * The model rides along because it costs nothing: readiness is decided by
 * reading `/v1/models`, and that listing *is* the answer to "what is loaded".
 * Reporting them together is what lets a panel that polls for reachability show
 * a model appear the moment it is loaded on the other machine, rather than
 * needing a second, heavier call nobody thought to repeat.
 */
export interface StudioProbe {
  state: StudioReachability;
  /** What it is serving right now, or null when it is serving nothing or was
   *  in no state to be asked. */
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
    // Studio rejects an empty bearer as malformed, so omit the header entirely
    // when there is no key (a trusted-LAN instance may run without one).
    this.headers = key ? { Authorization: `Bearer ${key}` } : {};
  }

  private async json<T>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    // A multipart body carries its own content type with the boundary in it;
    // declaring JSON over the top makes Studio reject the upload as malformed.
    const multipart = init.body instanceof FormData;
    const res = await fetch(`${this.baseURL}${path}`, {
      ...init,
      headers: {
        ...(multipart ? {} : { "Content-Type": "application/json" }),
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
      throw new StudioHttpError(
        res.status,
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

      // A 200 is not proof this is Studio. The address is often a proxy or a
      // tunnel, and those answer for themselves: a Google sign-in page (Colab's
      // kernel proxy authenticates with the browser's session, so a server
      // reaching it is redirected), a tunnel's own interstitial, or the Studio
      // *web UI* on a port where the API is not. Every one of those is a 200
      // with an HTML body, and calling it ready is the failure that lies —
      // `loadedModel` then parses HTML, fails, and reports what looks exactly
      // like a Studio with nothing loaded.
      //
      // The listing's own contract is the test: `data` is an array, empty when
      // nothing is resident. Studio itself 404s an unknown /v1 path rather than
      // falling through to its SPA, so anything else here came from in front.
      const body = (await res.json().catch(() => null)) as {
        data?: ModelCatalogEntry[];
      } | null;
      if (!Array.isArray(body?.data)) return nothing("not_studio");
      // Read through the shared rule rather than by hand: an entry can be a
      // model sitting on disk, and reporting one as served would put a name in
      // the panel that no completion would ever come from.
      return { state: "ready", served: pickLoadedModel(body.data) ?? null };
    } catch {
      return nothing("stopped");
    }
  }

  /** True when Studio is answering and authorized. Kept for callers that only
   *  need a yes/no; `probe()` carries the reason and the model. */
  async reachable(): Promise<boolean> {
    return (await this.probe()).state === "ready";
  }

  /**
   * The model a completion would actually run against here, or null when
   * nothing is resident.
   *
   * Studio serves whatever it has loaded and ignores the `model` field of a
   * request — which is why UnslothEngine can send a placeholder and still get
   * an answer. The consequence for benchmarking is that the model *named* in a
   * run is not evidence of the model that produced the scores, so this is asked
   * and recorded instead.
   *
   * Reads the listing through the shared rule: an unloaded model on disk is
   * listed too, and reporting one would attribute a run to weights that never
   * served it.
   */
  async loadedModel(): Promise<string | null> {
    const body = await this.json<{ data?: ModelCatalogEntry[] }>("/v1/models");
    return pickLoadedModel(body.data ?? []) ?? null;
  }

  /**
   * Every model this Studio can serve: its own models dir, the HuggingFace
   * cache, LM Studio, and Ollama, all in one listing.
   *
   * A different question from `/v1/models`, which reports what is *resident*.
   * This is what could be, which is what a picker needs — and the two together
   * are what let one say which of the offered models is the one a run would
   * actually measure.
   *
   * Only chat-capable rows are returned: a benchmark drives a chat endpoint, so
   * a base model that cannot hold a conversation is not a candidate. Verified
   * against hub/routes/inventory.py → GET /api/hub/local.
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

  /**
   * The quantizations a GGUF repo offers, and which one Studio would pick.
   *
   * Answered from the local cache when possible: the alternative reaches the
   * HuggingFace API, and this runs on the way to a load that is about to read
   * those same files off disk anyway.
   */
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
   * Make a model resident, so completions run against it.
   *
   * One GPU holds one model, so this *evicts* whatever was loaded — including
   * the model a conversation has been talking to (docs/MODEL_LAB.md → Compute
   * targets). The caller is expected to know that; the transcript marker is what
   * tells the user.
   *
   * A GGUF repo holds several quantizations and Studio will not guess between
   * them, so one is resolved here when the caller did not name it. Weights page
   * in from disk before this answers, which for a large model is minutes, hence
   * the timeout far past the default.
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
   * Whether a load is still working inside Studio.
   *
   * Two endpoints because the two backends report differently: a transformers
   * load appears in `/api/inference/status`'s `loading` list, while a GGUF load
   * shows up only as a `/api/inference/load-progress` phase (status reports the
   * llama backend as not-loaded and the *other* backend's empty loading set).
   * Either one working is enough to say "still going".
   *
   * Never throws: this answers a question about a connection that has already
   * gone wrong once, and an unreachable Studio is simply not loading anything
   * we can see.
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

  /**
   * Hand a dataset file to Studio and return the path Studio stored it at.
   *
   * Studio will not train from an arbitrary absolute path: `resolve_dataset_path`
   * accepts one only if it sits under a Studio dataset root, and answers
   * anything else with "dataset path must be relative or under a dataset root".
   * Our upload root is deliberately elsewhere (a different drive, often a
   * different machine), so a local dataset has to go *through* Studio to become
   * a path Studio will open.
   *
   * Streamed from disk as a Blob rather than read whole — the file is already on
   * this host and there is no reason to hold it in memory too.
   */
  async uploadDataset(localPath: string): Promise<string> {
    const form = new FormData();
    form.append("file", await openAsBlob(localPath), basename(localPath));
    const res = await this.json<{ stored_path?: string; filename?: string }>(
      "/api/datasets/upload",
      { method: "POST", body: form },
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

  /**
   * Note the doubled segment: the export router mounts at `/api/export` and
   * declares this route as `/export/gguf`, so the real path is
   * `/api/export/export/gguf`. `/api/export/gguf` answers 405. Verified live —
   * the plan's shorthand for this endpoint was wrong.
   *
   * With `hub` set, Studio also pushes the result to the HuggingFace Hub. That
   * is the only exit for an artifact from a trainer whose disk is temporary:
   * nothing in Studio's API serves an export back for download.
   */
  async exportGguf(
    saveDirectory: string,
    quantization: string,
    hub?: HubTarget,
  ): Promise<void> {
    await this.json("/api/export/export/gguf", {
      method: "POST",
      body: JSON.stringify({
        save_directory: saveDirectory,
        quantization_method: quantization,
        // Studio ignores repo_id/hf_token unless push_to_hub is set, so the
        // flag and the target always travel together.
        ...(hub
          ? {
              push_to_hub: true,
              repo_id: hub.repoId,
              ...(hub.hfToken ? { hf_token: hub.hfToken } : {}),
              ...(hub.private === undefined ? {} : { private: hub.private }),
            }
          : {}),
      }),
    });
  }

  async exportStatus(): Promise<ExportStatus> {
    return this.json("/api/export/status");
  }
}

/**
 * A non-2xx from Studio, carrying the status alongside the message.
 *
 * The status is the difference between "Studio read the request and refused it"
 * and "something between here and Studio gave up" — a distinction the load path
 * acts on, because only the second may still be running on the other side.
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

/** Studio allows one training run at a time; a second start is a 409, not a
 *  crash. Typed so the route can say so plainly. */
export class TrainingBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainingBusyError";
  }
}
