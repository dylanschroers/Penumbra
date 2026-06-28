import type { ComponentType } from "react";

// The frontend counterpart to the backend tool registry (docs/ARCHITECTURE.md →
// "The tool registry is the spine"): a module is *defined once* here and the
// workspace canvas can place, render, and persist it without knowing anything
// about its internals.

/** A capability the workspace can render as a free-placed module. */
export interface ModuleDefinition {
  /** Stable id, also the key persisted in a placed instance. */
  id: string;
  /** Shown in the module's title bar. */
  title: string;
  /** Default size in grid units (columns × rows) when first added. */
  defaultSize: { w: number; h: number };
  /** Optional minimum size in grid units. */
  minSize?: { w: number; h: number };
  /** The module's own self-contained UI. */
  Component: ComponentType;
}

/**
 * A module placed on the canvas. Positions/sizes are in grid units (not pixels)
 * — react-grid-layout maps them to pixels from the live container width. This is
 * user-authored layout (Plane A); persisted to localStorage for now, destined
 * for the shared SQLite schema once the interaction settles.
 */
export interface ModuleInstance {
  /** Unique per placement, so the same module can appear more than once. */
  instanceId: string;
  /** Which ModuleDefinition this renders (FK into the registry). */
  moduleId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
