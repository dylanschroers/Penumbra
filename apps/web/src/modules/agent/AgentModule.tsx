import { type FormEvent, useEffect, useState } from "react";
import { ComputeTargets } from "../../compute/ComputeTargets";
import { useCompute } from "../../compute/useCompute";
import { type AgentStatus, PROVIDERS } from "../../engine";
import { Markdown } from "./Markdown";
import { useAgent } from "./useAgent";

// The assistant module: a status pill plus a chat against the embedded local
// model (Tier 0). It can call task tools (see ../../agent/tools) and shows each
// tool it ran inline. Card chrome (title bar, expand, close) belongs to the
// shell — the dock card or the focus pane — so this renders only inner content.

const TOOL_LABEL: Record<string, string> = {
  create_task: "Added task",
  list_tasks: "Listed tasks",
  complete_task: "Completed task",
  delete_task: "Deleted task",
};

const STATUS_LABEL: Record<AgentStatus["state"], string> = {
  ready: "Ready",
  no_model: "No model loaded",
  unauthorized: "Key rejected",
  stopped: "Model offline",
};

/** The pill's text: which target answered, then how it is doing. The target
 *  comes back with the state rather than being fetched alongside it, so the two
 *  can never describe different machines. */
function statusLabel(status: AgentStatus): string {
  const state =
    status.state === "ready" && status.model
      ? `${STATUS_LABEL.ready} · ${status.model}`
      : STATUS_LABEL[status.state];
  return status.target ? `${status.target.label} · ${state}` : state;
}

function StatusPill({ status }: { status: AgentStatus }) {
  return (
    <span className={`agent__pill agent__pill--${status.state}`}>
      {statusLabel(status)}
    </span>
  );
}

/** What to do about a backend that isn't ready, which depends entirely on which
 *  one is selected: a Studio key is no help when the embedded model is the one
 *  not running. */
function emptyHint(status: AgentStatus, provider: string): string {
  if (status.state === "ready") return "Ask the assistant anything.";
  if (provider !== "server") return "Start the local model to begin.";
  const where = status.target?.label ?? "the server's Studio";
  if (status.state === "unauthorized") {
    return `${where} is running but rejected the server's key — open the pill above to paste the current one.`;
  }
  if (status.state === "no_model") {
    return `${where} is up with no model loaded. Load one in Studio to begin.`;
  }
  return `${where} is not answering — open the pill above to check where it is pointed.`;
}

export function AgentModule() {
  const { messages, status, busy, send, provider, setProvider } = useAgent();
  const [draft, setDraft] = useState("");
  const [targetsOpen, setTargetsOpen] = useState(false);

  // The pill is only a control for the server tier: Tier 0 runs the embedded
  // llama-server, which has no target to point anywhere.
  const canConfigure = provider === "server";

  // Polled only when it can be acted on, so a chat on the embedded model never
  // asks the server about Studios it is not using.
  const compute = useCompute(canConfigure);

  // Escape closes the panel, matching the backdrop click.
  useEffect(() => {
    if (!targetsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTargetsOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [targetsOpen]);

  const ready = status.state === "ready";

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(draft);
    setDraft("");
  }

  return (
    <div className="agent">
      <div className="agent__status">
        <div className="agent__providers">
          {/* Each button is individually labelled + aria-pressed; a wrapper role
              would only trip useSemanticElements for little a11y gain. */}
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`agent__provider${
                provider === p.id ? " agent__provider--active" : ""
              }`}
              onClick={() => setProvider(p.id)}
              disabled={!p.available}
              aria-pressed={provider === p.id}
              title={p.hint}
            >
              {p.label}
            </button>
          ))}
        </div>

        {canConfigure ? (
          <button
            type="button"
            className={`agent__pill agent__pill--${status.state} agent__pill--action`}
            onClick={() => setTargetsOpen((open) => !open)}
            aria-haspopup="dialog"
            aria-expanded={targetsOpen}
            title="Configure compute targets"
          >
            {statusLabel(status)}
            <span className="agent__pill-caret" aria-hidden="true">
              ▾
            </span>
          </button>
        ) : (
          <StatusPill status={status} />
        )}

        {targetsOpen && (
          <>
            {/* A transparent backdrop so a click anywhere outside dismisses. */}
            <button
              type="button"
              className="agent__popover-backdrop"
              aria-label="Close compute targets"
              onClick={() => setTargetsOpen(false)}
            />
            <div
              className="agent__popover"
              role="dialog"
              aria-label="Compute targets"
            >
              <ComputeTargets compute={compute} />
            </div>
          </>
        )}
      </div>

      <div className="agent__messages">
        {messages.length === 0 ? (
          <p className="notice">{emptyHint(status, provider)}</p>
        ) : (
          messages.map((m, i) =>
            // A marker, not a turn: rendered as a rule across the thread so the
            // boundary between two models is visible at a glance rather than
            // reading as something the assistant said.
            m.notice ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only chat log, never reordered or removed
              <p key={i} className="agent__notice">
                {m.content}
              </p>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only chat log, never reordered or removed
              <div key={i} className={`agent__msg agent__msg--${m.role}`}>
                {m.steps?.map((s, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a message's tool steps are fixed once rendered
                  <div key={j} className="agent__tool" title={s.result}>
                    🔧 {TOOL_LABEL[s.name] ?? s.name}
                  </div>
                ))}
                {m.content.trim() ? (
                  <div className="agent__bubble">
                    {m.role === "assistant" ? (
                      <Markdown>{m.content.trim()}</Markdown>
                    ) : (
                      m.content.trim()
                    )}
                  </div>
                ) : busy && i === messages.length - 1 ? (
                  <div className="agent__bubble agent__bubble--pending">…</div>
                ) : null}
              </div>
            ),
          )
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
