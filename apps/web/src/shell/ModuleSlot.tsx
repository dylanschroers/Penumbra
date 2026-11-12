import { useLayoutEffect, useRef } from "react";

/**
 * A split module has compact and expanded hosts live at once; a single-view
 * module has one host that travels.
 */
export type ModuleView = "single" | "compact" | "expanded";

// Claims the module's detached host node (rendered once by AppShell). Only one
// slot per module is mounted, so mounting moves the node; moving a DOM node
// doesn't remount its portalled React tree, so state survives.
// useLayoutEffect so the move lands before paint.
export function ModuleSlot({
  host,
  className,
}: {
  host: HTMLElement;
  className: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    ref.current?.appendChild(host);
  }, [host]);

  return <div className={className} ref={ref} />;
}
