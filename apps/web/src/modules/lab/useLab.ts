import type {
  AvailableModel,
  BenchmarkResult,
  FinetuneRequest,
  LabJob,
  LabRun,
  SuiteDefinition,
} from "@penumbra/shared";
import { useCallback, useEffect, useState } from "react";
import { api, getAgentToken, getServerUrl } from "../../api";
import { type UploadProgress, uploadDataset, uploadModel } from "./upload";

// Everything goes through /lab/*, never Studio. Target choice lives in
// ../../compute/useCompute.

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

/** The resident model is always listed: it's the only one a benchmark scores. */
export interface AvailableModels {
  target: string;
  models: AvailableModel[];
  /** Null when the inventory answered. */
  inventoryError: string | null;
}

export function useLab() {
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [jobs, setJobs] = useState<LabJob[]>([]);
  const [runs, setRuns] = useState<LabRun[]>([]);
  const [scores, setScores] = useState<BenchmarkResult[]>([]);
  const [available, setAvailable] = useState<AvailableModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Null until the first poll returns, so "disconnected" doesn't flash on mount. */
  const [connected, setConnected] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, j, r, sc, av] = await Promise.all([
        api<LabStatus>("/lab/status"),
        api<LabJob[]>("/lab/jobs"),
        api<LabRun[]>("/lab/runs"),
        api<BenchmarkResult[]>("/lab/scores"),
        // Can be slow; a failure empties the picker without blanking the Lab.
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

  // Polls rather than holding SSE: the job record is authoritative. Skips while
  // hidden.
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
    // The Hub token is sent for this call only and kept nowhere.
    exportRun: (req: ExportRequestInput) => act("/lab/export", req),
    benchmark: (model: string, suite: string, samplesPerTask: number) =>
      act("/lab/benchmark", { model, suite, samplesPerTask }),
    // Partial runs write no scores.
    cancelJob: (id: string) => act(`/lab/jobs/${id}/cancel`, {}),
    uploadDataset: (localPath: string, onProgress?: UploadProgress) =>
      uploadDataset(
        // Resolved per call: the address can change mid-session.
        { serverURL: getServerUrl(), token: getAgentToken() },
        localPath,
        onProgress,
      ),
    uploadModel: (localDir: string, onProgress?: UploadProgress) =>
      uploadModel(
        // Resolved per call: the address can change mid-session.
        { serverURL: getServerUrl(), token: getAgentToken() },
        localDir,
        onProgress,
      ),
  };
}
