import type {
  BenchmarkResult,
  FinetuneRequest,
  LabJob,
  LabRun,
  SuiteDefinition,
} from "@penumbra/shared";
import { normalizeBaseUrl } from "@penumbra/shared";
import { useCallback, useEffect, useState } from "react";

// Drives the Model Lab module. Everything goes through the Penumbra server's
// /lab/* routes — never to Studio directly, because the Studio key is an
// unscoped admin credential that must not reach a browser
// (docs/model_lab_plan.md → Deployment topology).

const SERVER_URL = normalizeBaseUrl(
  import.meta.env.VITE_SERVER_URL ?? "http://localhost:3000",
);
const TOKEN = import.meta.env.VITE_AGENT_TOKEN;

/** Studio readiness. "unauthorized" means it is up but the server's key is
 *  missing or wrong — a different fix from "stopped" (not running). */
export type StudioState = "ready" | "unauthorized" | "stopped";

export interface LabStatus {
  studio: StudioState;
  lmEval: "installed" | "missing";
  suites: SuiteDefinition[];
  /** The optional Colab fallback trainer. `baseURL` is echoed to confirm the
   *  target; the bearer never comes back from the server. */
  colab: {
    configured: boolean;
    baseURL: string | null;
    studio: StudioState;
  };
}

const headers = (): Record<string, string> => ({
  "Content-Type": "application/json",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
});

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...init,
    headers: headers(),
  });
  if (!res.ok) {
    // The server's error codes are meaningful (busy, no_checkpoint,
    // lm_eval_missing); surface them rather than a bare status.
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `server responded ${res.status}`);
  }
  return (await res.json()) as T;
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
    exportRun: (runId: string) => act("/lab/export", { runId }),
    benchmark: (model: string, suite: string, samplesPerTask: number) =>
      act("/lab/benchmark", { model, suite, samplesPerTask }),
    // The key is sent once and is not held anywhere on the client afterwards;
    // omit an empty one so a trusted-LAN tunnel can run without a bearer.
    setColab: (baseURL: string, apiKey: string) =>
      act("/lab/provider/colab", {
        baseURL,
        ...(apiKey ? { apiKey } : {}),
      }),
    clearColab: async () => {
      try {
        await api("/lab/provider/colab", { method: "DELETE" });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
