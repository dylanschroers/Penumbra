import { createContext, type ReactNode, useContext } from "react";
import { AddTaskForm } from "./AddTaskForm";
import { TaskItem } from "./TaskItem";
import { useTasks } from "./useTasks";

// Split shape (workspace/types.ts → SplitViewModule): one Provider owns the
// state, with compact and expanded views over it. The Provider holds anything
// whose loss would be a bug; views hold only view-local state. The add-task
// draft lives in AddTaskForm, which is fine while only the expanded view
// renders it.

type TasksState = ReturnType<typeof useTasks>;

const TasksContext = createContext<TasksState | null>(null);

export function TasksProvider({ children }: { children: ReactNode }) {
  const state = useTasks();
  return (
    <TasksContext.Provider value={state}>{children}</TasksContext.Provider>
  );
}

function useTasksState(): TasksState {
  const state = useContext(TasksContext);
  if (!state) throw new Error("Tasks views must render inside TasksProvider");
  return state;
}

/** Read-only; actions live in the expanded view. */
export function TasksCompact() {
  const { tasks, loading, error } = useTasksState();

  if (error) return <p className="notice notice--error">Error: {error}</p>;
  if (loading) return <p className="notice">Loading…</p>;
  if (tasks.length === 0) return <p className="notice">No tasks yet.</p>;

  const open = tasks.filter((t) => t.status !== "done");
  const doing = open.filter((t) => t.status === "doing").length;
  const shown = open.slice(0, 4);

  return (
    <div className="tasks-compact">
      <div className="tasks-compact__counts">
        <span>{open.length} open</span>
        {doing > 0 && <span>{doing} doing</span>}
        <span className="tasks-compact__done">
          {tasks.length - open.length} done
        </span>
      </div>

      {shown.length > 0 && (
        <ul className="tasks-compact__list">
          {shown.map((task) => (
            <li key={task.id} className="tasks-compact__item">
              <span
                className={`tasks-compact__dot tasks-compact__dot--${task.priority}`}
              />
              <span className="tasks-compact__title">{task.title}</span>
            </li>
          ))}
        </ul>
      )}

      {open.length > shown.length && (
        <p className="tasks-compact__more">
          +{open.length - shown.length} more
        </p>
      )}
    </div>
  );
}

export function TasksExpanded() {
  const { tasks, loading, error, createTask, updateTask, deleteTask } =
    useTasksState();

  return (
    <div className="tasks-module">
      <AddTaskForm onAdd={createTask} />

      {error && <p className="notice notice--error">Error: {error}</p>}

      {loading ? (
        <p className="notice">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="notice">No tasks yet. Add one above.</p>
      ) : (
        <ul className="task-list">
          {tasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              onUpdate={updateTask}
              onDelete={deleteTask}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
