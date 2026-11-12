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

// `trayOpen` decides both visibility and whether compact views render; it once
// shared that with a CSS `:hover` rule and they drifted.

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

/** Native events: mouseenter/mouseleave don't bubble. */
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

  // `:hover` re-evaluates on layout shift but mouseenter doesn't, so the dock
  // animating under a resting cursor opened an empty tray.
  it("never shows the tray without having reported it open", () => {
    renderDock();
    expect(isOpenInDom()).toBe(onTrayOpenChange.mock.lastCall?.[0]);
    pointer("mouseenter");
    expect(isOpenInDom()).toBe(onTrayOpenChange.mock.lastCall?.[0]);
    pointer("mouseleave");
    expect(isOpenInDom()).toBe(onTrayOpenChange.mock.lastCall?.[0]);
  });

  it("picks up a pointer already resting on the dock when it mounts", () => {
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

  // The dock answers only to the pointer.
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

  // React's synthetic leave fires when crossing into portalled module content,
  // causing a mount/unmount flicker loop.
  it("stays open when the pointer crosses into portalled module content", () => {
    renderDock();
    pointer("mouseenter");
    expect(onTrayOpenChange).toHaveBeenLastCalledWith(true);

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
