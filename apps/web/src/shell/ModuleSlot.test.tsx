import { act, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModuleSlot } from "./ModuleSlot";

// The point of the host/portal arrangement is that expanding a module *moves*
// it rather than mounting a second copy. That is invisible in the UI until it
// breaks — a regression shows up only as a half-filled form or a doubled poll —
// so it is pinned here.
//
// The harness mirrors AppShell: one component rendered once into a detached
// host, plus two slots that take turns claiming it — exclusively, exactly as
// the dock swaps its slot for a stand-in note while a module is expanded.

let mountCount = 0;

/** Stands in for a real module: holds state, and counts its own mounts. */
function Counter() {
  const [n, setN] = useState(0);
  useEffect(() => {
    mountCount++;
  }, []);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      count:{n}
    </button>
  );
}

function Harness({ focused }: { focused: boolean }) {
  const host = useRef<HTMLDivElement | null>(null);
  if (!host.current) {
    host.current = document.createElement("div");
    host.current.style.display = "contents";
  }
  // Two separate subtrees, as in the app (the focus pane lives in AppShell, the
  // dock card in ModuleDock). Putting both slots at one tree position instead
  // would let React reuse the instance and merely swap its className — the host
  // would never move, and this test would pass without testing anything.
  return (
    <div>
      {createPortal(<Counter />, host.current)}
      <section className="focus-pane">
        {focused && <ModuleSlot className="focus" host={host.current} />}
      </section>
      <section className="dock-pane">
        {!focused && <ModuleSlot className="dock" host={host.current} />}
      </section>
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;

const render = (focused: boolean) =>
  act(() => {
    root.render(<Harness focused={focused} />);
  });

/** The class of the slot the counter currently lives in. */
const slotOf = (): string | undefined =>
  container.querySelector("button")?.closest(".dock, .focus")?.className;

beforeEach(() => {
  mountCount = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ModuleSlot", () => {
  it("moves one instance between slots instead of mounting a second", () => {
    render(false);
    expect(slotOf()).toBe("dock");

    // Give the module some state to lose.
    act(() => {
      container.querySelector("button")?.click();
    });
    expect(container.querySelector("button")?.textContent).toBe("count:1");

    // Expand to the focus pane, then collapse back to the dock.
    render(true);
    expect(slotOf()).toBe("focus");
    expect(container.querySelector("button")?.textContent).toBe("count:1");

    render(false);
    expect(slotOf()).toBe("dock");
    expect(container.querySelector("button")?.textContent).toBe("count:1");

    // The state surviving both moves already implies this, but assert it
    // directly: the module mounted once and was never re-created, and only ever
    // exists in one place.
    expect(mountCount).toBe(1);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    // The slot it isn't in is genuinely empty — the dock card's stand-in note
    // covers that gap in the real UI.
    expect(container.querySelector(".focus-pane")?.textContent).toBe("");
  });
});
