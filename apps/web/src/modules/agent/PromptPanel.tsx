import { type FormEvent, useEffect, useState } from "react";
import {
  fetchPrompt,
  localPrompt,
  type PromptState,
  resetPersona,
  savePersona,
} from "../../agent/prompt";

// The system prompt, shown whole and edited in part.
//
// It opens from the same header as the compute panel because the two answer
// adjacent questions — what is answering me, and how is it told to behave —
// and configuration belongs where its effect is visible rather than in a
// settings screen that would be the only place it is ever seen.
//
// The policy half is rendered read-only rather than hidden. "See the system
// prompt" is not answered by showing only the part that happens to be editable,
// and a user who can read the tool rules can tell whether an edit of theirs is
// what broke task creation. It is fixed because everything load-bearing lives
// there: the tool policy, and the honesty rules that stop a small model
// inventing a name and a vendor for itself.
//
// It renders without a server. The panel used to fetch before showing anything,
// which meant the tier that runs offline had a prompt nobody offline could read
// — and every field it needs is already in the bundle or in localStorage
// (../../agent/prompt → localPrompt). The fetch still happens, and still wins
// when it answers; only *editing* requires the server, which owns the value.

export function PromptPanel() {
  // Seeded from the client's own copy rather than starting empty, so the prompt
  // is readable with no server at all — see localPrompt(). The fetch below
  // upgrades it to the server's view when one answers.
  const [state, setState] = useState<PromptState>(localPrompt);
  const [draft, setDraft] = useState(() => localPrompt().persona);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** No server reached yet. Editing is disabled meanwhile: the server owns the
   *  stored persona, and writing one here would put the two tiers on different
   *  prompts — the divergence this module exists to avoid. */
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let live = true;
    fetchPrompt()
      .then((next) => {
        if (!live) return;
        setState(next);
        setDraft(next.persona);
        setOffline(false);
      })
      .catch(() => live && setOffline(true));
    return () => {
      live = false;
    };
  }, []);

  /** Apply a server response: it is the source of truth for what was stored. */
  const applied = (next: PromptState) => {
    setState(next);
    setDraft(next.persona);
    setError(null);
    setOffline(false);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      applied(await savePersona(draft));
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
  const dirty = draft !== state.persona;

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

      {error && <p className="prompt__error">{error}</p>}

      <div className="prompt__actions">
        <button type="submit" disabled={busy || over || !dirty || offline}>
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

      {/* Said plainly rather than shown as a failure: this *is* the prompt the
          local model will use, so the panel has not fallen back to something
          approximate. Only the ability to change it is missing, and the staleness
          is the one caveat worth naming. */}
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
