import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isFsAvailable } from "../fs/fsClient";
import { AgentModule } from "../modules/agent/AgentModule";
import { getModule, MODULES } from "../workspace/registry";
import { isSplitView } from "../workspace/types";
import { FileSidebar } from "./FileSidebar";
import { MODULE_ICONS } from "./icons";
import { Logo } from "./Logo";
import { ModuleDock } from "./ModuleDock";
import { ModuleSlot, type ModuleView } from "./ModuleSlot";
import { ServerStatus } from "./ServerStatus";
import { loadSession, saveSession } from "./session";
import "./shell.css";

// Prototype shell (see the UI-overhaul discussion). Flow:
//   intro → the logo sits large in the screen's center with a tagline; click it
//           to enter.
//   app   → the same logo element eases up to settle in the top-middle (a CSS
//           transition on its fixed position + scale — see .shell-logo), the
//           intro text fades out, and the assistant/dock mount in: the chat card
//           rises open from the vertical center.
// The logo and intro are always mounted so the browser can transition the logo
// between the two states; the app content mounts only once launched (mounting
// the assistant early would start its status poll before the user enters).
// The registry and module components are reused untouched — this is pure shell.
//
// The settled logo is the home button (and, later, the funnel target). Its two
// gestures:
//   click → toggle the workspace like a window min/max button: if anything is
//           showing, minimize everything away to a bare canvas; if nothing is
//           showing, restore whatever was last open. Open state (modules, focus)
//           is kept in React across the minimize, so restore brings it all back.
//   hold  → return all the way to the launcher (the old click behavior).
// A long-press timer distinguishes the two; see the pointer handlers below.

// How long the logo must be held (ms) before the press counts as "return to
// launcher" rather than a minimize/restore click.
const HOLD_MS = 500;

// Modules the dock can offer. The assistant is the shell's spine, so it isn't a
// dock card. A first-run dock is empty and the user adds modules from this set
// via the dock's "+" card; after that it reopens with whatever was last open
// (see loadSession).
const ADDABLE_MODULE_IDS = MODULES.map((m) => m.id).filter(
  (id) => id !== "agent",
);

