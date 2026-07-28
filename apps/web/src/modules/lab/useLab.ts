import type {
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

export function useLab() {
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [jobs, setJobs] = useState<LabJob[]>([]);
  const [runs, setRuns] = useState<LabRun[]>([]);
  const [scores, setScores] = useState<BenchmarkResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, j, r, sc] = await Promise.all([
        api<LabStatus>("/lab/status"),
        api<LabJob[]>("/lab/jobs"),
        api<LabRun[]>("/lab/runs"),
        api<BenchmarkResult[]>("/lab/scores"),
      ]);
      setStatus(s);
      setJobs(j);
      setRuns(r);
      setScores(sc);
      setError(null);
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
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
    error,
    running: jobs.some((j) => j.state === "running"),
    finetune: (req: FinetuneRequest) => act("/lab/finetune", req),
    // The Hub fields are optional and, when given, are the only way the artifact
    // survives the trainer that made it. The token is sent for this one call and
    // kept nowhere — not in this hook, not in the job record.
    exportRun: (req: ExportRequestInput) => act("/lab/export", req),
    benchmark: (model: string, suite: string, samplesPerTask: number) =>
      act("/lab/benchmark", { model, suite, samplesPerTask }),
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
