import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";
import { remarkGfmCompat } from "./remarkGfmCompat";

const THROW = "render me and throw";

vi.mock("react-markdown", async (importActual) => {
  const actual = await importActual<typeof import("react-markdown")>();
  const Real = actual.default;
  return {
    ...actual,
    default: (props: ComponentProps<typeof Real>) => {
      if (props.children === THROW) throw new Error("render failed");
      return <Real {...props} />;
    },
  };
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function show(text: string) {
  await act(async () => root.render(<Markdown>{text}</Markdown>));
}

describe("Markdown", () => {
  it("renders GitHub-flavored tables, strikethrough and task lists", async () => {
    await show("| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~\n\n- [x] done");
    expect(host.querySelector("table td")?.textContent).toBe("1");
    expect(host.querySelector("del")?.textContent).toBe("gone");
    expect(host.querySelector("input[type=checkbox]")).not.toBeNull();
  });

  it("still links bare URLs, www hosts and emails", async () => {
    await show("see https://example.com/a, www.x.com and a.b@ex.com.");
    const hrefs = [...host.querySelectorAll("a")].map((a) => a.href);
    expect(hrefs).toEqual([
      "https://example.com/a",
      "http://www.x.com/",
      "mailto:a.b@ex.com",
    ]);
  });

  it("shows the reply as plain text when rendering it throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await show(THROW);
    expect(host.textContent).toBe(THROW);
    expect(host.querySelector(".agent__markdown")).toBeNull();
  });

  it("tries markdown again for the next reply", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await show(THROW);
    await show("**bold**");
    expect(host.querySelector("strong")?.textContent).toBe("bold");
  });
});

describe("remarkGfmCompat", () => {
  // The autolink regex transform is the part old WebKit cannot parse.
  it("registers no mdast transforms", () => {
    const data: Record<string, unknown[]> = {};
    remarkGfmCompat.call({ data: () => data });
    const extensions = data.fromMarkdownExtensions?.flat() as object[];
    expect(extensions.length).toBeGreaterThan(0);
    expect(extensions.some((e) => "transforms" in e)).toBe(false);
  });
});
