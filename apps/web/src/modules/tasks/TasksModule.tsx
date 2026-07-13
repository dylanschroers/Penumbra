import { AddTaskForm } from "./AddTaskForm";
import { TaskItem } from "./TaskItem";
import { useTasks } from "./useTasks";

// The Tasks feature as a self-contained workspace module: it owns its own data
// (via useTasks) and renders only its inner content. The surrounding card chrome
// — title bar, sizing, dragging — belongs to the workspace ModuleFrame, not here.
export function TasksModule() {
  const { tasks, loading, error, createTask, updateTask, deleteTask } =
    useTasks();

  return (
    <div className="tasks-module">
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
    </div>
  );
}
