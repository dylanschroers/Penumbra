import { useEffect, useRef, useState } from "react";
import { getModule } from "../workspace/registry";
import { isSplitView } from "../workspace/types";
import { MODULE_ICONS } from "./icons";
import { ModuleSlot, type ModuleView } from "./ModuleSlot";

// The bottom dock. Collapsed to a thin handle; hovering (or pinning) expands the
// tray. The tray holds the modules the user has opened plus a trailing "+" card
// that adds another from the registry — so the dock starts empty and grows only
// as the user asks for modules. Each open card can expand into the center focus
// pane or be closed back out of the dock.
export function ModuleDock({
  openIds,
  addableIds,
  activeIds,
  hostFor,
  onExpand,
  onAdd,
  onRemove,
  onModuleDragStart,
  onModuleDragEnd,
  dragActive,
  onTrayOpenChange,
}: {
  /** Modules currently open in the dock, in insertion order. */
  openIds: string[];
  /** Every module the dock is allowed to offer (registry minus the assistant). */
  addableIds: string[];
  /** Modules currently showing as a window on the desk. */
  activeIds: string[];
  /** The shell's host node for one of a module's views. The dock shows a module
   *  by claiming that node (see ModuleSlot) rather than rendering it here — the
   *  views are rendered in AppShell, under the state their Provider owns. */
  hostFor: (id: string, view: ModuleView) => HTMLElement;
  /** Toggle a module's desk window (open centred / close back to the dock). */
  onExpand: (id: string) => void;
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
  /** Reports whether the tray is actually showing. The shell renders the compact
   *  views, so it is the one that can stop rendering them while nobody can see
   *  them — see the trayOpen note below. */
  onTrayOpenChange: (open: boolean) => void;
}) {
  const [pinned, setPinned] = useState(false);
  // Hover lives here, not in a CSS `:hover` rule, because React has to know it
  // to decide what to render (see trayOpen below) and the two cannot be allowed
  // to disagree. They did: `:hover` re-evaluates when the layout moves under a
  // still pointer, but mouseenter only fires when the *pointer* crosses a
  // boundary. So the dock rising into place under a resting cursor opened the
  // tray in CSS while React still believed it was shut — a tray sitting open
  // with an empty card until you moved the pointer out and back in.
  const [hovered, setHovered] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);

  // A pinned tray also closes on a click anywhere outside the dock — the pin
  // means "hold open while I work in here", not "stay until I find the handle
  // again".
  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (event: PointerEvent) => {
      if (dockRef.current && !dockRef.current.contains(event.target as Node)) {
        setPinned(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pinned]);

  // Native mouseenter/mouseleave, deliberately not React's onMouseEnter/Leave.
  //
  // React derives those from the *React* tree, and a module's view is portalled
  // in from AppShell — a DOM descendant of the card, but not a React one. So
  // React reports a leave the moment the pointer crosses into the module's own
  // content, which here would unmount that content, put the pointer over an
  // empty card, read as a re-enter, remount... a flicker loop as fast as the
  // browser delivers events. The native events follow the DOM tree, where the
  // portalled content is genuinely inside, so the crossing is a no-op.
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    // The dock animates in, so the pointer may already be resting on it before
    // any event could fire. Seed from the CSS truth once, then track events.
    if (el.matches(":hover")) setHovered(true);
    const onEnter = () => setHovered(true);
    const onLeave = () => setHovered(false);
    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mouseenter", onEnter);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  // Expanding a module (or sending it back) deliberately leaves the tray alone:
  // the dock's visibility answers to the pointer, not to what the module is
  // doing. It used to force itself shut here, which read as the dock flinching
  // away every time the expand toggle was pressed.
  function handleExpand(id: string) {
    (document.activeElement as HTMLElement | null)?.blur();
    onExpand(id);
  }

  const available = addableIds.filter((id) => !openIds.includes(id));

  // Whether the tray is on screen: the pointer is on the dock, or it's held open
  // by a pin or an in-flight drag. The single source of truth — it drives both
  // the `dock--open` class that animates the tray and whether the shell renders
  // the compact views at all, so what is shown and what is mounted can never
  // disagree.
  //
  // A split module's compact view is a pure projection of its Provider, so it
  // costs nothing to drop while the tray is shut and nothing to rebuild when it
  // opens — which is why state lives in the Provider rather than the view.
  const trayOpen = hovered || pinned || dragActive;

  useEffect(() => {
    onTrayOpenChange(trayOpen);
  }, [trayOpen, onTrayOpenChange]);

  return (
    <div ref={dockRef} className={`dock${trayOpen ? " dock--open" : ""}`}>
      <div className="dock__tray">
        {openIds.map((id) => {
          const def = getModule(id);
          if (!def) return null;
          const active = activeIds.includes(id);
          return (
            <div
              key={id}
              className={`dock-card${active ? " dock-card--active" : ""}`}
            >
              {/* The bar doubles as a drag handle: drag the card onto the desk
                  to place its window there (drop position picks the snap). */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-out is a pointer shortcut; the same action is on the bar's expand button. */}
              <div
                className="dock-card__bar"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", id);
                  e.dataTransfer.effectAllowed = "copy";
                  onModuleDragStart(id);
                }}
                onDragEnd={onModuleDragEnd}
              >
                <span className="dock-card__title">
                  {MODULE_ICONS[id]} {def.title}
                </span>
                <div className="dock-card__actions">
                  <button
                    type="button"
                    className="dock-card__btn"
                    onClick={() => handleExpand(id)}
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
              {/* A split module keeps its compact view here even while expanded
                  — that view is its own instance over the same state, not the
                  module itself, so both can be on screen at once.

                  A single-view module has only the one instance, and the focus
                  pane holds it while expanded, so the card says where it went
                  rather than rendering an empty body. */}
              {isSplitView(def) ? (
                <ModuleSlot
                  className="dock-card__body"
                  host={hostFor(id, "compact")}
                />
              ) : active ? (
                <p className="dock-card__away">Expanded to the centre</p>
              ) : (
                <ModuleSlot
                  className="dock-card__body"
                  host={hostFor(id, "single")}
                />
              )}
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
        onClick={() => setPinned((p) => !p)}
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
