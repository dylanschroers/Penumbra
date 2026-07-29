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
  stopped: "not answering",
};

/** Colab's config dies with the process, so "not answering" there usually means
 *  the session ended rather than anything being misconfigured. */
function stateHint(target: ComputeTarget): string {
  if (target.state === "unauthorized") {
    return "Answering, but rejecting the key. Studio mints a new one on install and on every rotation — paste the current one.";
  }
  if (!target.configured) {
    return target.id === "colab"
      ? "No endpoint set. Paste the tunnel URL your notebook is serving on."
      : "No address set.";
  }
  if (target.state === "stopped") {
    return target.persistence === "session"
      ? "Not answering — a Colab session that has ended cannot be reached again; start a new one and paste its URL."
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

  const models = compute.models[target.id];
  const resident = models?.find((m) => m.loaded);
  const busy = compute.loading === target.id;

  // Fetched when the card can actually serve it, and not on the poll: this
  // reaches the target's disk to enumerate models, which is far heavier than
  // the reachability probe the poll already does.
  useEffect(() => {
    if (target.state === "ready" && models === undefined) {
      void compute.loadModels(target.id);
    }
  }, [target.state, target.id, models, compute]);

  // Follow the backend rather than holding a stale choice: a model loaded from
  // elsewhere, or evicted, would otherwise leave this box naming something that
  // is no longer what answers.
  useEffect(() => {
    if (resident) setPick(resident.id);
  }, [resident]);

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
        {target.configured ? target.baseURL : "—"}
        <span className="ct__meta">
          {target.persistence === "session"
            ? " · in memory only, re-entered each restart"
            : target.source === "settings"
              ? " · set here"
              : " · from the server environment"}
        </span>
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
            <select
              id={`load-${target.id}`}
              value={pick}
              disabled={busy || !models?.length}
              onChange={(e) => setPick(e.target.value)}
            >
              {models === undefined && <option value="">Reading…</option>}
              {models?.length === 0 && (
                <option value="">No models on this target</option>
              )}
              {models?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.loaded ? "● " : ""}
                  {m.label} · {m.format}
                  {m.sizeBytes > 0
                    ? ` · ${(m.sizeBytes / 1e9).toFixed(1)} GB`
                    : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !pick || pick === resident?.id}
              onClick={() => void compute.loadModel(target.id, pick)}
              title="Load this model here, replacing whatever is loaded now"
            >
              {busy ? "Loading…" : "Load"}
            </button>
          </div>
          {/* One GPU holds one model, so this is never additive. Said plainly
              because the model being replaced may be the one a conversation is
              part-way through. */}
          <p className="ct__models-note">
            {busy
              ? "Weights are paging in; a large model takes a few minutes."
              : resident
                ? `Serving ${resident.label}. Loading another replaces it.`
                : "Nothing loaded — chat and benchmarks have nothing to answer with."}
          </p>
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
              ? "Key set — type a new one to replace it"
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
                  unavailable — using{" "}
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
