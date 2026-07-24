import { useRef, useState } from "react";
import { isFsAvailable } from "../fs/fsClient";
import { AgentModule } from "../modules/agent/AgentModule";
import { getModule, MODULES } from "../workspace/registry";
import { FileSidebar } from "./FileSidebar";
import { MODULE_ICONS } from "./icons";
import { Logo } from "./Logo";
import { ModuleDock } from "./ModuleDock";
import { ServerStatus } from "./ServerStatus";
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
// dock card. The dock starts empty — the user adds modules from this set via the
// dock's "+" card.
const ADDABLE_MODULE_IDS = MODULES.map((m) => m.id).filter(
  (id) => id !== "agent",
);

export function AppShell() {
  const [launched, setLaunched] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // Modules currently open in the dock; nothing is open on launch.
  const [openModuleIds, setOpenModuleIds] = useState<string[]>([]);
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
  }

  // Open a module in the centre: add it to the dock's open set and focus it.
  // Used by the add-list drag-to-workspace gesture.
  function openInWorkspace(id: string) {
    setMinimized(false);
    addModule(id);
    setFocusedId(id);
  }

  const focused = launched && focusedId ? getModule(focusedId) : null;
  const FocusedComponent = focused?.Component;

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
                {focused && FocusedComponent && (
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
                    <div className="focus-card__body">
                      <FocusedComponent />
                    </div>
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
            onExpand={(id) => {
              // Expanding a module is the opposite of minimized — leave that
              // state so the chat isn't left collapsed under a focused module.
              setMinimized(false);
              setFocusedId(id);
            }}
            onAdd={addModule}
            onRemove={removeModule}
            dragActive={draggingModule !== null}
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
