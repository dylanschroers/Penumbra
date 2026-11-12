import { useEffect, useRef, useState } from "react";
import { getModule } from "../workspace/registry";
import { isSplitView } from "../workspace/types";
import { MODULE_ICONS } from "./icons";
import { ModuleSlot, type ModuleView } from "./ModuleSlot";

// Collapsed to a handle; hover or pin opens the tray of open modules plus a
// "+" card.
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
  openIds: string[];
  addableIds: string[];
  activeIds: string[];
  /**
   * The dock claims the host node (see ModuleSlot); views render in AppShell
   * under their Provider.
   */
  hostFor: (id: string, view: ModuleView) => HTMLElement;
  onExpand: (id: string) => void;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onModuleDragStart: (id: string) => void;
  onModuleDragEnd: () => void;
  /** Shell-owned so it clears on drop even if dragend never fires. */
  dragActive: boolean;
  /**
   * The shell renders compact views, so it needs to know when nobody can see
   * them.
   */
  onTrayOpenChange: (open: boolean) => void;
}) {
  const [pinned, setPinned] = useState(false);
  // In React state, not CSS `:hover`: `:hover` re-evaluates when the layout
  // moves under a still pointer but mouseenter doesn't, so the two disagreed and
  // showed an empty tray.
  const [hovered, setHovered] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);

  // A pinned tray still closes on an outside click.
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

  // Native events, not React's: module views are portalled in from AppShell, so
  // React reports a leave when the pointer enters them, which unmounts the view
  // and loops.
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    // The dock animates in, so the pointer may already be on it.
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

  // Visibility answers only to the pointer, not to expand/collapse.
  function handleExpand(id: string) {
    (document.activeElement as HTMLElement | null)?.blur();
    onExpand(id);
  }

  const available = addableIds.filter((id) => !openIds.includes(id));

  // Drives both the `dock--open` class and whether compact views render, so
  // shown and mounted never disagree.
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
              {/* A split module's compact view stays here while expanded; a single-view module's one instance moves to the focus pane, so the card says where it went. */}
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

  // In-card, not a popover: the card and tray clip overflow, and staying inside
  // keeps the hover-opened tray open.
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
          <ul className="dock-add__menu">
            {available.map((id) => {
              const def = getModule(id);
              if (!def) return null;
              return (
                <li key={id}>
                  {/* Dragging onto the desk opens it expanded (handled in AppShell). */}
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
