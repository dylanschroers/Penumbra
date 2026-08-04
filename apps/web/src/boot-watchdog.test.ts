import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// The boot watchdog lives inline in index.html because it must run before the
// module graph it guards — so it is outside the app's module tree and cannot be
// imported. This test extracts the actual script and runs it against fake DOM
// primitives, simulating page loads, error events, and the 500ms reload wait,
// so the bounded and boot-scoped rules stay pinned as the script evolves.
// vitest runs with cwd at the package root; fall back to the workspace path in
// case it is ever run from the repo root.
const indexHtml = [
  resolve(process.cwd(), "index.html"),
  resolve(process.cwd(), "apps/web/index.html"),
].find(existsSync);
if (!indexHtml) throw new Error("could not locate apps/web/index.html");
const html = readFileSync(indexHtml, "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error("boot watchdog <script> not found in index.html");

// Compile with its DOM globals as parameters, so each run gets injected fakes.
const runWatchdog = new Function(
  "window",
  "document",
  "sessionStorage",
  "location",
  "setTimeout",
  script,
) as (
  window: unknown,
  document: unknown,
  sessionStorage: unknown,
  location: unknown,
  setTimeout: unknown,
) => void;

const RETRIES = "penumbra-boot-retries";
type Listener = (ev?: unknown) => void;

// sessionStorage persists across reloads; everything else is fresh per load.
let store: Map<string, string>;
let reloads: number;

beforeEach(() => {
  store = new Map();
  reloads = 0;
});

const sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, String(v));
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
};
const location = {
  reload: () => {
    reloads += 1;
  },
};

function makeDocument() {
  let rootHtml = "";
  let onClick: Listener | null = null;
  const root = {
    get innerHTML() {
      return rootHtml;
    },
    set innerHTML(v: string) {
      rootHtml = v;
    },
  };
  const button = {
    addEventListener: (_type: string, fn: Listener) => {
      onClick = fn;
    },
  };
  return {
    getElementById: (id: string) =>
      id === "root" ? root : id === "penumbra-retry" ? button : null,
    root,
    clickRetry: () => onClick?.(),
  };
}

/** One page load: fresh window/document, shared store, a controllable timer. */
function load() {
  const listeners: Record<string, Listener[]> = {};
  const timers: Array<() => void> = [];
  const win = {
    addEventListener(type: string, fn: Listener) {
      const list = listeners[type] ?? [];
      list.push(fn);
      listeners[type] = list;
    },
  } as {
    addEventListener(type: string, fn: Listener): void;
    __penumbraBooted?: () => void;
  };
  const doc = makeDocument();
  runWatchdog(win, doc, sessionStorage, location, (fn: () => void) =>
    timers.push(fn),
  );
  return {
    win,
    doc,
    timers,
    dispatch: (type: string, ev: unknown) => {
      for (const fn of listeners[type] ?? []) fn(ev);
    },
    flush: () => {
      for (const fn of timers.splice(0)) fn();
    },
  };
}

describe("boot watchdog", () => {
  it("waits, then reloads, on a boot failure", () => {
    const page = load();
    page.dispatch("error", { message: "not a valid JavaScript MIME type" });

    expect(reloads).toBe(0); // does not reload synchronously — it waits
    expect(page.timers).toHaveLength(1);

    page.flush();
    expect(reloads).toBe(1);
    expect(store.get(RETRIES)).toBe("1");
  });

  it("keeps retrying while under the cap", () => {
    store.set(RETRIES, "1");
    const page = load();
    page.dispatch("error", { message: "again" });
    page.flush();

    expect(reloads).toBe(1);
    expect(store.get(RETRIES)).toBe("2");
  });

  it("stops at the cap and shows the error instead of looping", () => {
    store.set(RETRIES, "2"); // already reloaded MAX times
    const page = load();
    page.dispatch("error", { message: "still <broken> & dead" });

    expect(reloads).toBe(0); // no further reload
    expect(page.timers).toHaveLength(0);
    expect(page.doc.root.innerHTML).toContain("Penumbra failed to start");
    // the detail is HTML-escaped before it goes into innerHTML
    expect(page.doc.root.innerHTML).toContain(
      "still &lt;broken&gt; &amp; dead",
    );
  });

  it("clears the counter and reloads when the fallback button is used", () => {
    store.set(RETRIES, "2");
    const page = load();
    page.dispatch("error", { message: "dead" });

    page.doc.clickRetry();
    expect(reloads).toBe(1);
    expect(store.has(RETRIES)).toBe(false);
  });

  it("stands down once the app has booted", () => {
    store.set(RETRIES, "1");
    const page = load();
    page.win.__penumbraBooted?.();
    expect(store.has(RETRIES)).toBe(false); // mount clears the counter

    page.dispatch("error", { message: "a later, in-session error" });
    page.flush();
    expect(reloads).toBe(0); // never reloads a running session
  });

  it("ignores resource (img/link) load errors", () => {
    const page = load();
    page.dispatch("error", { message: "", error: null });
    page.flush();

    expect(reloads).toBe(0);
    expect(store.has(RETRIES)).toBe(false);
  });

  it("treats an unhandled rejection as a boot failure", () => {
    const page = load();
    page.dispatch("unhandledrejection", { reason: { message: "async boom" } });
    page.flush();

    expect(reloads).toBe(1);
    expect(store.get(RETRIES)).toBe("1");
  });
});
