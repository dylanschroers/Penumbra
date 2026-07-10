import { useState, type FormEvent } from "react";
import type { AgentStatus } from "@ghost/shared";
import { useAgent } from "./useAgent";

// The assistant module: a status pill plus a chat against the embedded local
// model (Tier 0). It can call task tools (see ../../agent/tools) and shows each
// tool it ran inline. Card chrome (title bar, drag, resize, close) belongs to
// the workspace ModuleFrame, so this renders only its inner content.

const TOOL_LABEL: Record<string, string> = {
  create_task: "Added task",
  list_tasks: "Listed tasks",
  complete_task: "Completed task",
  delete_task: "Deleted task",
};

const STATUS_LABEL: Record<AgentStatus["state"], string> = {
  ready: "Ready",
  no_model: "No model loaded",
  stopped: "Model offline",
  not_installed: "Model not installed",
};

function StatusPill({ status }: { status: AgentStatus }) {
  const label =
    status.state === "ready" && status.model
      ? `${STATUS_LABEL.ready} · ${status.model}`
      : STATUS_LABEL[status.state];
  return (
    <span className={`agent__pill agent__pill--${status.state}`}>{label}</span>
  );
}

export function AgentModule() {
  const { messages, status, busy, send } = useAgent();
  const [draft, setDraft] = useState("");

  const ready = status.state === "ready";

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(draft);
    setDraft("");
  }

  return (
    <div className="agent">
      <div className="agent__status">
        <StatusPill status={status} />
      </div>

      <div className="agent__messages">
        {messages.length === 0 ? (
          <p className="notice">
            {ready
              ? "Ask the assistant anything."
              : "Start the local model to begin."}
          </p>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`agent__msg agent__msg--${m.role}`}>
              {m.steps?.map((s, j) => (
                <div key={j} className="agent__tool" title={s.result}>
                  🔧 {TOOL_LABEL[s.name] ?? s.name}
                </div>
              ))}
              {m.content.trim() ? (
                <div className="agent__bubble">{m.content.trim()}</div>
              ) : busy && i === messages.length - 1 ? (
                <div className="agent__bubble agent__bubble--pending">…</div>
              ) : null}
            </div>
          ))
        )}
      </div>

      <form className="agent__form" onSubmit={onSubmit}>
        <input
          className="agent__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={ready ? "Message the assistant…" : "Unavailable"}
          disabled={!ready || busy}
          aria-label="Message the assistant"
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={!ready || busy || !draft.trim()}
        >
          Send
        </button>
      </form>
    </div>
  );
}
