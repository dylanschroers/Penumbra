import { useEffect, useRef, useState } from "react";
import { getModule } from "../workspace/registry";
import { MODULE_ICONS } from "./icons";

// The bottom dock. Collapsed to a thin handle; hovering (or pinning) expands the
// tray. The tray holds the modules the user has opened plus a trailing "+" card
// that adds another from the registry — so the dock starts empty and grows only
// as the user asks for modules. Each open card can expand into the center focus
// pane or be closed back out of the dock.
export function ModuleDock({
  openIds,
  addableIds,
  focusedId,
  onExpand,
  onAdd,
  onRemove,
  onModuleDragStart,
  onModuleDragEnd,
  dragActive,
}: {
  /** Modules currently open in the dock, in insertion order. */
  openIds: string[];
  /** Every module the dock is allowed to offer (registry minus the assistant). */
  addableIds: string[];
  focusedId: string | null;
  onExpand: (id: string | null) => void;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  /** An add-list item started being dragged toward the workspace. */
  onModuleDragStart: (id: string) => void;
  /** The add-list drag ended (dropped or cancelled). */
  onModuleDragEnd: () => void;
  /** A module is mid-drag from the add-list. Owned by the shell so it clears on
   *  drop even if the source's dragend never fires (the dropped item unmounts
   *  once it's open); keeps the tray open while dragging out toward the centre. */
  dragActive: boolean;
}) {
  const [pinned, setPinned] = useState(false);
  // `stowed` forces the tray shut right after expanding a module, so it tucks
  // back down even while the pointer is still over the dock (hover alone would
  // hold it open). Cleared when the pointer leaves, so the next hover reopens it.
  const [stowed, setStowed] = useState(false);

  function handleExpand(id: string | null) {
    setPinned(false);
    setStowed(true);
    (document.activeElement as HTMLElement | null)?.blur();
    onExpand(id);
  }

  const available = addableIds.filter((id) => !openIds.includes(id));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: onMouseLeave only resets the dock's own hover-collapse bookkeeping; it's not a user-facing control.
    <div
      className={`dock${pinned || dragActive ? " dock--pinned" : ""}${
        stowed ? " dock--stowed" : ""
      }`}
      onMouseLeave={() => setStowed(false)}
    >
      <div className="dock__tray">
        {openIds.map((id) => {
          const def = getModule(id);
          if (!def) return null;
          const Component = def.Component;
          const active = focusedId === id;
          return (
            <div
              key={id}
              className={`dock-card${active ? " dock-card--active" : ""}`}
            >
              <div className="dock-card__bar">
                <span className="dock-card__title">
                  {MODULE_ICONS[id]} {def.title}
                </span>
                <div className="dock-card__actions">
                  <button
                    type="button"
                    className="dock-card__btn"
                    onClick={() => handleExpand(active ? null : id)}
                    aria-label={
                      active
                        ? `Return ${def.title} to dock`
                        : `Expand ${def.title} to center`
                    }
                    title={active ? "Return to dock" : "Expand to center"}
                  >
                    {active ? "▣" : "⤢"}
                  </button>
                  <button
                    type="button"
                    className="dock-card__btn"
                    onClick={() => onRemove(id)}
                    aria-label={`Close ${def.title}`}
                    title="Close module"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="dock-card__body">
                <Component />
              </div>
            </div>
          );
        })}

        <AddModuleCard
          available={available}
          onAdd={onAdd}
          onDragStart={onModuleDragStart}
          onDragEnd={onModuleDragEnd}
        />
      </div>
      <button
        type="button"
        className="dock__handle"
        onClick={() => {
          setStowed(false);
          setPinned((p) => !p);
        }}
        aria-expanded={pinned}
        aria-label={pinned ? "Collapse modules" : "Expand modules"}
      >
        <span className="dock__grip" />
        <span className="dock__label">Modules</span>
      </button>
    </div>
  );
}

// The trailing "blank module": a card-shaped "+" that opens a chooser of the
// modules not already in the dock. Closes on outside-click, Escape, or a pick.
function AddModuleCard({
  available,
  onAdd,
  onDragStart,
  onDragEnd,
}: {
  available: string[];
  onAdd: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
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

  const allOpen = available.length === 0;

  // The chooser renders *inside* the card (not a floating popover): the card and
  // the tray both clip overflow, so an absolutely-positioned popover above the
  // card would be invisible. Keeping it in-card also means the pointer never
  // leaves the tray, so the hover-revealed tray stays open while picking.
  return (
    <div className="dock-card dock-card--add" ref={ref}>
      {open && !allOpen ? (
        <>
          <div className="dock-card__bar">
            <span className="dock-card__title">Add module</span>
            <div className="dock-card__actions">
              <button
                type="button"
                className="dock-card__btn"
                onClick={() => setOpen(false)}
                aria-label="Cancel"
                title="Cancel"
              >
                ✕
              </button>
            </div>
          </div>
          {/* A simple disclosure of buttons, not an ARIA menu widget (no roving
              focus), so native buttons stay focusable and Tab-navigable. */}
          <ul className="dock-add__menu">
            {available.map((id) => {
              const def = getModule(id);
              if (!def) return null;
              return (
                <li key={id}>
                  {/* Click adds the module to the dock; dragging it onto the
                      workspace centre opens it expanded (handled in AppShell). */}
                  <button
                    type="button"
                    className="dock-add__item"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", id);
                      e.dataTransfer.effectAllowed = "copy";
                      onDragStart(id);
                    }}
                    onDragEnd={onDragEnd}
                    onClick={() => {
                      onAdd(id);
                      setOpen(false);
                    }}
                  >
                    {MODULE_ICONS[id]} {def.title}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <button
          type="button"
          className="dock-add"
          onClick={() => setOpen(true)}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label="Add a module"
          disabled={allOpen}
          title={allOpen ? "All modules open" : "Add a module"}
        >
          <span className="dock-add__plus">+</span>
          <span className="dock-add__label">
            {allOpen ? "All modules open" : "Add module"}
          </span>
        </button>
      )}
    </div>
  );
}
