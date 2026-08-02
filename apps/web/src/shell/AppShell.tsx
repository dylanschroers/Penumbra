import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
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
import { ResizeHandles } from "./ResizeHandles";
import { ServerStatus } from "./ServerStatus";
import {
  loadSession,
  type SnapZone,
  saveSession,
  type WindowPlacement,
} from "./session";
import { TitleBar } from "./TitleBar";
import {
  clampAllToDesk,
  clampToDesk,
  dropZoneForCard,
  isDeskMeasurable,
  snapZoneForDrag,
} from "./windowing";
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
//
// The workspace centre is the *desk*: modules open there as windows that can be
// dragged by their bar, snapped to the left/right half or maximized (Windows
// style, with gaps), or left floating. Dragging a card out of the bottom dock
// drops it onto the desk at the pointer's zone. The chat is the right column
// and collapses to a slim tab on the screen edge.
//
// The settled logo is the home button. Its two gestures:
//   click → toggle the workspace like a window min/max button: if anything is
//           showing, minimize everything away to a bare canvas; if nothing is
//           showing, restore whatever was last open. Open state (modules,
//           windows) is kept in React across the minimize, so restore brings it
//           all back.
//   hold  → return all the way to the launcher (the old click behavior).
// A long-press timer distinguishes the two; see the pointer handlers below.

// How long the logo must be held (ms) before the press counts as "return to
// launcher" rather than a minimize/restore click.
const HOLD_MS = 500;

// How long a closing window stays rendered for its fade-out (matches the
// win-close animation in shell.css).
const CLOSE_MS = 200;

// Modules the dock can offer. The assistant is the shell's spine, so it isn't a
// dock card. A first-run dock is empty and the user adds modules from this set
// via the dock's "+" card; after that it reopens with whatever was last open
// (see loadSession).
const ADDABLE_MODULE_IDS = MODULES.map((m) => m.id).filter(
  (id) => id !== "agent",
);

// Caption for the dock-drag drop preview.
const ZONE_LABEL: Record<SnapZone, string> = {
  left: "on the left",
  right: "on the right",
  "top-left": "top left",
  "top-right": "top right",
  "bottom-left": "bottom left",
  "bottom-right": "bottom right",
  max: "maximized",
  center: "here",
};

