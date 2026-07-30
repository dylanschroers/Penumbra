import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Two things this module has to get right, both of which are silent when wrong:
//
//   1. A cancel is not a failure. Chromium reports both a dismissal and a real
//      abort as AbortError, so the wrapper folds that one case into `null` while
//      letting genuine faults keep throwing — otherwise the picker would flash an
//      error every time someone changed their mind.
//   2. The backend choice. Native must win wherever it exists, because the
//      EyeDropper magnifier is the thing that made picking lag; falling back
//      silently would look like the fix never landed.

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

type OpenResult = { sRGBHex: string };

/**
 * Install a fake EyeDropper whose `open` behaves as given. It has to be a real
 * class: the module calls `new EyeDropper()`, and an arrow function is not
 * constructible.
 */
function stubEyeDropper(open: () => Promise<OpenResult>) {
  class FakeEyeDropper {
    open = open;
  }
  (window as unknown as { EyeDropper?: unknown }).EyeDropper = FakeEyeDropper;
}

/** Pretend to be (or not be) a Tauri webview, which is how the shell is probed. */
function setTauri(present: boolean) {
  const w = window as unknown as Record<string, unknown>;
  if (present) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/** Re-import so the module-scope Tauri probe and the memoized backend re-run. */
async function freshImport() {
  vi.resetModules();
  return await import("./screenDropper");
}

beforeEach(() => {
  invoke.mockReset();
  setTauri(false);
  delete (window as unknown as { EyeDropper?: unknown }).EyeDropper;
});

afterEach(() => {
  vi.resetModules();
});

describe("dropperBackend", () => {
  it("prefers native when the desktop shell reports support", async () => {
    setTauri(true);
    stubEyeDropper(async () => ({ sRGBHex: "#000000" }));
    invoke.mockResolvedValue(true);

    const { dropperBackend } = await freshImport();

    await expect(dropperBackend()).resolves.toBe("native");
    expect(invoke).toHaveBeenCalledWith("dropper_supported");
  });

  it("falls back to EyeDropper on a desktop build without native support", async () => {
    setTauri(true);
    stubEyeDropper(async () => ({ sRGBHex: "#000000" }));
    invoke.mockResolvedValue(false); // e.g. a Linux desktop build

    const { dropperBackend } = await freshImport();

    await expect(dropperBackend()).resolves.toBe("eyedropper");
  });

  it("falls back to EyeDropper when the shell lacks the command entirely", async () => {
    setTauri(true);
    stubEyeDropper(async () => ({ sRGBHex: "#000000" }));
    invoke.mockRejectedValue(new Error("unknown command"));

    const { dropperBackend } = await freshImport();

    await expect(dropperBackend()).resolves.toBe("eyedropper");
  });

  it("uses EyeDropper in a plain browser without probing the shell", async () => {
    stubEyeDropper(async () => ({ sRGBHex: "#000000" }));

    const { dropperBackend } = await freshImport();

    await expect(dropperBackend()).resolves.toBe("eyedropper");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports none when neither backend exists", async () => {
    const { dropperBackend } = await freshImport();
    await expect(dropperBackend()).resolves.toBe("none");
  });

  it("probes only once and reuses the answer", async () => {
    setTauri(true);
    invoke.mockResolvedValue(true);

    const { dropperBackend } = await freshImport();
    await Promise.all([dropperBackend(), dropperBackend(), dropperBackend()]);

    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("pickScreenColor via the native backend", () => {
  beforeEach(() => setTauri(true));

  it("returns the hex the shell picked", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "dropper_supported" ? true : "#a1b2c3",
    );

    const { pickScreenColor } = await freshImport();

    await expect(pickScreenColor()).resolves.toBe("#a1b2c3");
    expect(invoke).toHaveBeenCalledWith("dropper_pick");
  });

  it("returns null when the shell reports a cancel", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "dropper_supported" ? true : null,
    );

    const { pickScreenColor } = await freshImport();

    await expect(pickScreenColor()).resolves.toBeNull();
  });

  it("does not fall back to EyeDropper when a native pick fails", async () => {
    // A native failure is a real fault. Silently retrying through the magnifier
    // would reintroduce the lag this backend exists to avoid.
    const open = vi.fn(async () => ({ sRGBHex: "#ffffff" }));
    stubEyeDropper(open);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "dropper_supported") return true;
      throw new Error("A screen pick is already in progress.");
    });

    const { pickScreenColor } = await freshImport();

    await expect(pickScreenColor()).rejects.toThrow(/already in progress/);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("pickScreenColor via the EyeDropper backend", () => {
  it("returns the picked hex", async () => {
    stubEyeDropper(async () => ({ sRGBHex: "#a1b2c3" }));
    const { pickScreenColor } = await freshImport();
    await expect(pickScreenColor()).resolves.toBe("#a1b2c3");
  });

  it("returns null when the user dismisses with Escape", async () => {
    stubEyeDropper(async () => {
      throw new DOMException("The user canceled the selection.", "AbortError");
    });
    const { pickScreenColor } = await freshImport();
    await expect(pickScreenColor()).resolves.toBeNull();
  });

  it("rethrows a genuine failure rather than reporting a cancel", async () => {
    stubEyeDropper(async () => {
      throw new DOMException("Screen capture blocked.", "NotAllowedError");
    });
    const { pickScreenColor } = await freshImport();
    await expect(pickScreenColor()).rejects.toThrow("Screen capture blocked.");
  });

  it("forwards an abort signal so a caller can close the dropper", async () => {
    const open = vi.fn(async () => ({ sRGBHex: "#ffffff" }));
    stubEyeDropper(open);
    const { pickScreenColor } = await freshImport();
    const controller = new AbortController();

    await pickScreenColor(controller.signal);

    expect(open).toHaveBeenCalledWith({ signal: controller.signal });
  });
});

describe("pickScreenColor with no backend", () => {
  it("throws a readable error", async () => {
    const { pickScreenColor } = await freshImport();
    await expect(pickScreenColor()).rejects.toThrow(/not supported/i);
  });
});

describe("colorAtCursor", () => {
  it("samples the pixel under the cursor on the native backend", async () => {
    setTauri(true);
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "dropper_supported" ? true : "#0f0f0f",
    );

    const { colorAtCursor } = await freshImport();

    await expect(colorAtCursor()).resolves.toBe("#0f0f0f");
    expect(invoke).toHaveBeenCalledWith("dropper_color_at_cursor");
  });

  it("returns null on the EyeDropper backend, which exposes nothing to sample", async () => {
    stubEyeDropper(async () => ({ sRGBHex: "#000000" }));

    const { colorAtCursor } = await freshImport();

    await expect(colorAtCursor()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
