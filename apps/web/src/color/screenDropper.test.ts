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
//   3. Picking and live sampling are separate capabilities. A backend that
//      picks but cannot sample is the *expected* shape everywhere except
//      Windows, so `liveSample` must never be inferred from `backend`.

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

/** What the Windows shell reports: it built the interaction, so it can do both. */
const CAPABLE = { pick: true, liveSample: true };
/** A portal-style backend: it owns the picker, so there is nothing to poll. */
const PICK_ONLY = { pick: true, liveSample: false };
/** A shell with no native backend at all — today's Linux and macOS builds. */
const NO_NATIVE = { pick: false, liveSample: false };

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

describe("dropperSupport", () => {
  it("prefers native when the desktop shell reports it can pick", async () => {
    setTauri(true);
    stubEyeDropper(async () => ({ sRGBHex: "#000000" }));
    invoke.mockResolvedValue(CAPABLE);

    const { dropperSupport } = await freshImport();

    await expect(dropperSupport()).resolves.toEqual({
      backend: "native",
      liveSample: true,
    });
    expect(invoke).toHaveBeenCalledWith("dropper_capabilities");
  });

  it("keeps a native backend that cannot sample live", async () => {
    // The portal/NSColorSampler shape. Losing the readout must not cost the
    // pick — falling back to EyeDropper here would trade the fast path for the
    // laggy one to regain a readout EyeDropper does not have either.
    setTauri(true);
    stubEyeDropper(async () => ({ sRGBHex: "#000000" }));
    invoke.mockResolvedValue(PICK_ONLY);

    const { dropperSupport } = await freshImport();

    await expect(dropperSupport()).resolves.toEqual({
      backend: "native",
      liveSample: false,
    });
  });

  it("falls back to EyeDropper on a desktop build without native support", async () => {
    setTauri(true);
    stubEyeDropper(async () => ({ sRGBHex: "#000000" }));
    invoke.mockResolvedValue(NO_NATIVE); // today's Linux and macOS builds

    const { dropperSupport } = await freshImport();

    await expect(dropperSupport()).resolves.toEqual({
      backend: "eyedropper",
      liveSample: false,
    });
  });

  it("falls back to EyeDropper when the shell lacks the command entirely", async () => {
    // Covers a shell older than the dropper *and* one older than this
    // capability split, which answered `dropper_supported` and nothing else.
    setTauri(true);
    stubEyeDropper(async () => ({ sRGBHex: "#000000" }));
    invoke.mockRejectedValue(new Error("unknown command"));

    const { dropperSupport } = await freshImport();

    await expect(dropperSupport()).resolves.toMatchObject({
      backend: "eyedropper",
    });
  });

  it("uses EyeDropper in a plain browser without probing the shell", async () => {
    stubEyeDropper(async () => ({ sRGBHex: "#000000" }));

    const { dropperSupport } = await freshImport();

    await expect(dropperSupport()).resolves.toMatchObject({
      backend: "eyedropper",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports none when neither backend exists", async () => {
    const { dropperSupport } = await freshImport();
    await expect(dropperSupport()).resolves.toEqual({
      backend: "none",
      liveSample: false,
    });
  });

  it("never claims a live sample without a native backend", async () => {
    // The invariant the split exists to protect: only the native path can ever
    // answer colorAtCursor, so liveSample must be false everywhere else no
    // matter what the shell said.
    setTauri(true);
    stubEyeDropper(async () => ({ sRGBHex: "#000000" }));
    invoke.mockResolvedValue({ pick: false, liveSample: true });

    const { dropperSupport } = await freshImport();

    await expect(dropperSupport()).resolves.toEqual({
      backend: "eyedropper",
      liveSample: false,
    });
  });

  it("probes only once and reuses the answer", async () => {
    setTauri(true);
    invoke.mockResolvedValue(CAPABLE);

    const { dropperSupport } = await freshImport();
    await Promise.all([dropperSupport(), dropperSupport(), dropperSupport()]);

    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("pickScreenColor via the native backend", () => {
  beforeEach(() => setTauri(true));

  it("returns the hex the shell picked", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "dropper_capabilities" ? CAPABLE : "#a1b2c3",
    );

    const { pickScreenColor } = await freshImport();

    await expect(pickScreenColor()).resolves.toBe("#a1b2c3");
    expect(invoke).toHaveBeenCalledWith("dropper_pick");
  });

  it("returns null when the shell reports a cancel", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "dropper_capabilities" ? CAPABLE : null,
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
      if (cmd === "dropper_capabilities") return CAPABLE;
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
      cmd === "dropper_capabilities" ? CAPABLE : "#0f0f0f",
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

  it("returns null on a native backend that owns its own picker", async () => {
    // The case the whole split exists for. Before it, a native backend implied
    // a live sample, so a portal-style dropper would have had this polled at
    // 60ms against a command that can only ever error.
    setTauri(true);
    invoke.mockResolvedValue(PICK_ONLY);

    const { colorAtCursor } = await freshImport();

    await expect(colorAtCursor()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("dropper_color_at_cursor");
  });

  it("still picks on that backend, just without the readout", async () => {
    setTauri(true);
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "dropper_capabilities" ? PICK_ONLY : "#c0ffee",
    );

    const { pickScreenColor } = await freshImport();

    await expect(pickScreenColor()).resolves.toBe("#c0ffee");
    expect(invoke).toHaveBeenCalledWith("dropper_pick");
  });
});
