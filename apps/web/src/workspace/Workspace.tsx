import { useMemo } from "react";
import RGL, { type Layout, WidthProvider } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { SyncStatusLight } from "../sync/SyncStatusLight";
import { AddModuleMenu } from "./AddModuleMenu";
import { COLS, MARGIN, ROW_HEIGHT } from "./grid";
import { ModuleFrame } from "./ModuleFrame";
import { getModule } from "./registry";
import { useLayout } from "./useLayout";

// WidthProvider measures the container and feeds `width` to the grid, so we don't
// have to track it ourselves.
const GridLayout = WidthProvider(RGL);

// The blank base canvas. Renders each placed module inside a ModuleFrame and lets
// the user drag/resize them on a snapping grid. Layout state and persistence live
// in useLayout; module definitions live in the registry.
export function Workspace() {
  const { instances, addModule, removeModule, applyLayout } = useLayout();

  // Build the grid layout from placed instances, pulling per-module size floors
  // from the registry so a module can't be shrunk below what it can render.
  const layout: Layout[] = useMemo(
    () =>
      instances.map((inst) => {
        const def = getModule(inst.moduleId);
        return {
          i: inst.instanceId,
          x: inst.x,
          y: inst.y,
          w: inst.w,
          h: inst.h,
          minW: def?.minSize?.w,
          minH: def?.minSize?.h,
        };
      }),
    [instances],
  );

  return (
    <main className="workspace">
      <header className="workspace__bar">
        <div className="workspace__brand">
          <h1 className="workspace__title">Ghost</h1>
          <SyncStatusLight />
        </div>
        <div className="workspace__actions">
          <AddModuleMenu onAdd={addModule} />
        </div>
      </header>

      <div className="workspace__canvas">
        {instances.length === 0 ? (
          <p className="notice workspace__empty">
            Empty workspace — add a module above to get started.
          </p>
        ) : (
          <GridLayout
            layout={layout}
            cols={COLS}
            rowHeight={ROW_HEIGHT}
            margin={MARGIN}
            // Free placement on a snapping grid: no auto-compaction, and
            // collisions are blocked rather than overlapping.
            compactType={null}
            preventCollision={true}
            draggableHandle=".module-frame__bar"
            draggableCancel=".module-frame__no-drag"
            onLayoutChange={(next) =>
              applyLayout(
                next.map((n) => ({ i: n.i, x: n.x, y: n.y, w: n.w, h: n.h })),
              )
            }
          >
            {instances.map((inst) => {
              const def = getModule(inst.moduleId);
              if (!def) return null;
              const { Component } = def;
              return (
                <div key={inst.instanceId} className="workspace__item">
                  <ModuleFrame
                    title={def.title}
                    onClose={() => removeModule(inst.instanceId)}
                  >
                    <Component />
                  </ModuleFrame>
                </div>
              );
            })}
          </GridLayout>
        )}
      </div>
    </main>
  );
}
