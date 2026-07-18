import type {
  CreateTaskInput,
  TaskRow,
  UpdateTaskInput,
} from "@penumbra/shared";
import { useCallback, useEffect, useState } from "react";
import { getDb } from "../../db/client";
import { requestSync, SYNC_EVENT } from "../../sync/SyncClient";

// The single place the UI touches the repository. Holds the task list in React
// state and re-reads it after every mutation, so the screen always reflects
// what's actually stored. The local DB is instant, so plain "mutate then
// refetch" is enough — no optimistic-update machinery needed.
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
    // A pull that changed local data fires this — re-read so remote edits from
    // another device show up live.
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
