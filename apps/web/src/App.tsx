import { createTaskInput, type CreateTaskInput } from "@ghost/shared";

export function App() {
  // Proof the shared package is wired up: validate a sample task with the very
  // same Zod schema the server uses. If this compiles and runs, the monorepo
  // link (web → @ghost/shared) works.
  const sample: CreateTaskInput = createTaskInput.parse({ title: "Try Ghost" });

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>Ghost</h1>
      <p>
        Shared validation works — parsed “{sample.title}” with priority{" "}
        <strong>{sample.priority}</strong>.
      </p>
    </main>
  );
}
