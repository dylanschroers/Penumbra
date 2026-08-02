import type { ComputeTarget, TargetId } from "@penumbra/shared";
import { type FormEvent, useEffect, useState } from "react";
import type { Compute } from "./useCompute";
import "./compute.css";

// The panel behind both status pills: where compute lives, and which of it each
// role uses.
//
// One component rather than one per surface, because it edits one setting. The
// chat pill and the Lab pill open the same thing for the same reason they had
// to stop disagreeing: a Studio key rotated from the Lab is the key chat is
// using.
//
// Nothing here ever displays a bearer. A configured target reports `hasKey`, and
// the field below is blank on load whether or not one is set — typing in it
// replaces, and leaving it alone keeps.

const STATE_LABEL: Record<ComputeTarget["state"], string> = {
  ready: "ready",
  unauthorized: "key rejected",
  not_studio: "not Studio's API",
  stopped: "not answering",
};

/** A Colab address outlives the session it points at, so "not answering" there
 *  usually means the notebook stopped rather than anything being misconfigured. */
function stateHint(target: ComputeTarget): string {
  if (target.state === "unauthorized") {
    return "Answering, but rejecting the key. Studio mints a new one on install and on every rotation, so paste the current one.";
  }
  // The one that used to read as "ready with nothing loaded": something answers,
  // so the address is not wrong in the obvious way, but it is not Studio's API
  // talking and every later call fails on a body that is not JSON.
  if (target.state === "not_studio") {
    return target.id === "colab"
      ? "Something answers here, but not Studio's API. A Colab notebook's own link (colab.googleusercontent.com, from google.colab.kernel.proxyPort) is authenticated by your browser session and returns a sign-in page to anything else, so it cannot be used from the server. Expose port 8888 with a tunnel — cloudflared or ngrok — and paste that URL instead. Set a Studio key too: a public tunnel with no key is an open GPU."
      : "Something answers here, but not Studio's API. Check the port: Studio's web UI and its API share one, so a UI-only port, a reverse proxy, or a sign-in page in front all look like this.";
  }
  if (!target.configured) {
    return target.id === "colab"
      ? "No endpoint set. Paste the tunnel URL your notebook is serving on."
      : "No address set.";
  }
  if (target.state === "stopped") {
    return target.id === "colab"
      ? "Not answering. A Colab session that has ended cannot be reached again, and this address is remembered from the last one; start a new session and paste its URL over it."
      : "Not answering. Check that Studio is running at this address.";
  }
  return "";
}

