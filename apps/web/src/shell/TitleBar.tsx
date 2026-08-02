import { getCurrentWindow } from "@tauri-apps/api/window";
import { Logo } from "./Logo";

// Custom window chrome for the desktop build (native decorations are off in
// tauri.conf.json). The bar itself is the drag region — Tauri's native drag
// handling also gives it double-click-to-maximize — and the controls mirror the
// Windows layout. The web build never renders this; AppShell gates on the
// Tauri probe (isFsAvailable).
//
// Two maximize permissions are in capabilities/default.json, and both are
// needed: the button below calls `toggleMaximize` (core:window:allow-toggle-
// maximize), while Tauri's injected drag-region script invokes a *different*
// command on double-click, `internal_toggle_maximize`
// (core:window:allow-internal-toggle-maximize). Drop either and half the
// gesture set fails at runtime with a permission error.
export function TitleBar() {
  const win = getCurrentWindow();
  return (
    <header className="titlebar" data-tauri-drag-region="true">
      <span className="titlebar__name">
        <Logo size={16} />
        Penumbra
      </span>
      <div className="titlebar__controls">
        <button
          type="button"
          className="titlebar__btn"
          onClick={() => void win.minimize()}
          aria-label="Minimize window"
          title="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <line
              x1="0"
              y1="5"
              x2="10"
              y2="5"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar__btn"
          onClick={() => void win.toggleMaximize()}
          aria-label="Maximize or restore window"
          title="Maximize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect
              x="0.5"
              y="0.5"
              width="9"
              height="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar__btn titlebar__btn--close"
          onClick={() => void win.close()}
          aria-label="Close window"
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <line
              x1="0"
              y1="0"
              x2="10"
              y2="10"
              stroke="currentColor"
              strokeWidth="1"
            />
            <line
              x1="10"
              y1="0"
              x2="0"
              y2="10"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}
