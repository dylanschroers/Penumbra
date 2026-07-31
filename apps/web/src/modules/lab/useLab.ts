import type {
  AvailableModel,
  BenchmarkResult,
  FinetuneRequest,
  LabJob,
  LabRun,
  SuiteDefinition,
} from "@penumbra/shared";
import { useCallback, useEffect, useState } from "react";
import { api, SERVER_URL, TOKEN } from "../../api";
import { type UploadProgress, uploadDataset, uploadModel } from "./upload";

// Drives the Model Lab module. Everything goes through the Penumbra server's
// /lab/* routes — never to Studio directly, because the Studio key is an
// unscoped admin credential that must not reach a browser
// (docs/MODEL_LAB.md → Deployment topology).
//
// Which Studio the Lab trains and benchmarks on is *not* here: that is a compute
// target, shared with chat, and lives in ../../compute/useCompute.

/** What the export form collects. Everything past `runId` is the optional
 *  "publish it somewhere permanent" half. */
export interface ExportRequestInput {
  runId: string;
  quantization?: string;
  repoId?: string;
  private?: boolean;
  hfToken?: string;
}

export interface LabStatus {
  lmEval: "installed" | "missing";
  suites: SuiteDefinition[];
}

/** What the benchmark target can serve, and which of it is resident. The
 *  resident model is always listed, inventory or no inventory: it is the only
 *  one a benchmark can actually score. */
export interface AvailableModels {
  target: string;
  models: AvailableModel[];
  /** Why the list holds no more than that, when the target's own inventory
   *  refused to answer. Null when it answered. */
  inventoryError: string | null;
}

export function useLab() {
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [jobs, setJobs] = useState<LabJob[]>([]);
  const [runs, setRuns] = useState<LabRun[]>([]);
  const [scores, setScores] = useState<BenchmarkResult[]>([]);
  const [available, setAvailable] = useState<AvailableModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Whether the server answered the last poll. Null until the first one
   *  returns — kept apart from `false` so the UI can hold off on saying
   *  "disconnected" during the round trip it takes to find out, rather than
   *  flashing it on every mount. */
  const [connected, setConnected] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, j, r, sc, av] = await Promise.all([
        api<LabStatus>("/lab/status"),
        api<LabJob[]>("/lab/jobs"),
        api<LabRun[]>("/lab/runs"),
        api<BenchmarkResult[]>("/lab/scores"),
        // Reaches the target's inventory, so it is the one call here that can
        // be slow. A failure leaves the picker empty rather than blanking the
        // whole Lab, which the other four would do.
        api<AvailableModels>("/lab/models").catch(() => null),
      ]);
      setStatus(s);
      setJobs(j);
      setRuns(r);
      setScores(sc);
      setAvailable(av);
      setError(null);
      setConnected(true);
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
      setConnected(false);
    }
  }, []);

  // Poll rather than hold an SSE stream open: jobs are long-lived and the job
  // record is authoritative, so a periodic read shows the same truth with far
  // less to go wrong. Skip while hidden; the next visible tick catches up.
  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const act = useCallback(
    async (path: string, body: unknown) => {
      try {
        await api(path, { method: "POST", body: JSON.stringify(body) });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  return {
    status,
    jobs,
    runs,
    scores,
    available,
    error,
    connected,
    running: jobs.some((j) => j.state === "running"),
    finetune: (req: FinetuneRequest) => act("/lab/finetune", req),
    // The Hub fields are optional and, when given, are the only way the artifact
    // survives the trainer that made it. The token is sent for this one call and
    // kept nowhere — not in this hook, not in the job record.
    exportRun: (req: ExportRequestInput) => act("/lab/export", req),
    benchmark: (model: string, suite: string, samplesPerTask: number) =>
      act("/lab/benchmark", { model, suite, samplesPerTask }),
    // Stops a running benchmark. No scores are written for a partial run, so
    // cancelling costs the run and nothing else.
    cancelJob: (id: string) => act(`/lab/jobs/${id}/cancel`, {}),
    // Transfer a client-local file to the Studio host and return the path there
    // to train from. Desktop only (needs disk access).
    uploadDataset: (localPath: string, onProgress?: UploadProgress) =>
      uploadDataset(
        { serverURL: SERVER_URL, token: TOKEN },
        localPath,
        onProgress,
      ),
    uploadModel: (localDir: string, onProgress?: UploadProgress) =>
      uploadModel(
        { serverURL: SERVER_URL, token: TOKEN },
        localDir,
        onProgress,
      ),
  };
}
