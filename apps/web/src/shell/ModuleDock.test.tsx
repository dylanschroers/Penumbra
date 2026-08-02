import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { ModuleDock } from "./ModuleDock";

// `trayOpen` decides both whether the tray is shown (via `dock--open`) and
// whether the shell renders the compact views at all. It used to share that job
// with a CSS `:hover` rule, and the two drifted quietly — an open tray full of
// empty cards. So the ways it opens and shuts are pinned here, and the class it
// drives is asserted alongside the reported value.

let container: HTMLDivElement;
let root: Root;
let onTrayOpenChange: Mock<(open: boolean) => void>;

const host = document.createElement("div");

function renderDock(props: { dragActive?: boolean; openIds?: string[] } = {}) {
  act(() => {
    root.render(
      <ModuleDock
        openIds={props.openIds ?? []}
        addableIds={[]}
        activeIds={[]}
        hostFor={() => host}
        onExpand={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
        onModuleDragStart={() => {}}
        onModuleDragEnd={() => {}}
        dragActive={props.dragActive ?? false}
        onTrayOpenChange={onTrayOpenChange}
      />,
    );
  });
}

/** The dock listens for *native* mouseenter/mouseleave (they don't bubble, so
 *  they go straight on the element). */
function pointer(type: "mouseenter" | "mouseleave") {
  const dock = container.querySelector(".dock");
  act(() => {
    dock?.dispatchEvent(new MouseEvent(type));
  });
}

beforeEach(() => {
  onTrayOpenChange = vi.fn<(open: boolean) => void>();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** What the tray is actually showing, as opposed to what it reported. */
const isOpenInDom = () =>
  container.querySelector(".dock")?.classList.contains("dock--open") ?? false;

describe("ModuleDock tray state", () => {
  it("starts shut", () => {
    renderDock();
    expect(onTrayOpenChange).toHaveBeenLastCalledWith(false);
    expect(isOpenInDom()).toBe(false);
  });

  it("opens on hover and shuts again when the pointer leaves", () => {
    renderDock();
    pointer("mouseenter");
    expect(onTrayOpenChange).toHaveBeenLastCalledWith(true);
    pointer("mouseleave");
    expect(onTrayOpenChange).toHaveBeenLastCalledWith(false);
  });

  // Regression: the tray's visibility was a CSS `:hover` rule while mounting
  // keyed off React's hover state. `:hover` re-evaluates when the layout shifts
  // under a still pointer; mouseenter doesn't fire then. The dock animating into
  // place under a resting cursor therefore opened the tray with nothing in it,
  // and only moving the pointer away and back fixed it. Whatever the tray shows,
  // it must have reported.
  it("never shows the tray without having reported it open", () => {
    renderDock();
    expect(isOpenInDom()).toBe(onTrayOpenChange.mock.lastCall?.[0]);
    pointer("mouseenter");
    expect(isOpenInDom()).toBe(onTrayOpenChange.mock.lastCall?.[0]);
    pointer("mouseleave");
    expect(isOpenInDom()).toBe(onTrayOpenChange.mock.lastCall?.[0]);
  });

  it("picks up a pointer already resting on the dock when it mounts", () => {
    // The dock animates in; if the cursor is already there, no event fires.
    const orig = Element.prototype.matches;
    Element.prototype.matches = function (selector: string) {
      if (selector === ":hover") return this.classList.contains("dock");
      return orig.call(this, selector);
    };
    try {
      renderDock();
      expect(onTrayOpenChange).toHaveBeenLastCalledWith(true);
    } finally {
      Element.prototype.matches = orig;
    }
  });

  it("stays open while pinned, with the pointer away", () => {
    renderDock();
    act(() => {
      container.querySelector<HTMLButtonElement>(".dock__handle")?.click();
    });
    expect(onTrayOpenChange).toHaveBeenLastCalledWith(true);
    pointer("mouseleave");
    expect(onTrayOpenChange).toHaveBeenLastCalledWith(true);
  });

  it("opens while a module is being dragged out of the add-list", () => {
    renderDock({ dragActive: true });
    expect(onTrayOpenChange).toHaveBeenLastCalledWith(true);
  });

  // The dock answers to the pointer and nothing else. It used to force itself
  // shut on expand, which read as the tray flinching away from the toggle.
  it("stays open when a module is expanded or sent back", () => {
    renderDock({ openIds: ["tasks"] });
    pointer("mouseenter");
    expect(onTrayOpenChange).toHaveBeenLastCalledWith(true);

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Expand Tasks to center"]',
        )
        ?.click();
    });

    expect(onTrayOpenChange).toHaveBeenLastCalledWith(true);
    expect(isOpenInDom()).toBe(true);
  });

  // Regression: the dock used React's onMouseEnter/onMouseLeave, which follow
  // the React tree. A module's view is portalled in from AppShell, so crossing
  // into it read as leaving the dock — which unmounted the view, put the pointer
  // over an empty card, read as re-entering, and flickered forever. The pointer
  // moving *within* the dock must not disturb the tray.
  it("stays open when the pointer crosses into portalled module content", () => {
    renderDock();
    pointer("mouseenter");
    expect(onTrayOpenChange).toHaveBeenLastCalledWith(true);

    // What the browser actually emits when the pointer moves between elements
    // inside the dock, and what React turns into a synthetic leave.
    const card = container.querySelector(".dock-card");
    act(() => {
      card?.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }),
      );
      card?.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }),
      );
    });

    expect(onTrayOpenChange).toHaveBeenLastCalledWith(true);
  });
});
