import { normalizeBaseUrl } from "@penumbra/shared";

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
  local_datasets?: string[];
  hf_dataset?: string;
  learning_rate: number;
  max_steps: number;
  lora_r: number;
  load_in_4bit: boolean;
}

/** One decoded SSE frame from Studio's progress stream. */
export interface StudioProgress {
  event: string;
  data: Record<string, unknown>;
}

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
      throw new Error(`studio ${path} responded ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /** True when Studio answers at all — the lab's readiness signal. */
  async reachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseURL}/v1/models`, {
        headers: this.headers,
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
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
    yield* readSse(res.body);
  }

  async loadCheckpoint(checkpointPath: string): Promise<void> {
    await this.json("/api/export/load-checkpoint", {
      method: "POST",
      body: JSON.stringify({ checkpoint_path: checkpointPath }),
    });
  }

  async exportGguf(saveDirectory: string, quantization: string): Promise<void> {
    await this.json("/api/export/gguf", {
      method: "POST",
      body: JSON.stringify({
        save_directory: saveDirectory,
        quantization_method: quantization,
      }),
    });
  }

  async exportStatus(): Promise<{ status?: string; message?: string }> {
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

/** Decode an SSE byte stream into frames, carrying partial tails forward. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StudioProgress> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = /^event: (.*)$/m.exec(chunk)?.[1];
        const raw = /^data: (.*)$/m.exec(chunk)?.[1];
        if (event && raw) {
          try {
            yield { event, data: JSON.parse(raw) as Record<string, unknown> };
          } catch {
            // A malformed frame is not worth killing a long training run over.
          }
        }
        split = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
