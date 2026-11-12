import { act, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModuleSlot } from "./ModuleSlot";

// Expanding must move the module, not mount a second copy. The harness mirrors
// AppShell: one host, two slots claiming it in turn.

let mountCount = 0;

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
  // Separate subtrees, as in the app; one tree position would let React reuse
  // the instance and test nothing.
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

    act(() => {
      container.querySelector("button")?.click();
    });
    expect(container.querySelector("button")?.textContent).toBe("count:1");

    render(true);
    expect(slotOf()).toBe("focus");
    expect(container.querySelector("button")?.textContent).toBe("count:1");

    render(false);
    expect(slotOf()).toBe("dock");
    expect(container.querySelector("button")?.textContent).toBe("count:1");

    expect(mountCount).toBe(1);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector(".focus-pane")?.textContent).toBe("");
  });
});
