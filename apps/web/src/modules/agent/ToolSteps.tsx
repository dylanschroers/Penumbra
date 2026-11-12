import { useState } from "react";
import type { ToolStep } from "./useAgent";

const TOOL_LABEL: Record<string, string> = {
  create_task: "Added task",
  list_tasks: "Listed tasks",
  complete_task: "Completed task",
  delete_task: "Deleted task",
  get_weather: "Checked the weather",
  list_models: "Listed models",
  list_datasets: "Listed datasets",
  start_finetune: "Started fine-tuning",
  run_benchmark: "Started a benchmark",
  job_status: "Checked job status",
  list_files: "Listed files",
  read_file: "Read a file",
  search_files: "Searched files",
  write_file: "Wrote a file",
  edit_file: "Edited a file",
  create_folder: "Created a folder",
  move_file: "Moved a file",
  delete_file: "Moved to Trash",
};

/**
 * Whether a tool's result reads as a refusal rather than an answer.
 *
 * Matched on the openings the runners actually use, which are few and fixed
 * (../../../../packages/shared/src/tools, apps/server/src/agent/tools.ts): a
 * tool reports failure by *returning* a sentence, because the model has to be
 * able to read and correct it. That leaves the UI nothing typed to key on, and
 * a failed step rendered identically to a successful one is how "it silently
 * did nothing" happens. Mis-classifying only changes an icon.
 */
const FAILED_RESULT =
  /^(Cannot |Invalid arguments|Tool \S+ failed|Unknown tool|No task matching|There is no job|The user declined)/;

function Step({ step }: { step: ToolStep }) {
  const failed = FAILED_RESULT.test(step.result);
  return (
    <span
      className={`agent__tool${failed ? " agent__tool--failed" : ""}`}
      title={step.result}
    >
      {failed ? "⚠" : "🔧"} {TOOL_LABEL[step.name] ?? step.name}
      {/* The result inline, not only as a tooltip: a tool that refused said
          why in this string, and a hover target is not somewhere a person
          looks when nothing happened. */}
      <span className="agent__tool-result">{step.result.split("\n")[0]}</span>
    </span>
  );
}

/**
 * A reply's tool runs. One shows as is. More collapse to a single line holding
 * the latest, which keeps updating while a turn runs, with the count beside it;
 * clicking opens the full list.
 */
export function ToolSteps({ steps }: { steps: ToolStep[] }) {
  const [open, setOpen] = useState(false);
  const latest = steps[steps.length - 1];
  if (!latest) return null;
  if (steps.length === 1) return <Step step={latest} />;
  const failures = steps.filter((s) => FAILED_RESULT.test(s.result)).length;
  const count = `${steps.length} actions${failures ? `, ${failures} failed` : ""}`;
  return (
    <div className="agent__steps">
      <button
        type="button"
        className="agent__steps-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={open ? "Show only the latest action" : "Show every action"}
      >
        <span className="agent__steps-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        {open ? (
          <span className="agent__steps-count">{count}</span>
        ) : (
          <>
            <Step step={latest} />
            <span className="agent__steps-count">{count}</span>
          </>
        )}
      </button>
      {open && (
        <div className="agent__steps-list">
          {steps.map((step, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a turn's tool steps only ever append
            <Step key={j} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}