export function AppShell() {
  // Read once, lazily: both fields come out of the same record, and the loader
  // parses and validates.
  const [restored] = useState(() => loadSession(ADDABLE_MODULE_IDS));

  const [launched, setLaunched] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(restored.focused);
  // Modules currently open in the dock, restored from the last session.
  const [openModuleIds, setOpenModuleIds] = useState<string[]>(restored.open);
  // A module being dragged from the dock's add-list onto the workspace centre,
  // and whether the pointer is currently over the drop zone.
  const [draggingModule, setDraggingModule] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  // File rail collapsed state, owned here so the logo's minimize can close it.
  // Starts collapsed to a thin rail (its old internal default).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  // Workspace minimized: the panels collapse to their most compact form (rail
  // closed, module dropped to the dock, chat shrunk to just its input bar) but
  // everything stays mounted. The pre-minimize layout is snapshotted so a
  // restore brings back exactly what was last open.
  const [minimized, setMinimized] = useState(false);
  const restoreSnapshot = useRef<{
    focusedId: string | null;
    sidebarCollapsed: boolean;
  } | null>(null);

  // Whether the logo is currently held down — drives the fill-up feedback on the
  // mark (see .shell-logo--holding) while the hold-to-launcher timer runs.
  const [holding, setHolding] = useState(false);

  // Whether the dock's tray is showing, reported up by ModuleDock. The compact
  // views are rendered here, not in the dock, so this is where they can be left
  // unrendered while the tray is shut.
  const [dockOpen, setDockOpen] = useState(false);

  // Write the workspace back on every change. Not gated on `launched`: the set
  // survives a return to the launcher in React already, and persisting it there
  // too keeps the stored record equal to the live one at all times.
  useEffect(() => {
    saveSession({ open: openModuleIds, focused: focusedId });
  }, [openModuleIds, focusedId]);

  // Modules are rendered *here*, and portalled into the slots that show them.
  //
  // Every module view renders into its own detached <div> — its "host" — which
  // ModuleSlot then claims into the dock card or the focus pane. Rendering the
  // views here rather than in place is what lets a split module's Provider (a
  // React ancestor of both views) sit above them while their DOM lives in two
  // different parts of the shell.
  //
  // Two arrangements, keyed off the registry entry:
  //   split  — Provider wraps a compact and an expanded view, each with its own
  //            host, both live at once: the dock card keeps a working summary
  //            while the module is expanded.
  //   single — one view with one host that *moves* between the dock and the
  //            centre. Moving a DOM node doesn't remount the React tree
  //            portalled into it, so the module keeps its state on the trip.
  //
  // Either way a module mounts once. Rendering <Component /> in both places
  // instead would mount two independent copies — two Model Labs polling /lab/*
  // on their own timers, each holding half of the user's form.
  const hosts = useRef(new Map<string, HTMLDivElement>());

  function moduleHost(id: string, view: ModuleView): HTMLDivElement {
    const key = `${id}:${view}`;
    let host = hosts.current.get(key);
    if (!host) {
      host = document.createElement("div");
      // Layout-transparent: the host generates no box, so a view lays out
      // inside a slot exactly as it would as a direct child, and the existing
      // card CSS needs no changes.
      host.style.display = "contents";
      hosts.current.set(key, host);
    }
    return host;
  }

  // Long-press bookkeeping for the logo. `holdTimer` fires the launcher return;
  // `didHold` tells the trailing click to stand down once a hold has handled it.
  const holdTimer = useRef<number | null>(null);
  const didHold = useRef(false);

  function endHold() {
    setHolding(false);
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }

  // Press start: only arm the hold-to-launcher timer once in the app; in the
  // intro the logo is a plain "enter" button with no hold gesture.
  function onLogoPointerDown() {
    if (!launched) return;
    didHold.current = false;
    setHolding(true);
    if (holdTimer.current !== null) clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      didHold.current = true;
      holdTimer.current = null;
      setHolding(false);
      // Back to the launcher, but preserve the whole workspace (open modules,
      // focus, minimize, rail) in React state so clicking the logo to re-enter
      // restores exactly where things were — like min/max, not a reset.
      setLaunched(false);
    }, HOLD_MS);
  }

  function onLogoClick() {
    // A completed hold already acted; swallow the click the pointer-up emits.
    if (didHold.current) {
      didHold.current = false;
      return;
    }
    if (!launched) {
      // Re-enter, restoring whatever was open (state was preserved on the way
      // out). On the very first launch this is all still at its empty defaults.
      setLaunched(true);
      return;
    }
    // In the app the logo is a min/max toggle for the workspace chrome.
    if (minimized) {
      // Restore: reapply whatever was open before we minimized.
      const snap = restoreSnapshot.current;
      if (snap) {
        setFocusedId(snap.focusedId);
        setSidebarCollapsed(snap.sidebarCollapsed);
      }
      setMinimized(false);
    } else {
      // Minimize: remember the layout, then collapse each piece to compact form.
      restoreSnapshot.current = { focusedId, sidebarCollapsed };
      setFocusedId(null);
      setSidebarCollapsed(true);
      setMinimized(true);
    }
  }

  function addModule(id: string) {
    setOpenModuleIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  function removeModule(id: string) {
    setOpenModuleIds((prev) => prev.filter((x) => x !== id));
    // If the removed module was center-focused, drop it back out of focus too.
    setFocusedId((curr) => (curr === id ? null : curr));
    // Drop the module's hosts: closing is meant to discard it, so re-adding one
    // gets fresh nodes and therefore a fresh instance. React still holds its own
    // references while it unmounts the portals on the next render.
    for (const key of hosts.current.keys()) {
      if (key.startsWith(`${id}:`)) hosts.current.delete(key);
    }
  }

  // Open a module in the centre: add it to the dock's open set and focus it.
  // Used by the add-list drag-to-workspace gesture.
  function openInWorkspace(id: string) {
    setMinimized(false);
    addModule(id);
    setFocusedId(id);
  }

  const focused = launched && focusedId ? getModule(focusedId) : null;

  const minimized_ = launched && minimized;
  const dragged = draggingModule ? getModule(draggingModule) : null;

  // Mirror the file rail's width with a spacer (see .shell__rail-spacer) so the
  // chat stays centred on the viewport whether the rail is expanded or collapsed.
  // The rail is wide when it shows content: expanded on desktop, or the
  // desktop-only notice on the web build. The mirror only applies when the chat
  // is the only thing centre-stage; once a module is focused (shell--focused) the
  // spacer collapses so the module gets the full width instead of being squeezed.
  const railWide = !isFsAvailable || !sidebarCollapsed;

  return (
    <div
      className={`shell ${launched ? "shell--app" : "shell--intro"}${
        minimized_ ? " shell--min" : ""
      }${railWide ? " shell--rail-wide" : ""}${
        focused ? " shell--focused" : ""
      }`}
    >
      {/* One persistent logo: it transitions between the intro's centered/large
          position and the app's top-middle resting spot. In the app it's the
          home button — click to minimize/restore the workspace, hold to return
          to the launcher (see the pointer handlers). */}
      <button
        type="button"
        className={`shell-logo${holding ? " shell-logo--holding" : ""}`}
        onPointerDown={onLogoPointerDown}
        onPointerUp={endHold}
        onPointerLeave={endHold}
        onClick={onLogoClick}
        aria-label={
          !launched
            ? "Enter Penumbra"
            : minimized_
              ? "Restore workspace"
              : "Minimize workspace"
        }
        title={launched ? "Hold to return to the launcher" : undefined}
      >
        <Logo size={160} />
      </button>

      <div className="shell__intro" aria-hidden={launched}>
        <p className="shell__tagline">Penumbra</p>
        <p className="shell__hint">Click to begin</p>
      </div>

      {launched && (
        <>
          {/* The modules themselves. A flat, keyed list — opening or closing one
              must not disturb the others, and must never reach the shell body
              below (nesting each Provider around the rest of the tree would
              remount the sidebar and the assistant on every add).

              Mounted only while launched, so returning to the launcher still
              tears them down rather than leaving them polling behind the
              intro. */}
          {openModuleIds.map((id) => {
            const def = getModule(id);
            if (!def) return null;

            if (!isSplitView(def)) {
              const Component = def.Component;
              return createPortal(<Component />, moduleHost(id, "single"), id);
            }

            // The Provider owns the state both views read; each view is
            // portalled to its own slot, and rendered only while it can be seen
            // — the compact view while the dock's tray is open, the expanded one
            // while focused. Both are pure projections of the Provider, so
            // dropping and rebuilding them loses nothing; the Provider itself
            // stays mounted and keeps the module live either way.
            const { Provider, Compact, Expanded } = def;
            return (
              <Provider key={id}>
                {dockOpen &&
                  createPortal(<Compact />, moduleHost(id, "compact"))}
                {focusedId === id &&
                  createPortal(<Expanded />, moduleHost(id, "expanded"))}
              </Provider>
            );
          })}

          <ServerStatus />

          <div className="shell__body">
            <FileSidebar
              collapsed={sidebarCollapsed}
              onCollapsedChange={setSidebarCollapsed}
            />

            <div
              className={`shell__stage${focused ? " shell__stage--focused" : ""}`}
            >
              {/* Both columns always render so grid-template-columns can animate
                  the swap; the focus column collapses to 0fr when unfocused. */}
              <section className="shell__focus">
                {focused && (
                  <div className="focus-card">
                    <div className="focus-card__bar">
                      <span className="focus-card__title">
                        {MODULE_ICONS[focused.id]} {focused.title}
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => setFocusedId(null)}
                        aria-label="Return to dock"
                      >
                        ↙ Dock
                      </button>
                    </div>
                    <ModuleSlot
                      className="focus-card__body"
                      host={moduleHost(
                        focused.id,
                        isSplitView(focused) ? "expanded" : "single",
                      )}
                    />
                  </div>
                )}
              </section>

              <section className="shell__assistant">
                <div className="assistant-card">
                  <AgentModule />
                </div>
              </section>

              {/* Shown only while dragging a module out of the dock's add-list:
                  drop here to open it expanded in the centre. */}
              {dragged && (
                // biome-ignore lint/a11y/noStaticElementInteractions: transient drag-and-drop drop zone with no interactive ARIA role; the same action is available by clicking the add-list item.
                <div
                  className={`shell__dropzone${
                    dropActive ? " shell__dropzone--over" : ""
                  }`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    if (!dropActive) setDropActive(true);
                  }}
                  onDragLeave={() => setDropActive(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id =
                      e.dataTransfer.getData("text/plain") || draggingModule;
                    if (id) openInWorkspace(id);
                    setDraggingModule(null);
                    setDropActive(false);
                  }}
                >
                  <span className="shell__dropzone-inner">
                    {MODULE_ICONS[dragged.id]} Open {dragged.title} here
                  </span>
                </div>
              )}
            </div>

            {/* Balances the file rail so the stage — and the centred chat —
                stays centred on the viewport regardless of the rail's width. */}
            <div className="shell__rail-spacer" aria-hidden="true" />
          </div>

          <ModuleDock
            openIds={openModuleIds}
            addableIds={ADDABLE_MODULE_IDS}
            focusedId={focusedId}
            hostFor={moduleHost}
            onExpand={(id) => {
              // Expanding a module is the opposite of minimized — leave that
              // state so the chat isn't left collapsed under a focused module.
              setMinimized(false);
              setFocusedId(id);
            }}
            onAdd={addModule}
            onRemove={removeModule}
            dragActive={draggingModule !== null}
            onTrayOpenChange={setDockOpen}
            onModuleDragStart={setDraggingModule}
            onModuleDragEnd={() => {
              setDraggingModule(null);
              setDropActive(false);
            }}
          />
        </>
      )}
    </div>
  );
}
