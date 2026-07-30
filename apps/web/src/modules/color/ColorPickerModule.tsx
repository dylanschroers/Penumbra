import { STORAGE_NAMESPACE } from "@penumbra/shared";
// Import from the meta package (a direct dependency) rather than the individual
// @uiw/react-color-* packages, which are transitive and not resolvable under
// pnpm's strict node_modules. It re-exports the components and color-convert.
import {
  type HsvaColor,
  hexToHsva,
  hsvaToHex,
  hsvaToHsla,
  hsvaToRgba,
  ShadeSlider,
  validHex,
  Wheel,
} from "@uiw/react-color";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import {
  colorAtCursor,
  type DropperBackend,
  dropperBackend,
  pickScreenColor,
} from "../../color/screenDropper";

// A small, self-contained color tool: a hue/saturation wheel, a light↔dark shade
// slider, a two-way hex box, and a screen dropper for sampling any pixel on any
// monitor, with click-to-copy for hex/rgb/hsl. The last color is remembered in
// localStorage. No DB, no server — pure client UI state.
const STORAGE_KEY = `${STORAGE_NAMESPACE}.color-picker.hex.v1`;
const DEFAULT_HEX = "#4f46e5"; // matches --primary
const WHEEL_SIZE = 180; // static, per design

// How often to sample the pixel under the cursor while the native dropper is
// open. Fast enough to feel live, and each tick is a single GDI read.
const PREVIEW_INTERVAL_MS = 40;

function loadHsva(): HsvaColor {
  try {
    const hex = localStorage.getItem(STORAGE_KEY);
    if (hex && validHex(hex)) return hexToHsva(hex);
  } catch {
    // Ignore unavailable/blocked storage; fall back to the default.
  }
  return hexToHsva(DEFAULT_HEX);
}

