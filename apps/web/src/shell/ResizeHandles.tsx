import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

// Window resize grips for the desktop build.
//
// `decorations: false` in tauri.conf.json takes the native frame away, and with
// it the invisible border the OS resizes by — so without these the window is
// stuck at whatever size it opened at, with maximize/restore the only way to
// change it. TitleBar restored moving and the window buttons; this restores
// sizing, and the two together are what "custom chrome" has to mean.
//
// Eight strips rather than one CSS border, because `startResizeDragging` has to
// be told which way to grow. Corners are declared last so that where they
// overlap an edge, the corner takes the pointer: a diagonal drag is both the
// fiddliest to aim and the one people reach for most.
//
// Needs `core:window:allow-start-resize-dragging` in capabilities/default.json.
// Like the other window permissions, a missing one fails at runtime with a
// permission error rather than at build — the grips render and simply do
// nothing.

/** Grip class suffix → the direction it drags. Corners last: see above. */
const GRIPS = [
  ["n", "North"],
  ["s", "South"],
  ["w", "West"],
  ["e", "East"],
  ["nw", "NorthWest"],
  ["ne", "NorthEast"],
  ["sw", "SouthWest"],
  ["se", "SouthEast"],
] as const;

export function ResizeHandles() {
  // Hidden while maximized. The grips sit on the window's outer edge, which
  // when maximized is the screen's: a drag there reads as "unmaximize" in every
  // other application, and offering a resize instead is the odd one out. The
  // way out of maximized stays the title bar's — its button or a double-click.
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // Resolved inside the effect, not in the component body: getCurrentWindow()
    // builds a fresh handle per call, so closing over one from the render would
    // change identity every pass and re-subscribe on every render.
    const win = getCurrentWindow();
    let live = true;
    let unlisten: (() => void) | undefined;

    const sync = () => {
      void win.isMaximized().then((now) => {
        if (live) setMaximized(now);
      });
    };
    sync();

    // Maximizing and restoring both change the size, so onResized covers the
    // button, the double-click, and anything the OS does on its own — a snap
    // gesture, a display change, a window manager with opinions.
    void win.onResized(sync).then((fn) => {
      if (live) unlisten = fn;
      // Unmounted while the subscription was still in flight: drop it rather
      // than leaking a listener onto a component that is already gone.
      else fn();
    });

    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  if (maximized) return null;

  return (
    <>
      {GRIPS.map(([side, direction]) => (
        <div
          key={side}
          className={`resize-grip resize-grip--${side}`}
          data-direction={direction}
          onPointerDown={(ev) => {
            // Left button only: a right-click belongs to whatever context menu
            // may be underneath, not to a drag with no visible way to cancel.
            if (ev.button !== 0) return;
            // Stops the press from also starting a text selection that then
            // runs away with the pointer during the resize.
            ev.preventDefault();
            void getCurrentWindow().startResizeDragging(direction);
          }}
        />
      ))}
    </>
  );
}
