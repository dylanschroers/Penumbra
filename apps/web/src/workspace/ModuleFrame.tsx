import type { ReactNode } from "react";

// The card chrome around any module: a draggable title bar plus a close button.
// The title bar carries the `module-frame__bar` class, which the grid uses as
// its drag handle, so dragging only starts from the bar — not from inside the
// module's own controls. The close button is marked no-drag for the same reason.
export function ModuleFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="module-frame">
      <div className="module-frame__bar">
        <span className="module-frame__title">{title}</span>
        <button
          type="button"
          className="btn btn--ghost module-frame__close module-frame__no-drag"
          onClick={onClose}
          aria-label={`Remove ${title}`}
        >
          ✕
        </button>
      </div>
      <div className="module-frame__body">{children}</div>
    </div>
  );
}
