import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

// `decorations: false` removes the native resize border, so these eight
// grips replace it. Corners come last so they win where they overlap edges.
// Needs `core:window:allow-start-resize-dragging` in capabilities/default.json;
// without it the grips silently do nothing.

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
  // Hidden while maximized: dragging the screen edge should not resize.
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // Inside the effect: getCurrentWindow() returns a fresh handle per call.
    const win = getCurrentWindow();
    let live = true;
    let unlisten: (() => void) | undefined;

    const sync = () => {
      void win.isMaximized().then((now) => {
        if (live) setMaximized(now);
      });
    };
    sync();

    // Covers the button, double-click, and OS-initiated changes.
    void win.onResized(sync).then((fn) => {
      if (live) unlisten = fn;
      // Unmounted mid-subscribe: drop the listener.
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
            if (ev.button !== 0) return;
            // Stops a text selection from starting during the resize.
            ev.preventDefault();
            void getCurrentWindow().startResizeDragging(direction);
          }}
        />
      ))}
    </>
  );
}
