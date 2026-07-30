import { createContext, type ReactNode, useContext } from "react";
import { AddTaskForm } from "./AddTaskForm";
import { TaskItem } from "./TaskItem";
import { useTasks } from "./useTasks";

// Tasks in the split shape (workspace/types.ts → SplitViewModule): one state
// owner, plus a dock summary and the full expanded view. This is the reference
// pattern for splitting the other modules.
//
// useTasks itself is unchanged — it only moved up a level. Both views now read
// one list and one set of mutations, so the dock card stays live while the
// module is expanded, and a task completed in either place is immediately true
// in the other.
//
// What goes where: the Provider owns anything whose loss would be a bug (the
// list, the loading/error state, the mutations). A view owns only what is
// meaningless outside it — a hover, an open disclosure. Note that the add-task
// draft currently lives inside AddTaskForm, which is fine while only the
// expanded view renders it; it would have to move up here if the compact view
// ever grew its own quick-add.

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

/** How many tasks are outstanding and what's next. Read-only: every action
 *  belongs to the expanded view, so the card stays glanceable at dock size. */
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

/** The full list: add, complete, re-prioritise, delete. */
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
