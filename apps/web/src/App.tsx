import "./app.css";
import { useTasks } from "./useTasks";
import { AddTaskForm } from "./components/AddTaskForm";
import { TaskItem } from "./components/TaskItem";

export function App() {
  const { tasks, loading, error, createTask, updateTask, deleteTask } =
    useTasks();

  const remaining = tasks.filter((t) => t.status !== "done").length;

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">Ghost</h1>
        <p className="app__subtitle">
          {remaining} task{remaining === 1 ? "" : "s"} remaining
        </p>
      </header>

      <AddTaskForm onAdd={createTask} />

      {error && <p className="notice notice--error">Error: {error}</p>}

      {loading ? (
        <p className="notice">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="notice">No tasks yet — add one above.</p>
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
    </main>
  );
}