export function AppShell() {
  // Read once, lazily: both fields come out of the same record, and the loader
  // parses and validates.
  const [restored] = useState(() => loadSession(ADDABLE_MODULE_IDS));

  const [launched, setLaunched] = useState(false);
  // Modules currently open in the dock, restored from the last session.
  const [openModuleIds, setOpenModuleIds] = useState<string[]>(restored.open);
  // Module windows on the desk, in stacking order (last = front).
  const [windows, setWindows] = useState<WindowPlacement[]>(restored.windows);
  // Windows playing their close fade; kept rendered (and kept "away" from
  // their dock card) until the animation ends.
  const [closing, setClosing] = useState<WindowPlacement[]>([]);
  // A module being dragged from the dock onto the desk, and which snap zone
  // the pointer is currently over.
  const [draggingModule, setDraggingModule] = useState<string | null>(null);
  const [dropZone, setDropZone] = useState<SnapZone | null>(null);
  // File rail collapsed state, owned here so the logo's minimize can close it.
  // Starts collapsed to a thin rail (its old internal default).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  // Chat panel collapsed to a slim tab on the right edge, leaving the whole
  // desk to the windows. Independent of the logo's minimize.
  const [chatCollapsed, setChatCollapsed] = useState(false);
  // Workspace minimized: the panels collapse to their most compact form (rail
  // closed, windows dropped to the dock, chat shrunk to just its input bar) but
  // everything stays mounted. The pre-minimize layout is snapshotted so a
  // restore brings back exactly what was last open.
  const [minimized, setMinimized] = useState(false);
  const restoreSnapshot = useRef<{
    windows: WindowPlacement[];
    sidebarCollapsed: boolean;
  } | null>(null);

  // Whether the logo is currently held down — drives the fill-up feedback on the
  // mark (see .shell-logo--holding) while the hold-to-launcher timer runs.
  const [holding, setHolding] = useState(false);

  // Whether the dock's tray is showing, reported up by ModuleDock. The compact
  // views are rendered here, not in the dock, so this is where they can be left
  // unrendered while the tray is shut.
  const [dockOpen, setDockOpen] = useState(false);

  const deskRef = useRef<HTMLDivElement>(null);

  // A window mid-drag by its bar: which one, where it was grabbed, and the
  // desk's rect (measured once at grab — the desk doesn't move during a drag).
  const winDrag = useRef<{
    id: string;
    grabX: number;
    grabY: number;
    deskRect: DOMRect;
  } | null>(null);
  // The snap zone the dragged window would land in if released now.
  const [snapHint, setSnapHint] = useState<SnapZone | null>(null);
  // Whether a window is mid-drag by its bar. State, not just the ref above, so
  // the save effect below re-runs when it clears.
  const [barDragging, setBarDragging] = useState(false);

  // Write the workspace back on every change. Not gated on `launched`: the set
  // survives a return to the launcher in React already, and persisting it there
  // too keeps the stored record equal to the live one at all times.
  //
  // Held off while a window is being dragged, though: a drag rewrites `windows`
  // on every pointermove, and localStorage.setItem is a synchronous, disk-backed
  // write — one per move event, each preceded by a full JSON.stringify. Only
  // where the window lands is worth storing, and `barDragging` is a dependency
  // so clearing it on release triggers exactly that one write.
  useEffect(() => {
    if (barDragging) return;
    saveSession({ open: openModuleIds, windows });
  }, [openModuleIds, windows, barDragging]);

  // Free windows are positioned in desk pixels, so a desk that shrinks (the
  // chat opening, the app window resizing) can strand them past the edge where
  // the desk clips them. Pull them back inside whenever the desk resizes.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: `launched` isn't read in the body, but the desk only mounts after launch — the effect must re-run then to find the node and attach the observer.
  useEffect(() => {
    const desk = deskRef.current;
    if (!desk) return;
    const ro = new ResizeObserver(() => {
      const rect = desk.getBoundingClientRect();
      // Mid-collapse (the 0fr column animating) the desk is momentarily tiny;
      // clamping against that would pile every window into the corner.
      if (!isDeskMeasurable(rect)) return;
      setWindows((prev) => clampAllToDesk(prev, rect));
    });
    ro.observe(desk);
    return () => ro.disconnect();
  }, [launched]);

  // Modules are rendered *here*, and portalled into the slots that show them.
  //
  // Every module view renders into its own detached <div> — its "host" — which
  // ModuleSlot then claims into the dock card or a desk window. Rendering the
  // views here rather than in place is what lets a split module's Provider (a
  // React ancestor of both views) sit above them while their DOM lives in two
  // different parts of the shell.
  //
  // Two arrangements, keyed off the registry entry:
  //   split  — Provider wraps a compact and an expanded view, each with its own
  //            host, both live at once: the dock card keeps a working summary
  //            while the module is windowed.
  //   single — one view with one host that *moves* between the dock and the
  //            desk. Moving a DOM node doesn't remount the React tree portalled
  //            into it, so the module keeps its state on the trip.
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
      // windows, minimize, rail) in React state so clicking the logo to
      // re-enter restores exactly where things were — like min/max, not a
      // reset.
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
        setWindows(snap.windows);
        // A restore mid-fade must not leave the same window closing and open.
        setClosing((prev) =>
          prev.filter((c) => !snap.windows.some((w) => w.id === c.id)),
        );
        setSidebarCollapsed(snap.sidebarCollapsed);
      }
      setMinimized(false);
    } else {
      // Minimize: remember the layout, then collapse each piece to compact
      // form. Windows fade out the same way a single close does.
      restoreSnapshot.current = { windows, sidebarCollapsed };
      closeAllWindows();
      setSidebarCollapsed(true);
      setMinimized(true);
    }
  }

  function addModule(id: string) {
    setOpenModuleIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  function removeModule(id: string) {
    setOpenModuleIds((prev) => prev.filter((x) => x !== id));
    // If the removed module had a desk window, drop that too — without the
    // close fade: the hosts are discarded below, so there is nothing left to
    // show while a window faded out.
    setWindows((prev) => prev.filter((w) => w.id !== id));
    setClosing((prev) => prev.filter((w) => w.id !== id));
    // Drop the module's hosts: closing is meant to discard it, so re-adding one
    // gets fresh nodes and therefore a fresh instance. React still holds its own
    // references while it unmounts the portals on the next render.
    for (const key of hosts.current.keys()) {
      if (key.startsWith(`${id}:`)) hosts.current.delete(key);
    }
  }

  /** Open a module's window on the desk (dock ⤢, or a drag out of the dock).
   *  A window already open just moves to the requested zone and the front. */
  function openWindow(id: string, zone: SnapZone = "center") {
    setMinimized(false);
    addModule(id);
    setClosing((prev) => prev.filter((w) => w.id !== id));
    setWindows((prev) => {
      const rest = prev.filter((w) => w.id !== id);
      return [...rest, { id, zone, x: 0, y: 0, w: 0, h: 0 }];
    });
  }

  /** Fade every window out at once (the logo's minimize). */
  function closeAllWindows() {
    if (windows.length === 0) return;
    const closingNow = windows;
    setWindows([]);
    setClosing((prev) => [
      ...prev.filter((w) => !closingNow.some((c) => c.id === w.id)),
      ...closingNow,
    ]);
    window.setTimeout(() => {
      setClosing((prev) =>
        prev.filter((w) => !closingNow.some((c) => c.id === w.id)),
      );
    }, CLOSE_MS);
  }

  /** Send a window back to the dock, fading it out on the way. */
  function closeWindow(id: string) {
    const win = windows.find((w) => w.id === id);
    if (!win) return;
    setWindows((prev) => prev.filter((w) => w.id !== id));
    setClosing((prev) => [...prev.filter((w) => w.id !== id), win]);
    window.setTimeout(() => {
      setClosing((prev) => prev.filter((w) => w.id !== id));
    }, CLOSE_MS);
  }

  function toggleWindow(id: string) {
    if (windows.some((w) => w.id === id)) closeWindow(id);
    else openWindow(id, "center");
  }

  function raiseWindow(id: string) {
    setWindows((prev) => {
      const i = prev.findIndex((w) => w.id === id);
      if (i < 0 || i === prev.length - 1) return prev;
      const next = prev.slice();
      const [w] = next.splice(i, 1);
      if (!w) return prev;
      next.push(w);
      return next;
    });
  }

  function placeWindow(id: string, patch: Partial<WindowPlacement>) {
    setWindows((prev) =>
      prev.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    );
  }

  // ---- Window dragging --------------------------------------------------

  // Move/up listeners live on `window`, not the bar. Raising a window reorders
  // the keyed list, which moves the DOM node, and a moved node silently loses
  // pointer capture — the drag went dead mid-flight and the release clamp
  // never ran, leaving windows stranded past the desk edge. Document-level
  // listeners don't care what happens to the node.
  const snapHintRef = useRef<SnapZone | null>(null);

  function updateSnapHint(zone: SnapZone | null) {
    snapHintRef.current = zone;
    setSnapHint(zone);
  }

  function onWinBarPointerDown(
    e: ReactPointerEvent<HTMLDivElement>,
    id: string,
  ) {
    // Left button only, and never from the bar's buttons.
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const desk = deskRef.current;
    const card = e.currentTarget.parentElement;
    if (!desk || !card) return;
    const deskRect = desk.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    raiseWindow(id);
    // Go free at the current visual rect (a snapped window keeps its size, like
    // Windows), with the grab point staying under the cursor.
    placeWindow(id, {
      zone: null,
      x: rect.left - deskRect.left,
      y: rect.top - deskRect.top,
      w: rect.width,
      h: rect.height,
    });
    winDrag.current = {
      id,
      grabX: e.clientX - rect.left,
      grabY: e.clientY - rect.top,
      deskRect,
    };
    setBarDragging(true);

    const onMove = (ev: globalThis.PointerEvent) => {
      const drag = winDrag.current;
      if (!drag) return;
      placeWindow(drag.id, {
        x: ev.clientX - drag.deskRect.left - drag.grabX,
        y: ev.clientY - drag.deskRect.top - drag.grabY,
      });
      updateSnapHint(
        snapZoneForDrag({ x: ev.clientX, y: ev.clientY }, drag.deskRect),
      );
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      // Before the early return: a cancelled drag still has to re-enable the
      // save, or the workspace stops persisting for the rest of the session.
      setBarDragging(false);
      const drag = winDrag.current;
      if (!drag) return;
      winDrag.current = null;
      const hint = snapHintRef.current;
      updateSnapHint(null);
      if (hint) {
        placeWindow(drag.id, { zone: hint });
        return;
      }
      // Keep a free window inside the desk, measured fresh at release.
      const rect = deskRef.current?.getBoundingClientRect() ?? drag.deskRect;
      setWindows((prev) =>
        prev.map((w) => (w.id === drag.id ? clampToDesk(w, rect) : w)),
      );
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  // ---- Render --------------------------------------------------------------

  const minimized_ = launched && minimized;
  const dragged = draggingModule ? getModule(draggingModule) : null;
  // The desk is "in use" while windows are up (or fading out), and also while a
  // dock card is being dragged toward it, so the drop target has real width.
  const deskActive =
    launched &&
    (windows.length > 0 || closing.length > 0 || draggingModule !== null);
  // What the dock shows as away: windowed now, or still fading closed.
  const activeIds = [...windows, ...closing].map((w) => w.id);

  // Mirror the file rail's width with a spacer (see .shell__rail-spacer) so the
  // chat stays centred on the viewport whether the rail is expanded or collapsed.
  // The rail is wide when it shows content: expanded on desktop, or the
  // desktop-only notice on the web build. The mirror only applies when the chat
  // is the only thing centre-stage; once the desk is active (shell--focused) the
  // spacer collapses so the desk gets the full width instead of being squeezed.
  const railWide = !isFsAvailable || !sidebarCollapsed;

  function renderWindow(w: WindowPlacement, z: number, isClosing: boolean) {
    const def = getModule(w.id);
    if (!def) return null;
    const free = w.zone === null;
    return (
      <div
        key={isClosing ? `${w.id}:closing` : w.id}
        className={`win${free ? " win--free" : ` win--${w.zone}`}${
          isClosing ? " win--closing" : ""
        }`}
        style={
          free
            ? {
                zIndex: z,
                transform: `translate(${w.x}px, ${w.y}px)`,
                width: w.w,
                height: w.h,
              }
            : { zIndex: z }
        }
        onPointerDown={isClosing ? undefined : () => raiseWindow(w.id)}
      >
        <div
          className="win__bar"
          onPointerDown={
            isClosing ? undefined : (e) => onWinBarPointerDown(e, w.id)
          }
        >
          <span className="win__title">
            {MODULE_ICONS[w.id]} {def.title}
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => closeWindow(w.id)}
            aria-label={`Return ${def.title} to dock`}
          >
            ↙ Dock
          </button>
        </div>
        <ModuleSlot
          className="win__body"
          host={moduleHost(w.id, isSplitView(def) ? "expanded" : "single")}
        />
      </div>
    );
  }

  return (
    <div
      className={`shell ${launched ? "shell--app" : "shell--intro"}${
        minimized_ ? " shell--min" : ""
      }${railWide ? " shell--rail-wide" : ""}${
        deskActive ? " shell--focused" : ""
      }${launched && chatCollapsed ? " shell--chat-min" : ""}${
        isFsAvailable ? " shell--desktop" : ""
      }`}
    >
      {/* Desktop-only custom window chrome; the native decorations are off in
          tauri.conf.json, so both halves of the frame are ours: TitleBar is the
          drag strip and min/max/close, ResizeHandles the edge grips. */}
      {isFsAvailable && (
        <>
          <TitleBar />
          <ResizeHandles />
        </>
      )}

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
            // while windowed (including the close fade). Both are pure
            // projections of the Provider, so dropping and rebuilding them loses
            // nothing; the Provider itself stays mounted and keeps the module
            // live either way.
            const { Provider, Compact, Expanded } = def;
            return (
              <Provider key={id}>
                {dockOpen &&
                  createPortal(<Compact />, moduleHost(id, "compact"))}
                {activeIds.includes(id) &&
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
              className={`shell__stage${deskActive ? " shell__stage--focused" : ""}`}
            >
              {/* Both columns always render so grid-template-columns can animate
                  the swap; the desk column collapses to 0fr when idle. */}
              <section className="shell__desk" ref={deskRef}>
                {windows.map((w, i) => renderWindow(w, 10 + i, false))}
                {closing.map((w) => renderWindow(w, 9, true))}

                {/* Where a bar-dragged window would snap if released now. */}
                {snapHint && (
                  <div className={`snap-preview snap-preview--${snapHint}`} />
                )}

                {/* Shown only while dragging a module out of the dock: covers
                    the desk, tracks which zone the pointer is over, and drops
                    the window there. */}
                {dragged && (
                  // biome-ignore lint/a11y/noStaticElementInteractions: transient drag-and-drop drop zone with no interactive ARIA role; the same action is available by clicking the dock card's expand button.
                  <div
                    className="shell__dropzone"
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "copy";
                      setDropZone(
                        dropZoneForCard(
                          { x: e.clientX, y: e.clientY },
                          e.currentTarget.getBoundingClientRect(),
                        ),
                      );
                    }}
                    onDragLeave={() => setDropZone(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id =
                        e.dataTransfer.getData("text/plain") || draggingModule;
                      if (id) openWindow(id, dropZone ?? "center");
                      setDraggingModule(null);
                      setDropZone(null);
                    }}
                  >
                    {dropZone && (
                      <div className={`snap-preview snap-preview--${dropZone}`}>
                        <span className="snap-preview__label">
                          {MODULE_ICONS[dragged.id]} Open {dragged.title}{" "}
                          {ZONE_LABEL[dropZone]}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className="shell__assistant">
                <div className="assistant-card">
                  <AgentModule />
                </div>
              </section>
            </div>

            {/* Balances the file rail so the stage — and the centred chat —
                stays centred on the viewport regardless of the rail's width. */}
            <div className="shell__rail-spacer" aria-hidden="true" />
          </div>

          {/* Chat toggle, part of the fixed top-right cluster beside the
              server-status dot. Lives outside the collapsing column so it
              survives every workspace state (minimized included). */}
          <button
            type="button"
            className={`shell__chat-toggle${
              chatCollapsed ? "" : " shell__chat-toggle--open"
            }`}
            onClick={() => setChatCollapsed((c) => !c)}
            aria-pressed={!chatCollapsed}
            aria-label={
              chatCollapsed ? "Open chat panel" : "Collapse chat panel"
            }
            title={chatCollapsed ? "Open chat" : "Collapse chat"}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 3v-3h-1A1.5 1.5 0 0 1 2 9.5v-6Z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <ModuleDock
            openIds={openModuleIds}
            addableIds={ADDABLE_MODULE_IDS}
            activeIds={activeIds}
            hostFor={moduleHost}
            onExpand={toggleWindow}
            onAdd={addModule}
            onRemove={removeModule}
            dragActive={draggingModule !== null}
            onTrayOpenChange={setDockOpen}
            onModuleDragStart={setDraggingModule}
            onModuleDragEnd={() => {
              setDraggingModule(null);
              setDropZone(null);
            }}
          />
        </>
      )}
    </div>
  );
}
