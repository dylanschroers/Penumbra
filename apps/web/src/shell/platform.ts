import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

export const isMac = navigator.userAgent.includes("Macintosh");

/** Whether the window is in native full screen, which hides the traffic lights.
 *  Only reads the window when `enabled`, since the web build has no Tauri. */
export function useIsFullscreen(enabled: boolean): boolean {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const win = getCurrentWindow();
    let live = true;
    let unlisten: (() => void) | undefined;

    const sync = () => {
      void win.isFullscreen().then((now) => {
        if (live) setFullscreen(now);
      });
    };
    sync();

    // Entering and leaving full screen both change the size.
    void win.onResized(sync).then((fn) => {
      if (live) unlisten = fn;
      else fn();
    });

    return () => {
      live = false;
      unlisten?.();
    };
  }, [enabled]);

  return fullscreen;
}
