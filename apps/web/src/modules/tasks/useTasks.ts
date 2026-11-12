import type {
  CreateTaskInput,
  TaskRow,
  UpdateTaskInput,
} from "@penumbra/shared";
import { useCallback, useEffect, useState } from "react";
import { getDb } from "../../db/client";
import { requestSync, SYNC_EVENT } from "../../sync/SyncClient";

// Mutate then refetch; the local DB is fast enough that optimistic updates
// aren't needed.
export function useTasks() {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setTasks(await getDb().listTasks());
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Fired when a pull changed local data.
    const onSynced = () => void refresh();
    window.addEventListener(SYNC_EVENT, onSynced);
    return () => window.removeEventListener(SYNC_EVENT, onSynced);
  }, [refresh]);

  const createTask = useCallback(
    async (input: CreateTaskInput) => {
      await getDb().createTask(input);
      await refresh();
      requestSync();
    },
    [refresh],
  );

  const updateTask = useCallback(
    async (id: string, patch: UpdateTaskInput) => {
      await getDb().updateTask(id, patch);
      await refresh();
      requestSync();
    },
    [refresh],
  );

  const deleteTask = useCallback(
    async (id: string) => {
      await getDb().deleteTask(id);
      await refresh();
      requestSync();
    },
    [refresh],
  );

  return { tasks, loading, error, createTask, updateTask, deleteTask };
}
