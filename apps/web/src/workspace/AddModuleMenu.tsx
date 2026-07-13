import { useEffect, useRef, useState } from "react";
import { MODULES } from "./registry";

// A single "+" trigger that opens a dropdown of every registered module. Picking
// one adds it to the canvas. The list is driven by the registry, so a new module
// shows up here automatically. Closes on outside-click, Escape, or selection.
export function AddModuleMenu({
  onAdd,
}: {
  onAdd: (moduleId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="add-menu" ref={ref}>
      <button
        type="button"
        className="btn add-menu__trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Add a module"
        onClick={() => setOpen((v) => !v)}
      >
        +
      </button>
      {open && (
        // A simple disclosure of buttons, not an ARIA menu widget: it has no
        // arrow-key roving focus, so claiming role="menu" would over-promise.
        // Native buttons stay focusable and Tab-navigable.
        <ul className="add-menu__list">
          {MODULES.map((def) => (
            <li key={def.id}>
              <button
                type="button"
                className="add-menu__item"
                onClick={() => {
                  onAdd(def.id);
                  setOpen(false);
                }}
              >
                {def.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
