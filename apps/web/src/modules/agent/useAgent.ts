import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AgentStatus,
  type ChatMessage,
  engine,
  getProvider,
  type ProviderKind,
  setProvider as routeProvider,
} from "../../engine";

// Drives the agent module: tracks the model's status and runs a tool-using turn
// against it. This hook owns only UI concerns: message state, the busy flag,
// and abort. Which backend answers (Tier 0's embedded model today, a server
// engine later) and which tools it runs are both settled in ../../engine, so
// nothing here changes when Tier 1 lands.

/** One tool the model ran during a turn, shown inline in the thread. */
export type ToolStep = { name: string; result: string };
/** A message as the UI holds it: wire content plus any tool steps that ran. */
export type DisplayMessage = ChatMessage & {
  steps?: ToolStep[];
  /** A marker written by the shell rather than by anyone in the conversation.
   *  Shown in the thread, never replayed as history — it is a note *about* the
   *  conversation, and feeding it back would put it in the model's mouth. */
  notice?: boolean;
  /**
   * Why this turn stopped early, when it did.
   *
   * Its own field rather than text appended to `content`, because the two are
   * not the same kind of thing: an error is the shell reporting on the turn, it
   * needs to look like a failure rather than like an answer, and it must not be
   * replayed to the model as something the assistant said. Appending it did all
   * three wrong.
   */
  error?: string;
};

/** Who answered: a compute target and the model resident on it. */
interface Identity {
  target: string | null;
  model: string | null;
}

function identityOf(status: AgentStatus): Identity {
  return {
    target: status.target?.id ?? null,
    // Only a ready backend names a model; anything else is "unknown", which is
    // not the same as "changed".
    model: status.state === "ready" ? (status.model ?? null) : null,
  };
}

/**
 * Whether the thread has changed hands.
 *
 * Only a move between two *known* values counts. Dropping to unknown is the
 * backend going away, which the pill already reports, and treating it as a
 * change would mark the thread every time a poll caught a restart.
 */
function differs(a: Identity, b: Identity): boolean {
  return (
    (!!a.target && !!b.target && a.target !== b.target) ||
    (!!a.model && !!b.model && a.model !== b.model)
  );
}

/**
 * Put `notice` at the end of the thread, replacing one already there, or take
 * the trailing one away when passed null.
 *
 * Replacing rather than appending is what keeps a run of switches to a single
 * marker: consecutive notices describe boundaries with no conversation between
 * them, so only the last one is about anything.
 */
function replaceTrailingNotice(notice: DisplayMessage | null) {
  return (prev: DisplayMessage[]): DisplayMessage[] => {
    const trailing = prev[prev.length - 1]?.notice === true;
    const base = trailing ? prev.slice(0, -1) : prev;
    // Nothing to separate in an empty thread.
    if (!notice) return trailing ? base : prev;
    return base.length === 0 ? prev : [...base, notice];
  };
}

