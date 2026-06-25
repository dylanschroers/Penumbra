import { useCallback, useEffect, useState } from "react";
import { db } from "./db/client";
import type { CreateTaskInput, TaskRow, UpdateTaskInput } from "@ghost/shared";

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
      setTasks(await db.listTasks());
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createTask = useCallback(
    async (input: CreateTaskInput) => {
      await db.createTask(input);
      await refresh();
    },
    [refresh],
  );

  const updateTask = useCallback(
    async (id: string, patch: UpdateTaskInput) => {
      await db.updateTask(id, patch);
      await refresh();
    },
    [refresh],
  );

  const deleteTask = useCallback(
    async (id: string) => {
      await db.deleteTask(id);
      await refresh();
    },
    [refresh],
  );

  return { tasks, loading, error, createTask, updateTask, deleteTask };
}
