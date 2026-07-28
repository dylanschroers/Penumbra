import { useLayoutEffect, useRef } from "react";

/**
 * Which of a module's views a host belongs to. A split module has `compact` and
 * `expanded` hosts live at the same time — that is the point of splitting. A
 * single-view module has one `single` host that travels between the dock and
 * the centre instead.
 */
export type ModuleView = "single" | "compact" | "expanded";

// Where a module's live DOM lands. The module itself is rendered once, by
// AppShell, into a detached "host" node (see moduleHost there); this component
// only claims that node into its own container.
//
// Exactly one slot for a given module is mounted at a time — its dock card, or
// the centre focus pane — so mounting *is* the whole handshake: the slot appends
// the host, which moves it out of whichever slot held it before. Moving a DOM
// node does not remount the React tree portalled into it, so the module keeps
// its state, polls, and in-flight uploads as it travels.
//
// useLayoutEffect, not useEffect: the move has to land before paint, or every
// expand/collapse shows one frame of empty card.
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