export function useAgent() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [status, setStatus] = useState<AgentStatus>({ state: "stopped" });
  const [busy, setBusy] = useState(false);
  /**
   * When the in-flight turn started, or null when none is.
   *
   * The UI counts up from this. A tool loop against a large model is minutes of
   * silence between events, which is indistinguishable from a hang unless
   * something on screen is visibly moving — the complaint this answers.
   */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [provider, setProviderState] = useState<ProviderKind>(getProvider);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * The target and model that produced the most recent *turn*.
   *
   * Compared against, rather than against the previous poll, because the marker
   * describes a boundary in the conversation. Polling the difference instead
   * meant every hop counted: switching provider and back stacked three markers
   * around no conversation at all, when the thread had not actually changed
   * hands. Null until something has answered — an empty thread has no boundary.
   */
  const answeredBy = useRef<Identity | null>(null);

  const refreshStatus = useCallback(async () => {
    const next = await engine.getStatus();
    setStatus(next);

    // A conversation can change model underneath itself: the target is
    // reassigned in the compute panel, or a Colab session ends and the role
    // falls back to the local Studio. Either way the transcript would otherwise
    // hold answers from two models with nothing separating them — the same
    // class of silent wrongness as a crashed training run reading as done.
    //
    // The model is watched alongside the target because one target serves one
    // model at a time and swapping it in Studio never touches the target id.
    // Keying on the target alone made the commonest change of all — the same
    // machine now running different weights — the one the transcript stayed
    // silent about.
    const was = answeredBy.current;
    if (!was) return;
    const now = identityOf(next);

    // Coming back to whatever answered last leaves nothing to announce, so any
    // marker written on the way out is taken back down.
    if (!differs(was, now)) {
      setMessages(replaceTrailingNotice(null));
      return;
    }

    const where = next.target?.label ?? now.target;
    const moved =
      was.target && now.target && was.target !== now.target
        ? `Now answering from ${where}${now.model ? ` as ${now.model}` : ""}.`
        : `Now answering as ${now.model}.`;
    setMessages(
      replaceTrailingNotice({
        role: "assistant",
        notice: true,
        content: `${moved} Replies below this line come from a different model than the ones above.`,
      }),
    );
  }, []);

  // Route the chat to a different provider, then re-check status so the pill
  // reflects the new backend immediately rather than on the next poll tick.
  const setProvider = useCallback(
    (kind: ProviderKind) => {
      routeProvider(kind);
      setProviderState(getProvider()); // what the engine actually accepted
      void refreshStatus();
    },
    [refreshStatus],
  );

  // Poll status so the pill reflects the model starting/stopping out of band.
  // Skip ticks while the tab is hidden; the next visible tick catches up.
  useEffect(() => {
    void refreshStatus();
    const id = setInterval(() => {
      if (!document.hidden) void refreshStatus();
    }, 5000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // Cancel an in-flight turn when the module unmounts, so the tool loop stops
  // instead of patching state that no longer has a component.
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      // History is role + content only; tool steps are display-only and never
      // replayed (each turn runs a fresh tool loop). Notices are dropped for a
      // stronger reason: they are the shell talking about the conversation, and
      // replaying one would present it as something the assistant said — and so
      // is an error, which additionally left an empty assistant turn in the
      // context when the failure was all a turn produced.
      const spoken = (m: DisplayMessage) =>
        !m.notice && !(m.error && !m.content.trim());
      const history: ChatMessage[] = [
        ...messages
          .filter(spoken)
          .map(({ role, content }) => ({ role, content })),
        { role: "user", content: trimmed },
      ];
      setMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        { role: "assistant", content: "", steps: [] },
      ]);
      // Whatever is resolved now is what serves this turn, and what a later
      // change is measured against.
      answeredBy.current = identityOf(status);
      setBusy(true);
      setStartedAt(Date.now());

      const controller = new AbortController();
      abortRef.current = controller;

      // Patch the trailing (assistant) message in place.
      const patch = (fn: (m: DisplayMessage) => DisplayMessage) =>
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (!last) return prev;
          next[next.length - 1] = fn(last);
          return next;
        });

      try {
        for await (const ev of engine.runAgent(history, controller.signal)) {
          if (ev.kind === "tool") {
            patch((m) => ({
              ...m,
              steps: [...(m.steps ?? []), { name: ev.name, result: ev.result }],
            }));
          } else {
            // A truncated reply ends mid-sentence and otherwise looks finished,
            // so the shell has to be the one to say the model was cut off.
            patch((m) => ({
              ...m,
              content: ev.text,
              error: ev.truncated
                ? "The reply hit the length limit and was cut off."
                : m.error,
            }));
          }
        }
      } catch (err) {
        // An abort is the user's own doing, so it is reported as a stop rather
        // than as a fault — but it is still reported. A turn that vanishes with
        // the thread unchanged reads exactly like one that never ran.
        patch((m) => ({
          ...m,
          error: controller.signal.aborted
            ? "Stopped."
            : err instanceof Error
              ? err.message
              : String(err),
        }));
      } finally {
        setBusy(false);
        setStartedAt(null);
        abortRef.current = null;
      }
    },
    [messages, busy, status],
  );

  /**
   * Start a fresh thread.
   *
   * The transcript is the model's context, not just a display log: every turn
   * replays it, so one wrong answer keeps regenerating itself. A small model
   * asked what it is will copy its own earlier reply over anything the system
   * prompt says, which made an old answer outlive the prompt that produced it.
   * Discarding the history is the only way back, so it needs a control.
   */
  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    // A cleared thread has no last turn to measure a change against.
    answeredBy.current = null;
    setBusy(false);
    setStartedAt(null);
  }, []);

  /**
   * Abandon the turn in flight, keeping the thread.
   *
   * `clear` could already do this, at the cost of the conversation — which made
   * the only way out of a slow turn the one that also destroyed the context.
   * Whatever the tools already did stands; the server stops its own loop when
   * the stream closes (docs/AGENT_DESIGN.md §5).
   */
  const stop = useCallback(() => abortRef.current?.abort(), []);

  return {
    messages,
    status,
    busy,
    startedAt,
    send,
    stop,
    clear,
    provider,
    setProvider,
  };
}
