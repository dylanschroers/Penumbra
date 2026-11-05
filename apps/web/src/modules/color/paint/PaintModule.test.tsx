import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ColorPickerModule } from "../ColorPickerModule";
import type { PaintEngine } from "./engine";
import { PaintExpanded } from "./PaintModule";
import { PaintProvider, usePaint } from "./PaintProvider";

// The split-view contract (workspace/types.ts → SplitViewModule): the dock's
// picker and the Paint window are two views over one state owner. Real pointer
// drawing needs a real canvas and is exercised in a browser; this covers what
// the views share and what must survive the window closing.

vi.mock("../../../color/screenDropper", () => ({
  dropperSupport: async () => ({ backend: "none", liveSample: false }),
  pickScreenColor: async () => null,
  colorAtCursor: async () => null,
}));

let host: HTMLDivElement;
let root: Root;
let engine: PaintEngine;
let setWindowOpen: (open: boolean) => void;

function Capture() {
  engine = usePaint().engine;
  return null;
}

function Module() {
  const [open, setOpen] = useState(true);
  setWindowOpen = setOpen;
  return (
    <PaintProvider>
      <Capture />
      <div id="dock">
        <ColorPickerModule />
      </div>
      {open ? (
        <div id="window">
          <PaintExpanded />
        </div>
      ) : null}
    </PaintProvider>
  );
}

const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
const $ = <T extends Element = HTMLElement>(selector: string) =>
  host.querySelector<T>(selector)!;
const dockHex = () => $<HTMLInputElement>("#dock .color-picker__hex").value;
const toolPressed = (label: string) =>
  $(`.paint__tool[aria-label="${label}"]`).getAttribute("aria-pressed");
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(".paint__btn")].find(
    (b) => b.textContent === name,
  )!;

beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Module />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the two views", () => {
  it("share the primary color from the palette to the dock", async () => {
    await click($('.paint__chip[aria-label="Use #ed1c24"]'));
    expect(dockHex()).toBe("#ed1c24");
    expect($(".paint__swatch--primary").getAttribute("aria-label")).toContain(
      "#ed1c24",
    );
  });

  it("share it back from the dock to the window", async () => {
    const input = $<HTMLInputElement>("#dock .color-picker__hex");
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(input, "#123456");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect($(".paint__swatch--primary").getAttribute("aria-label")).toContain(
      "#123456",
    );
  });

  it("swap primary and secondary", async () => {
    await click($('.paint__chip[aria-label="Use #ed1c24"]'));
    await click(host.querySelectorAll(".paint__swatch")[1]!);
    expect(dockHex()).toBe("#ffffff");
    expect(
      host.querySelectorAll(".paint__swatch")[1]!.getAttribute("aria-label"),
    ).toContain("#ed1c24");
  });

  it("show the picker popover only when asked", async () => {
    expect($(".paint__popover")).toBeNull();
    await click($(".paint__swatch--primary"));
    expect($(".paint__popover .color-picker")).not.toBeNull();
  });
});

describe("the toolbar", () => {
  it("selects one tool at a time and shows only its options", async () => {
    expect(toolPressed("Pencil")).toBe("true");
    expect($(".paint__option")).toBeNull();
    await click($('.paint__tool[aria-label="Rectangle"]'));
    expect(toolPressed("Pencil")).toBe("false");
    expect(toolPressed("Rectangle")).toBe("true");
    expect($('.paint__option input[type="checkbox"]')).not.toBeNull();
  });

  it("enables undo and redo as the history allows", async () => {
    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(true);
    await act(async () => {
      engine.begin("pencil", 1, 1, {
        color: 0xff000000,
        back: 0xffffffff,
        size: 1,
        filled: false,
      });
      engine.end();
    });
    expect(button("Undo").disabled).toBe(false);
    await click(button("Undo"));
    expect(button("Redo").disabled).toBe(false);
  });

  it("clears the canvas on New as one undoable step", async () => {
    await act(async () => {
      engine.begin("fill", 0, 0, {
        color: 0xff000000,
        back: 0xffffffff,
        size: 1,
        filled: false,
      });
    });
    await click(button("New"));
    expect(engine.working.px[0]).toBe(0xffffffff);
    await click(button("Undo"));
    expect(engine.working.px[0]).toBe(0xff000000);
  });
});

describe("closing the window", () => {
  it("keeps the drawing and the color, since the Provider owns them", async () => {
    await click($('.paint__chip[aria-label="Use #ed1c24"]'));
    await act(async () => {
      engine.begin("fill", 0, 0, {
        color: 0xff000000,
        back: 0xffffffff,
        size: 1,
        filled: false,
      });
    });
    const before = engine;
    await act(async () => setWindowOpen(false));
    expect($("#window")).toBeNull();
    expect(dockHex()).toBe("#ed1c24");
    await act(async () => setWindowOpen(true));
    expect(engine).toBe(before);
    expect(engine.working.px[0]).toBe(0xff000000);
    expect(button("Undo").disabled).toBe(false);
  });
});