function TargetCard({
  target,
  compute,
}: {
  target: ComputeTarget;
  compute: Compute;
}) {
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pick, setPick] = useState("");

  const inventory = compute.inventory[target.id];
  const models = inventory?.models;
  const busy = compute.loading === target.id;

  // What is loaded comes from the poll, not the inventory: the inventory is a
  // disk scan fetched once, while this arrives with every reachability probe.
  // That is the difference between seeing a model appear seconds after someone
  // loads it in Studio's own UI on the other machine, and not seeing it until
  // the panel is re-opened. The inventory row, when there is one, only supplies
  // the nicer label.
  const served = target.servedModel;
  const resident = served
    ? (models?.find((m) => m.id === served) ?? {
        id: served,
        label: served,
      })
    : null;

  // Fetched when the card can actually serve it, and not on the poll: this
  // reaches the target's disk to enumerate models, which is far heavier than
  // the reachability probe the poll already does.
  useEffect(() => {
    if (target.state === "ready" && inventory === undefined) {
      void compute.loadInventory(target.id);
    }
  }, [target.state, target.id, inventory, compute]);

  // Follow the backend rather than holding a stale choice: a model loaded from
  // elsewhere, or evicted, would otherwise leave this box naming something that
  // is no longer what answers.
  useEffect(() => {
    if (served) setPick(served);
  }, [served]);

  function onSave(event: FormEvent) {
    event.preventDefault();
    void compute
      .setTarget(target.id, {
        ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
        ...(apiKey ? { apiKey } : {}),
      })
      .then(() => {
        // The address is echoed back by the next poll, so keeping it in the
        // field would just duplicate it. The key is never echoed, and must not
        // linger here after being sent.
        setBaseURL("");
        setApiKey("");
      });
  }

  const hint = stateHint(target);

  return (
    <section className="ct__target">
      <header className="ct__head">
        <span
          className={`ct__dot ct__dot--${target.state}`}
          aria-hidden="true"
        />
        <span className="ct__name">{target.label}</span>
        <span className="ct__state">
          {target.configured ? STATE_LABEL[target.state] : "not configured"}
        </span>
      </header>

      <p className="ct__addr">
        {target.configured ? target.baseURL : "not set"}
        {/* Only once there is an address to say something about — an
            unconfigured target has no provenance to report. */}
        {target.configured && (
          <span className="ct__meta">
            {target.source === "settings"
              ? " · set here"
              : " · from the server environment"}
          </span>
        )}
      </p>

      {hint && <p className="ct__hint">{hint}</p>}

      {/* Which model this target is serving, and a way to change it. Only for a
          target that is answering: a list from an unreachable Studio would be
          stale, and loading into one is not a thing that can happen. */}
      {target.state === "ready" && (
        <div className="ct__models">
          <label className="ct__models-label" htmlFor={`load-${target.id}`}>
            Loaded model
          </label>
          <div className="ct__models-row">
            {/* Free text with the inventory as suggestions, rather than a list
                you cannot escape. A fresh Colab has nothing on disk yet, so a
                list-only control can never load the *first* model there — and
                Studio resolves an id it doesn't recognize as a HuggingFace repo
                and fetches it, which is the only way a model gets onto a machine
                that has never seen one. */}
            <input
              id={`load-${target.id}`}
              list={`ct-models-${target.id}`}
              value={pick}
              disabled={busy}
              placeholder={
                models?.length
                  ? "Pick one, or type a HuggingFace id"
                  : "HuggingFace id, e.g. unsloth/Qwen3-4B"
              }
              onChange={(e) => setPick(e.target.value)}
            />
            <datalist id={`ct-models-${target.id}`}>
              {models?.map((m) => (
                <option
                  key={m.id}
                  value={m.id}
                  // Marked against the polled model, not the row's own flag,
                  // so the list and the note below cannot say different things.
                  label={`${m.id === served ? "● " : ""}${m.label} · ${m.format}${
                    m.sizeBytes > 0
                      ? ` · ${(m.sizeBytes / 1e9).toFixed(1)} GB`
                      : ""
                  }`}
                />
              ))}
            </datalist>
            <button
              type="button"
              disabled={busy || !pick.trim() || pick === resident?.id}
              onClick={() => void compute.loadModel(target.id, pick.trim())}
              title="Load this model here, downloading it first if this machine doesn't have it, and replacing whatever is loaded now"
            >
              {busy ? "Loading…" : "Load"}
            </button>
          </div>
          {/* One GPU holds one model, so this is never additive. Said plainly
              because the model being replaced may be the one a conversation is
              part-way through. */}
          <p className="ct__models-note">
            {busy
              ? "Weights are paging in; a large model takes a few minutes, and a first download longer."
              : resident
                ? `Serving ${resident.label}. Loading another replaces it.`
                : "Nothing loaded, so chat and benchmarks have nothing to answer with."}
          </p>
          {/* An empty list and a list that failed to load look identical from
              here, and send you to completely different places. */}
          {inventory?.inventoryError && (
            <p className="ct__hint">
              Its model inventory did not answer, so only what is loaded is
              suggested above; loading by id still works. (
              {inventory.inventoryError})
            </p>
          )}
        </div>
      )}

      <form className="ct__form" onSubmit={onSave}>
        <input
          aria-label={`${target.label} URL`}
          placeholder={target.configured ? target.baseURL : "https://…"}
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value)}
        />
        <input
          aria-label={`${target.label} API key`}
          type="password"
          placeholder={
            target.hasKey
              ? "Key set. Type a new one to replace it"
              : "No key set"
          }
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <div className="ct__actions">
          <button type="submit" disabled={!baseURL.trim() && !apiKey}>
            Save
          </button>
          {/* Local always exists, so its reset goes back to the environment
              rather than removing it; Colab genuinely goes away. */}
          {(target.source === "settings" || target.configured) &&
            !(target.id === "local" && target.source === "env") && (
              <button
                type="button"
                onClick={() => void compute.clearTarget(target.id)}
              >
                {target.id === "local" ? "Revert to .env" : "Remove"}
              </button>
            )}
        </div>
      </form>
    </section>
  );
}

export function ComputeTargets({ compute }: { compute: Compute }) {
  const state = compute.state;
  if (!state) {
    return <p className="ct__loading">{compute.error ?? "Loading…"}</p>;
  }

  const options = state.targets.filter((t) => t.configured);

  return (
    <div className="ct">
      {state.targets.map((t) => (
        <TargetCard key={t.id} target={t} compute={compute} />
      ))}

      <section className="ct__roles">
        <span className="ct__roles-title">Using for</span>
        {(["chat", "benchmark"] as const).map((role) => {
          const assigned = state.assignments[role];
          const effective = state.effective[role];
          return (
            <label key={role} className="ct__role">
              <span className="ct__role-name">
                {role === "chat" ? "Chat" : "Benchmarks"}
              </span>
              <select
                aria-label={`${role} target`}
                value={assigned}
                onChange={(e) =>
                  void compute.assign(role, e.target.value as TargetId)
                }
              >
                {state.targets.map((t) => (
                  <option
                    key={t.id}
                    value={t.id}
                    disabled={!t.configured && t.id !== assigned}
                  >
                    {t.label}
                    {t.configured ? "" : " (not configured)"}
                  </option>
                ))}
              </select>
              {/* Said out loud rather than silently corrected: an assignment can
                  outlive the target it names, and answers coming from somewhere
                  other than the box you picked is exactly the thing worth
                  knowing. */}
              {assigned !== effective && (
                <span className="ct__fallback">
                  unavailable, using{" "}
                  {state.targets.find((t) => t.id === effective)?.label ??
                    effective}
                </span>
              )}
            </label>
          );
        })}
        {options.length < 2 && (
          <p className="ct__hint">
            Configure a second target to run chat and benchmarks on different
            machines — one GPU holds one model, so a benchmark otherwise evicts
            the model chat is using.
          </p>
        )}
      </section>

      {/* Export is not assignable, and its absence here would read as an
          oversight rather than a rule. */}
      <p className="ct__note">
        Export follows the run that produced the checkpoint — its output lives
        on that machine's disk.
      </p>

      {compute.error && <p className="ct__error">{compute.error}</p>}
    </div>
  );
}
