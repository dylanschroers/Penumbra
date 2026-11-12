// Persists the collapsed set, so new sections start open.

import { migrateStorageKey, STORAGE_NAMESPACE } from "@penumbra/shared";
import { type ReactNode, useCallback, useState } from "react";

const STORAGE_KEY = `${STORAGE_NAMESPACE}.lab.collapsed.v1`;
const LEGACY_STORAGE_KEY = "penumbra.lab.collapsed";

function readCollapsed(): Set<string> {
  migrateStorageKey(LEGACY_STORAGE_KEY, STORAGE_KEY);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export interface SectionState {
  isOpen(id: string): boolean;
  toggle(id: string): void;
}

export function useSections(): SectionState {
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }, []);

  return {
    isOpen: (id) => !collapsed.has(id),
    toggle,
  };
}

/** `meta` stays visible when closed. */
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
