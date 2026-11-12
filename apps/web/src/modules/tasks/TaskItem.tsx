import type { TaskRow, UpdateTaskInput } from "@penumbra/shared";

export function TaskItem({
  task,
  onUpdate,
  onDelete,
}: {
  task: TaskRow;
  onUpdate: (id: string, patch: UpdateTaskInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const done = task.status === "done";

  return (
    <li className={`task ${done ? "task--done" : ""}`}>
      <input
        type="checkbox"
        className="task__check"
        checked={done}
        onChange={() => onUpdate(task.id, { status: done ? "todo" : "done" })}
        aria-label={done ? "Mark as not done" : "Mark as done"}
      />
      <span className="task__title">{task.title}</span>
      <span className={`badge badge--${task.priority}`}>{task.priority}</span>
      {task.dueAt && (
        <span className="task__due">
          {new Date(task.dueAt).toLocaleDateString()}
        </span>
      )}
      <button
        type="button"
        className="btn btn--ghost task__delete"
        onClick={() => onDelete(task.id)}
        aria-label="Delete task"
      >
        ✕
      </button>
    </li>
  );
}
