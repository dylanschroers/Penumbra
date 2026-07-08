import { useState, type FormEvent } from "react";
import type { AgentStatus } from "@ghost/shared";
import { useAgent } from "./useAgent";

// The assistant module: a status pill plus a streaming chat against whatever
// InferenceEngine is configured (the embedded local model by default). Tool
// calling and acting on other modules come in a later phase; this proves the
// model round trip — local or remote — end to end. Card chrome (title bar, drag,
// resize, close) belongs to the workspace ModuleFrame, so this renders only its
// inner content.

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
  const { messages, status, streaming, send } = useAgent();
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
              {m.reasoning ? (
                <details className="agent__think">
                  <summary className="agent__think-summary">Thinking</summary>
                  <div className="agent__think-body">{m.reasoning}</div>
                </details>
              ) : null}
              {m.content ? (
                <div className="agent__bubble">{m.content}</div>
              ) : streaming && i === messages.length - 1 ? (
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
          disabled={!ready || streaming}
          aria-label="Message the assistant"
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={!ready || streaming || !draft.trim()}
        >
          Send
        </button>
      </form>
    </div>
  );
}
