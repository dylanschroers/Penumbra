import { useState, type FormEvent } from "react";
import type { CreateTaskInput, TaskPriority } from "@ghost/shared";

// Owns only its own field state. On submit it builds a CreateTaskInput and
// hands it to the parent; the date input gives "YYYY-MM-DD", which we widen to
// a full ISO string so it passes the shared Zod schema's .datetime() rule.
export function AddTaskForm({
  onAdd,
}: {
  onAdd: (input: CreateTaskInput) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [dueAt, setDueAt] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    setBusy(true);
    try {
      await onAdd({
        title: trimmed,
        priority,
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
      });
      setTitle("");
      setPriority("medium");
      setDueAt("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="add-form" onSubmit={handleSubmit}>
      <input
        className="add-form__title"
        placeholder="Add a task…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        aria-label="Task title"
      />
      <select
        className="add-form__priority"
        value={priority}
        onChange={(e) => setPriority(e.target.value as TaskPriority)}
        aria-label="Priority"
      >
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
      <input
        className="add-form__due"
        type="date"
        value={dueAt}
        onChange={(e) => setDueAt(e.target.value)}
        aria-label="Due date"
      />
      <button
        type="submit"
        className="btn btn--primary"
        disabled={busy || !title.trim()}
      >
        Add
      </button>
    </form>
  );
}
