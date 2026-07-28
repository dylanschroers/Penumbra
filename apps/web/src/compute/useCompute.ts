import type { ComputeRole, ComputeState, TargetId } from "@penumbra/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

// Which Studios the server can reach, and which one each role uses.
//
// Shared by the chat pill and the Model Lab, because they are looking at one
// setting: the Studio a conversation runs against is the same one the Lab
// trains and benchmarks on.
//
// Keys never come back from the server — a target reports `hasKey` and nothing
// more — so there is no bearer held anywhere in this hook.

/** Slower than the Lab's job poll: this is configuration plus a reachability
 *  probe, and each probe costs a request to a possibly-unreachable host. */
const POLL_MS = 5000;

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
}

/**
 * @param enabled Poll only while the caller can act on the answer. Each poll
 * probes every configured target, so a chat running on the embedded Tier 0
 * model would otherwise keep asking a server about Studios it is not using.
 */
export function useCompute(enabled = true): Compute {
  const [state, setState] = useState<ComputeState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api<ComputeState>("/compute/targets"));
      setError(null);
    } catch (err) {
      // Keep the last known state: a dropped poll should not blank the panel
      // the user is typing into.
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

  return {
    state,
    error,
    refresh,
    // Send only what changed: an omitted field keeps its current value, while
    // an empty apiKey is an explicit "no bearer".
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
