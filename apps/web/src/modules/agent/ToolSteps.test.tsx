import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolSteps } from "./ToolSteps";
import type { ToolStep } from "./useAgent";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

async function show(steps: ToolStep[]) {
  await act(async () => root.render(<ToolSteps steps={steps} />));
}

const steps: ToolStep[] = [
  { name: "list_files", result: "Contents of /n:\n/n/a.md" },
  { name: "read_file", result: "Cannot read /n/x.md: no such file." },
  { name: "search_files", result: "/n/a.md:2: hello" },
];

const toolLines = () =>
  [...host.querySelectorAll(".agent__tool")].map((t) => t.textContent);

describe("ToolSteps", () => {
  it("shows a single step without a dropdown", async () => {
    await show([steps[0] as ToolStep]);
    expect(host.querySelector("button")).toBeNull();
    expect(toolLines()).toEqual(["🔧 Listed filesContents of /n:"]);
  });

  it("collapses several steps to the latest, with the count and failures", async () => {
    await show(steps);
    expect(toolLines()).toEqual(["🔧 Searched files/n/a.md:2: hello"]);
    expect(host.textContent).toContain("3 actions, 1 failed");
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("opens to every step and closes again", async () => {
    await show(steps);
    const toggle = host.querySelector("button") as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(toolLines()).toHaveLength(3);
    expect(host.querySelector(".agent__tool--failed")?.textContent).toContain(
      "Read a file",
    );
    await act(async () => toggle.click());
    expect(toolLines()).toHaveLength(1);
  });
});