export function ColorPickerModule() {
  const [hsva, setHsva] = useState<HsvaColor>(loadHsva);
  const hex = hsvaToHex(hsva);
  // Rounded by hand: the library's *String helpers emit raw floats
  // ("hsl(310.049…)"), which read terribly in the chips.
  const rgba = hsvaToRgba(hsva);
  const rgb = `rgb(${Math.round(rgba.r)}, ${Math.round(rgba.g)}, ${Math.round(rgba.b)})`;
  const hsla = hsvaToHsla(hsva);
  const hsl = `hsl(${Math.round(hsla.h)}, ${Math.round(hsla.s)}%, ${Math.round(hsla.l)}%)`;

  // Local draft so the user can type a partial/invalid hex without it snapping
  // back; commit to the shared color only once the value is a valid hex. When
  // the wheel/slider change the color, this resyncs to the canonical hex.
  const [draft, setDraft] = useState(hex);
  useEffect(() => setDraft(hex), [hex]);

  // Which value was just copied (hex/rgb/hsl string), for inline feedback.
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);

  // Dropper state. `picking` guards against opening a second dropper while one
  // is already up, and drives the button's pressed styling. `dropperError`
  // holds the rare hard failure — no supported backend, or a screen read that
  // fails — so it can be shown rather than swallowed.
  const [picking, setPicking] = useState(false);
  const [dropperError, setDropperError] = useState<string | null>(null);

  // Which backend is available is only knowable asynchronously (it asks the
  // desktop shell), so it starts null and the button stays disabled until the
  // probe lands.
  const [backend, setBackend] = useState<DropperBackend | null>(null);
  useEffect(() => {
    let active = true;
    dropperBackend().then(
      (found) => active && setBackend(found),
      () => active && setBackend("none"),
    );
    return () => {
      active = false;
    };
  }, []);

  // The color under the cursor while picking. The native dropper has no
  // magnifier — that overlay was the thing making this lag — so this readout is
  // what replaces it. Held separately from `hsva` so cancelling leaves the
  // committed color untouched.
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!picking || backend !== "native") return;
    let active = true;
    const id = window.setInterval(async () => {
      try {
        const sample = await colorAtCursor();
        if (active && sample) setPreview(sample);
      } catch {
        // A sample can fail transiently (the cursor between monitors, a
        // locking screen). Keep showing the last good one.
      }
    }, PREVIEW_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(id);
      setPreview(null);
    };
  }, [picking, backend]);

  // Persist the chosen color on every change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, hex);
    } catch {
      // Ignore quota/serialization errors; the in-memory color still works.
    }
  }, [hex]);

  function onHexChange(value: string) {
    const next = value.startsWith("#") ? value : `#${value}`;
    setDraft(next);
    if (validHex(next)) setHsva({ ...hexToHsva(next), a: 1 });
  }

  // One pick per click: the dropper ends itself after the user clicks a pixel,
  // and `picking` keeps the button inert until then. A cancel yields null and
  // simply leaves the current color alone.
  async function pickFromScreen() {
    if (picking || !backend || backend === "none") return;
    setPicking(true);
    setDropperError(null);
    try {
      const picked = await pickScreenColor();
      if (picked && validHex(picked)) setHsva({ ...hexToHsva(picked), a: 1 });
    } catch (err) {
      setDropperError(
        err instanceof Error ? err.message : "Could not read the screen color.",
      );
    } finally {
      setPicking(false);
    }
  }

  async function copyValue(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(null), 1200);
    } catch {
      // Clipboard unavailable (e.g. insecure context); no-op.
    }
  }

  return (
    <div
      className="color-picker"
      style={{ "--cp-color": hex } as CSSProperties}
    >
      <Wheel
        color={hsva}
        width={WHEEL_SIZE}
        height={WHEEL_SIZE}
        onChange={(c) => setHsva({ ...c.hsva, a: 1 })}
      />
      <ShadeSlider
        hsva={hsva}
        width={WHEEL_SIZE}
        height={12}
        radius={999}
        onChange={(newShade) => setHsva({ ...hsva, ...newShade })}
      />
      <div className="color-picker__row">
        <button
          type="button"
          className="color-picker__swatch"
          // While the dropper is open this tracks the pixel under the cursor;
          // the committed color is what a click copies.
          style={{ background: preview ?? hex }}
          onClick={() => copyValue(hex)}
          aria-label="Copy hex to clipboard"
          title="Copy hex"
        />
        <input
          className="color-picker__hex"
          value={draft}
          onChange={(e) => onHexChange(e.target.value)}
          spellCheck={false}
          aria-label="Hex color"
        />
        <button
          type="button"
          className="btn color-picker__dropper"
          onClick={pickFromScreen}
          disabled={!backend || backend === "none" || picking}
          aria-pressed={picking}
          title={
            backend === "none"
              ? "Screen picking needs the desktop app or a Chromium browser"
              : "Pick a color from anywhere on screen"
          }
          aria-label="Pick a color from anywhere on screen"
        >
          💧
        </button>
        <button
          type="button"
          className="color-picker__copy"
          onClick={() => copyValue(hex)}
          aria-live="polite"
        >
          {copied === hex ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <div className="color-picker__meta">
        <button
          type="button"
          className="color-picker__chip"
          onClick={() => copyValue(rgb)}
          title="Copy rgb()"
        >
          {copied === rgb ? "Copied ✓" : rgb}
        </button>
        <button
          type="button"
          className="color-picker__chip"
          onClick={() => copyValue(hsl)}
          title="Copy hsl()"
        >
          {copied === hsl ? "Copied ✓" : hsl}
        </button>
      </div>

      <p
        className={`color-picker__status${
          dropperError ? " color-picker__status--error" : ""
        }`}
        aria-live="polite"
      >
        {dropperError ??
          (picking ? (
            <>
              {preview ? (
                <code className="color-picker__preview">{preview}</code>
              ) : null}
              {/* The native hook eats the next click wherever it lands, so
                  clicking this panel would pick, not cancel. Say so. */}
              <span>Click anywhere to pick, Esc to cancel.</span>
            </>
          ) : (
            ""
          ))}
      </p>
    </div>
  );
}
