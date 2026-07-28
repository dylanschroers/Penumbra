// Collapsible sections for the Model Lab. The lab stacks tall panels — two file
// libraries, a dataset preview, forms, a score table — and only one or two
// matter at a time, so each folds away behind its header.
//
// What's persisted is the *collapsed* set, not the open one: a section the user
// has never touched is open, so adding a section later doesn't silently start it
// hidden.

import { type ReactNode, useCallback, useState } from "react";

const STORAGE_KEY = "penumbra.lab.collapsed";

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [],
    );
  } catch {
    // Unavailable (SSR/tests) or corrupt — start with everything open.
    return new Set();
  }
}

export interface SectionState {
  isOpen(id: string): boolean;
  toggle(id: string): void;
}

/** Which sections are folded away, remembered across launches. */
export function useSections(): SectionState {
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Not being able to remember it is no reason to refuse the toggle.
      }
      return next;
    });
  }, []);

  return {
    isOpen: (id) => !collapsed.has(id),
    toggle,
  };
}

/**
 * One titled, foldable block. `meta` is the line that stays visible when the
 * section is closed — a count, a state — so a folded section still says whether
 * it holds anything worth opening.
 */
export function Section({
  id,
  title,
  meta,
  state,
  children,
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  state: SectionState;
  children: ReactNode;
}) {
  const open = state.isOpen(id);
  return (
    <section
      className={`lab__section ${open ? "lab__section--open" : "lab__section--closed"}`}
    >
      <button
        type="button"
        className="lab__section-head"
        aria-expanded={open}
        onClick={() => state.toggle(id)}
      >
        <span className="lab__section-caret" aria-hidden="true">
          ▾
        </span>
        <span className="lab__section-title">{title}</span>
        {meta !== undefined && meta !== null && (
          <span className="lab__section-meta">{meta}</span>
        )}
      </button>
      {open && <div className="lab__section-body">{children}</div>}
    </section>
  );
}
