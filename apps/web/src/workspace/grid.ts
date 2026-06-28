// Shared workspace grid metrics. Module positions/sizes (ModuleInstance) are in
// these column/row units; react-grid-layout maps them to pixels from the live
// container width. Both the canvas (Workspace) and the placement logic (useLayout)
// read these, so they live here to stay in sync.
export const COLS = 24;
export const ROW_HEIGHT = 40;
export const MARGIN: [number, number] = [12, 12];
