import { type FormEvent, useEffect, useState } from "react";
import { ComputeTargets } from "../../compute/ComputeTargets";
import { useCompute } from "../../compute/useCompute";
import { type AgentStatus, PROVIDERS } from "../../engine";
import { Markdown } from "./Markdown";
import { PromptPanel } from "./PromptPanel";
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
  get_weather: "Checked the weather",
  list_models: "Listed models",
  list_datasets: "Listed datasets",
  start_finetune: "Started fine-tuning",
  run_benchmark: "Started a benchmark",
  job_status: "Checked job status",
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
  /^(Cannot |Invalid arguments|Tool \S+ failed|Unknown tool|No task matching|There is no job)/;

/** How long a turn may run before the wait itself is worth remarking on. Past
 *  this the counter is the only evidence anything is still happening. */
const SLOW_TURN_MS = 15_000;

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
    <span
      className={`agent__pill agent__pill--${status.state} agent__pill--status`}
    >
      <span className="agent__pill-label">{statusLabel(status)}</span>
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
    return `${where} is running but rejected the server's key. Open the pill above to paste the current one.`;
  }
  if (status.state === "no_model") {
    return `${where} is up with no model loaded. Load one in Studio to begin.`;
  }
  return `${where} is not answering. Open the pill above to check where it is pointed.`;
}

/** Seconds a turn has been running, ticking while one is. Its own component so
 *  the interval re-renders the counter and not the whole transcript. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return (
    <span className="agent__elapsed">
      {seconds < 60
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}
      {now - since > SLOW_TURN_MS ? " · still working" : ""}
    </span>
  );
}

export function AgentModule() {
  const {
    messages,
    status,
    busy,
    startedAt,
    send,
    stop,
    clear,
    provider,
    setProvider,
  } = useAgent();
  const [draft, setDraft] = useState("");
  // Two panels, one at a time: they open from adjacent controls and overlap.
  const [panel, setPanel] = useState<"targets" | "prompt" | null>(null);
  const targetsOpen = panel === "targets";

  // The pill is only a control for the server tier: Tier 0 runs the embedded
  // llama-server, which has no target to point anywhere.
  const canConfigure = provider === "server";

  // Polled only when it can be acted on, so a chat on the embedded model never
  // asks the server about Studios it is not using.
  const compute = useCompute(canConfigure);

  // Escape closes whichever panel is open, matching the backdrop click.
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel]);

  const ready = status.state === "ready";

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(draft);
    setDraft("");
  }

  return (
    <div className="agent">
      <div className="agent__status">
        {/* The controls live inside a plain block, not directly in the flex
            column: a wrapping flex row measured as a column child under-reserves
            its height (Chromium sizes it at one line), so a wrapped second row
            would overlap the transcript. The block measures the bar at its real
            width, and the pill grows to fill a wide row so it truncates on one
            line rather than forcing the wrap in the first place. */}
        <div className="agent__status-bar">
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
              className={`agent__pill agent__pill--${status.state} agent__pill--status agent__pill--action`}
              onClick={() => setPanel(targetsOpen ? null : "targets")}
              aria-haspopup="dialog"
              aria-expanded={targetsOpen}
              title="Configure compute targets"
            >
              <span className="agent__pill-label">{statusLabel(status)}</span>
              <span className="agent__pill-caret" aria-hidden="true">
                ▾
              </span>
            </button>
          ) : (
            <StatusPill status={status} />
          )}

          {/* The transcript is the model's context, so a thread that has gone
              wrong stays wrong: every turn replays it, and a small model copies
              its own earlier answer over the system prompt. Discarding it is the
              only way out, which makes this a control and not a convenience. */}
          <button
            type="button"
            className="agent__pill agent__pill--action"
            onClick={clear}
            disabled={messages.length === 0}
            title="Discard this conversation and start a fresh one"
          >
            Clear
          </button>

          {/* Beside the pill because the two belong together: which model answers,
              and what it is told to do. Available on every tier — the prompt is
              shared, so editing it from a Tier-0 chat is not a category error. */}
          <button
            type="button"
            className="agent__pill agent__pill--action"
            onClick={() => setPanel(panel === "prompt" ? null : "prompt")}
            aria-haspopup="dialog"
            aria-expanded={panel === "prompt"}
            title="View and edit the system prompt"
          >
            Prompt
            <span className="agent__pill-caret" aria-hidden="true">
              ▾
            </span>
          </button>
        </div>

        {panel && (
          <>
            {/* A transparent backdrop so a click anywhere outside dismisses. */}
            <button
              type="button"
              className="agent__popover-backdrop"
              aria-label={
                targetsOpen ? "Close compute targets" : "Close system prompt"
              }
              onClick={() => setPanel(null)}
            />
            <div
              className="agent__popover"
              role="dialog"
              aria-label={targetsOpen ? "Compute targets" : "System prompt"}
            >
              {targetsOpen ? (
                <ComputeTargets compute={compute} />
              ) : (
                <PromptPanel />
              )}
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
                {m.steps?.map((s, j) => {
                  const failed = FAILED_RESULT.test(s.result);
                  return (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: a message's tool steps are fixed once rendered
                      key={j}
                      className={`agent__tool${failed ? " agent__tool--failed" : ""}`}
                      title={s.result}
                    >
                      {failed ? "⚠" : "🔧"} {TOOL_LABEL[s.name] ?? s.name}
                      {/* The result inline, not only as a tooltip: a tool that
                          refused said why in this string, and a hover target is
                          not somewhere a person looks when nothing happened. */}
                      <span className="agent__tool-result">
                        {s.result.split("\n")[0]}
                      </span>
                    </div>
                  );
                })}
                {m.content.trim() ? (
                  <div className="agent__bubble">
                    {m.role === "assistant" ? (
                      <Markdown>{m.content.trim()}</Markdown>
                    ) : (
                      m.content.trim()
                    )}
                  </div>
                ) : busy && i === messages.length - 1 ? (
                  <div className="agent__bubble agent__bubble--pending">
                    Working…{" "}
                    {startedAt !== null && <Elapsed since={startedAt} />}
                  </div>
                ) : null}
                {/* Rendered as a failure rather than as an answer: the turn
                    stopped, and the thread has to say so instead of ending in
                    silence. */}
                {m.error && (
                  <div className="agent__error" role="status">
                    {m.error}
                  </div>
                )}
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
        {/* Replaces Send while a turn runs, rather than sitting beside it: the
            input is disabled anyway, so Send has nothing to do, and a turn that
            is taking too long needs one obvious way out that is not Clear. */}
        {busy ? (
          <button type="button" className="btn" onClick={stop}>
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="btn btn--primary"
            disabled={!ready || !draft.trim()}
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
