import type { ComponentType, ReactNode } from "react";

// The frontend counterpart to the backend tool registry (docs/ARCHITECTURE.md →
// "The tool registry is the spine"): a module is *defined once* here and the
// shell renders it without knowing anything about its internals.

/** What every module carries, whichever view shape it uses. */
interface ModuleBase {
  /** Stable id, also the key the shell tracks an open module by. */
  id: string;
  /** Shown in the module's title bar. */
  title: string;
}

/**
 * A module with a single view, shown wherever it currently sits. The shell keeps
 * the one instance alive and moves it between the dock card and the focus pane,
 * so its state survives the trip.
 *
 * Fine while a module's dock and expanded presentations are one layout at two
 * sizes. Once they want to be genuinely different designs — or the dock card
 * should stay live *while* the module is expanded — split it.
 */
export interface SingleViewModule extends ModuleBase {
  Component: ComponentType;
}

/**
 * A module split into one state owner and two views.
 *
 * `Provider` is mounted once per open module and owns everything the views
 * share or must not lose: data, effects, polls, in-flight work, and any form
 * state the user would be annoyed to retype. `Compact` and `Expanded` are
 * projections of it, so they can render *at the same time* — a live dock
 * thumbnail beside the expanded module — and either can be unmounted freely.
 *
 * The rule that keeps this honest: if losing it on an unmount would be a bug,
 * it belongs in the Provider, not in a view.
 */
export interface SplitViewModule extends ModuleBase {
  Provider: ComponentType<{ children: ReactNode }>;
  /** The dock card: a live summary that reads well small. */
  Compact: ComponentType;
  /** The focus pane: the full depth. */
  Expanded: ComponentType;
}

export type ModuleDefinition = SingleViewModule | SplitViewModule;

/** Whether this module carries the state-owner + two-views shape. */
export function isSplitView(def: ModuleDefinition): def is SplitViewModule {
  return "Provider" in def;
}
