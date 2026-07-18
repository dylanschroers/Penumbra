import { STORAGE_NAMESPACE } from "@penumbra/shared";
// Import from the meta package (a direct dependency) rather than the individual
// @uiw/react-color-* packages, which are transitive and not resolvable under
// pnpm's strict node_modules. It re-exports the components and color-convert.
import {
  type HsvaColor,
  hexToHsva,
  hsvaToHex,
  ShadeSlider,
  validHex,
  Wheel,
} from "@uiw/react-color";
import { useEffect, useState } from "react";

// A small, self-contained color tool: a hue/saturation wheel, a light↔dark shade
// slider, and a two-way hex box, with a click-to-copy swatch. The last color is
// remembered in localStorage. No DB, no server — pure client UI state.
const STORAGE_KEY = `${STORAGE_NAMESPACE}.color-picker.hex.v1`;
const DEFAULT_HEX = "#4f46e5"; // matches --primary
const WHEEL_SIZE = 180; // static, per design

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

  // Local draft so the user can type a partial/invalid hex without it snapping
  // back; commit to the shared color only once the value is a valid hex. When
  // the wheel/slider change the color, this resyncs to the canonical hex.
  const [draft, setDraft] = useState(hex);
  useEffect(() => setDraft(hex), [hex]);

  const [copied, setCopied] = useState(false);

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

  async function copyHex() {
    try {
      await navigator.clipboard.writeText(hex);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard unavailable (e.g. insecure context); no-op.
    }
  }

  return (
    <div className="color-picker">
      <Wheel
        color={hsva}
        width={WHEEL_SIZE}
        height={WHEEL_SIZE}
        onChange={(c) => setHsva({ ...c.hsva, a: 1 })}
      />
      <ShadeSlider
        hsva={hsva}
        width={WHEEL_SIZE}
        onChange={(newShade) => setHsva({ ...hsva, ...newShade })}
      />
      <div className="color-picker__row">
        <button
          type="button"
          className="color-picker__swatch"
          style={{ background: hex }}
          onClick={copyHex}
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
        <span className="color-picker__copied" aria-live="polite">
          {copied ? "Copied!" : ""}
        </span>
      </div>
    </div>
  );
}
