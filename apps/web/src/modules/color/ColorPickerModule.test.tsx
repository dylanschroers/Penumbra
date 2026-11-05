import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ColorPickerModule } from "./ColorPickerModule";
import { PaintProvider } from "./paint/PaintProvider";

const dropper = vi.hoisted(() => ({
  dropperSupport: vi.fn(),
  pickScreenColor: vi.fn(),
  colorAtCursor: vi.fn(),
}));
vi.mock("../../color/screenDropper", () => dropper);

const setInputValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

const picker = (
  <PaintProvider>
    <ColorPickerModule />
  </PaintProvider>
);

let host: HTMLDivElement;
let root: Root;

const hexBox = () =>
  host.querySelector<HTMLInputElement>(".color-picker__hex")!;
const rgbChip = () => host.querySelectorAll(".color-picker__chip")[0]!;

async function enter(value: string) {
  await act(async () => {
    setInputValue.call(hexBox(), value);
    hexBox().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Type one character at a time, the way a person fills the box. */
async function type(text: string) {
  await enter("");
  for (const ch of text) await enter(hexBox().value + ch);
}

beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  dropper.dropperSupport.mockResolvedValue({
    backend: "none",
    liveSample: false,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(picker));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the hex box", () => {
  it("lets a six-digit hex be typed straight through its three-digit prefix", async () => {
    await type("#abc123");
    expect(hexBox().value).toBe("#abc123");
    expect(rgbChip().textContent).toBe("rgb(171, 193, 35)");
  });

  it("keeps a typed shorthand as typed while committing its expansion", async () => {
    await type("#abc");
    expect(hexBox().value).toBe("#abc");
    expect(rgbChip().textContent).toBe("rgb(170, 187, 204)");
  });

  it("does not commit a four-digit prefix as a color", async () => {
    await type("#abc");
    await enter("#abcd");
    expect(rgbChip().textContent).toBe("rgb(170, 187, 204)");
  });

  it("accepts a pasted hex with surrounding whitespace", async () => {
    await enter(" #abc123 ");
    expect(hexBox().value).toBe("#abc123");
    expect(rgbChip().textContent).toBe("rgb(171, 193, 35)");
  });

  it("accepts a hex pasted into a box emptied down to its hash", async () => {
    await enter("");
    expect(hexBox().value).toBe("#");
    await enter("##abc123");
    expect(hexBox().value).toBe("#abc123");
    expect(rgbChip().textContent).toBe("rgb(171, 193, 35)");
  });

  it("adds the missing hash", async () => {
    await type("abc123");
    expect(hexBox().value).toBe("#abc123");
  });

  it("resyncs to the canonical hex when the color changes from elsewhere", async () => {
    dropper.dropperSupport.mockResolvedValue({
      backend: "eyedropper",
      liveSample: false,
    });
    dropper.pickScreenColor.mockResolvedValue("#112233");
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(picker));

    await type("#abc");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(".color-picker__dropper")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

    expect(hexBox().value).toBe("#112233");
  });

  it("persists the canonical hex, not the typed shorthand", async () => {
    await type("#abc");
    expect(JSON.stringify({ ...localStorage })).toContain("#aabbcc");
  });
});

describe("the dropper error line", () => {
  it("shows the message a failed pick carries", async () => {
    dropper.dropperSupport.mockResolvedValue({
      backend: "native",
      liveSample: false,
    });
    dropper.pickScreenColor.mockRejectedValue(
      new Error("Screen pick failed: no portal frontend"),
    );
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(picker));

    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(".color-picker__dropper")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

    expect(host.querySelector(".color-picker__status")?.textContent).toBe(
      "Screen pick failed: no portal frontend",
    );
  });
});
