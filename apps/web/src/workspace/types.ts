import type { ComponentType, ReactNode } from "react";

// A module is defined once here; the shell renders it without knowing its
// internals.

interface ModuleBase {
  id: string;
  title: string;
}

/**
 * One instance, moved between the dock card and focus pane so state survives.
 * Split it when the two presentations need different designs or the card
 * should stay live while expanded.
 */
export interface SingleViewModule extends ModuleBase {
  Component: ComponentType;
}

/**
 * `Provider` owns everything that must survive an unmount (data, effects,
 * polls, in-flight work, form drafts); `Compact` and `Expanded` are
 * projections and can render at once.
 */
export interface SplitViewModule extends ModuleBase {
  Provider: ComponentType<{ children: ReactNode }>;
  Compact: ComponentType;
  Expanded: ComponentType;
}

export type ModuleDefinition = SingleViewModule | SplitViewModule;

export function isSplitView(def: ModuleDefinition): def is SplitViewModule {
  return "Provider" in def;
}
