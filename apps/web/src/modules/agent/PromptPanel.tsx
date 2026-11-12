import {
  AGENT_MAX_TOKENS_LOCAL,
  AGENT_MAX_TOKENS_MAX,
  AGENT_MAX_TOKENS_MIN,
  AGENT_MAX_TOKENS_SERVER,
} from "@penumbra/shared";
import { type FormEvent, useEffect, useState } from "react";
import {
  fetchPrompt,
  localPrompt,
  type PromptState,
  resetPersona,
  savePrompt,
} from "../../agent/prompt";

// The policy half is shown read-only so users can see the tool rules. Renders
// offline from localPrompt(); the server's answer wins when it comes, and only
// editing needs the server.

export function PromptPanel() {
  const [state, setState] = useState<PromptState>(localPrompt);
  const [draft, setDraft] = useState(() => localPrompt().persona);
  /** A string so the field can be empty, meaning "each tier's own default". */
  const [cap, setCap] = useState(() => {
    const stored = localPrompt().maxTokens;
    return stored === null ? "" : String(stored);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Editing needs the server, which owns the stored persona. */
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let live = true;
    fetchPrompt()
      .then((next) => {
        if (!live) return;
        setState(next);
        setDraft(next.persona);
        setCap(next.maxTokens === null ? "" : String(next.maxTokens));
        setOffline(false);
      })
      .catch(() => live && setOffline(true));
    return () => {
      live = false;
    };
  }, []);

  const applied = (next: PromptState) => {
    setState(next);
    setDraft(next.persona);
    setCap(next.maxTokens === null ? "" : String(next.maxTokens));
    setError(null);
    setOffline(false);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      // Empty clears the override; the server validates the range.
      const trimmed = cap.trim();
      applied(
        await savePrompt({
          persona: draft,
          maxTokens: trimmed === "" ? null : Number(trimmed),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      applied(await resetPersona());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const over = draft.length > state.maxLength;
  const storedCap = state.maxTokens === null ? "" : String(state.maxTokens);
  const capNumber = Number(cap.trim());
  // Validated here so Save disables rather than the server refusing.
  const capInvalid =
    cap.trim() !== "" &&
    (!Number.isInteger(capNumber) ||
      capNumber < AGENT_MAX_TOKENS_MIN ||
      capNumber > AGENT_MAX_TOKENS_MAX);
  const dirty = draft !== state.persona || cap.trim() !== storedCap;

  return (
    <form className="prompt" onSubmit={submit}>
      <div className="prompt__section">
        <span className="prompt__label">Fixed</span>
        <p className="prompt__policy">{state.policy}</p>
        <p className="prompt__hint">
          Not editable: these rules decide when the task tools run, and stop the
          assistant inventing a name or a vendor for itself. The model it is
          actually running on is added automatically at the end of every turn.
        </p>
      </div>

      <div className="prompt__section">
        <label className="prompt__label" htmlFor="prompt-persona">
          Editable — tone and formatting
        </label>
        <textarea
          id="prompt-persona"
          className="prompt__input"
          rows={6}
          value={draft}
          spellCheck={false}
          readOnly={offline}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="prompt__meta">
          <span className={over ? "prompt__count--over" : undefined}>
            {draft.length} / {state.maxLength}
          </span>
          <span>
            {state.source === "settings" ? "Custom" : "Default"} in force
          </span>
        </div>
      </div>

      <div className="prompt__section">
        <label className="prompt__label" htmlFor="prompt-max-tokens">
          Editable — longest reply
        </label>
        <input
          id="prompt-max-tokens"
          className="prompt__number"
          type="number"
          inputMode="numeric"
          min={AGENT_MAX_TOKENS_MIN}
          max={AGENT_MAX_TOKENS_MAX}
          step={64}
          value={cap}
          readOnly={offline}
          placeholder={`Default — local ${AGENT_MAX_TOKENS_LOCAL}, server ${AGENT_MAX_TOKENS_SERVER}`}
          onChange={(e) => setCap(e.target.value)}
        />
        <div className="prompt__meta">
          <span className={capInvalid ? "prompt__count--over" : undefined}>
            {AGENT_MAX_TOKENS_MIN}–{AGENT_MAX_TOKENS_MAX} tokens
          </span>
          <span>{cap.trim() === "" ? "Default" : "Custom"} in force</span>
        </div>
        {/* Blank keeps each tier's default: 512 suits the 1.7B model and would cut the server model off. */}
        <p className="prompt__hint">
          How many tokens one reply may use before it is cut off. Leave empty to
          let each model use its own default. A reply that hits the cap is
          marked as cut off in the chat.
        </p>
      </div>

      {error && <p className="prompt__error">{error}</p>}

      <div className="prompt__actions">
        <button
          type="submit"
          disabled={busy || over || capInvalid || !dirty || offline}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={busy || state.source === "default" || offline}
          title="Go back to the prompt this version of Penumbra ships with"
        >
          Reset to default
        </button>
      </div>

      {offline ? (
        <p className="prompt__hint">
          The server is not reachable, so this is the prompt stored on this
          device — what the local model will use on its next message. Editing
          needs the server, which owns the saved persona. If it was changed from
          another device since this one last connected, that change is not shown
          here yet.
        </p>
      ) : (
        <p className="prompt__hint">
          Applies to the next message on both the local and server models.
          Benchmarks always run the shipped default, so a change here cannot
          move their scores.
        </p>
      )}
    </form>
  );
}
