import type {
  AvailableModel,
  ComputeRole,
  ComputeState,
  TargetId,
} from "@penumbra/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

// Shared by the chat pill and the Lab. Keys never come back from the server.

const POLL_MS = 5000;

export interface TargetInventory {
  models: AvailableModel[];
  inventoryError: string | null;
}

export interface Compute {
  state: ComputeState | null;
  error: string | null;
  refresh: () => Promise<void>;
  setTarget: (
    id: TargetId,
    patch: { baseURL?: string; apiKey?: string },
  ) => Promise<void>;
  clearTarget: (id: TargetId) => Promise<void>;
  assign: (role: ComputeRole, target: TargetId) => Promise<void>;
  inventory: Partial<Record<TargetId, TargetInventory>>;
  /** On card open, not on the poll: it scans the target's disk. */
  loadInventory: (id: TargetId) => Promise<void>;
  /** Evicts whatever was loaded. */
  loadModel: (id: TargetId, model: string) => Promise<void>;
  loading: TargetId | null;
  /** Loopback only. */
  launch: (id: TargetId) => Promise<void>;
  /** Held through the ~45s cold start, cleared when the poll says ready. */
  launching: TargetId | null;
  stop: (id: TargetId) => Promise<void>;
  stopping: TargetId | null;
}

/** @param enabled Poll only while needed: each poll probes every target. */
export function useCompute(enabled = true): Compute {
  const [state, setState] = useState<ComputeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inventory, setInventory] = useState<
    Partial<Record<TargetId, TargetInventory>>
  >({});
  const [loading, setLoading] = useState<TargetId | null>(null);
  const [launching, setLaunching] = useState<TargetId | null>(null);
  const [stopping, setStopping] = useState<TargetId | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api<ComputeState>("/compute/targets"));
      setError(null);
    } catch (err) {
      // Keep the last state so a dropped poll doesn't blank the panel.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const id = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh, enabled]);

  const act = useCallback(
    async (path: string, init: RequestInit) => {
      try {
        await api(path, init);
        setError(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const loadInventory = useCallback(async (id: TargetId) => {
    try {
      const body = await api<TargetInventory>(`/compute/targets/${id}/models`);
      setInventory((prev) => ({ ...prev, [id]: body }));
    } catch (err) {
      // Keep the error: a "ready" target whose inventory call fails needs it.
      setInventory((prev) => ({
        ...prev,
        [id]: {
          models: [],
          inventoryError: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }, []);

  const loadModel = useCallback(
    async (id: TargetId, model: string) => {
      setLoading(id);
      try {
        await api(`/compute/targets/${id}/load`, {
          method: "POST",
          body: JSON.stringify({ model }),
        });
        setError(null);
        // The pill's model and the list's "loaded" marker must refresh together.
        await Promise.all([refresh(), loadInventory(id)]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(null);
      }
    },
    [refresh, loadInventory],
  );

  const launch = useCallback(
    async (id: TargetId) => {
      setLaunching(id);
      // Recover if the poll never reports ready (unsloth missing, crash).
      window.setTimeout(() => {
        setLaunching((cur) => (cur === id ? null : cur));
      }, 120_000);
      try {
        await api(`/compute/targets/${id}/launch`, { method: "POST" });
        setError(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLaunching((cur) => (cur === id ? null : cur));
      }
    },
    [refresh],
  );

  // Any state but "stopped" means the process is up.
  useEffect(() => {
    if (!launching) return;
    const s = state?.targets.find((t) => t.id === launching)?.state;
    if (s && s !== "stopped") setLaunching(null);
  }, [launching, state]);

  const stop = useCallback(
    async (id: TargetId) => {
      setStopping(id);
      // Cap in case the stop command never lands.
      window.setTimeout(() => {
        setStopping((cur) => (cur === id ? null : cur));
      }, 30_000);
      try {
        await api(`/compute/targets/${id}/stop`, { method: "POST" });
        setError(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStopping((cur) => (cur === id ? null : cur));
      }
    },
    [refresh],
  );

  useEffect(() => {
    if (!stopping) return;
    const s = state?.targets.find((t) => t.id === stopping)?.state;
    if (s === "stopped") setStopping(null);
  }, [stopping, state]);

  return {
    state,
    error,
    refresh,
    inventory,
    loadInventory,
    loadModel,
    loading,
    launch,
    launching,
    stop,
    stopping,
    // An omitted field keeps its value; an empty apiKey means "no bearer".
    setTarget: (id, patch) =>
      act(`/compute/targets/${id}`, {
        method: "POST",
        body: JSON.stringify(patch),
      }),
    clearTarget: (id) => act(`/compute/targets/${id}`, { method: "DELETE" }),
    assign: (role, target) =>
      act("/compute/assign", {
        method: "POST",
        body: JSON.stringify({ role, target }),
      }),
  };
}
