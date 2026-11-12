import { hexToHsva } from "@uiw/react-color";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ColorPickerModule } from "../ColorPickerModule";
import type { Tool } from "./engine";
import { usePaint } from "./PaintProvider";
import { hexToPixel } from "./raster";

const TOOLS: { id: Tool; label: string; glyph: string }[] = [
  { id: "pencil", label: "Pencil", glyph: "✏️" },
  { id: "brush", label: "Brush", glyph: "🖌️" },
  { id: "eraser", label: "Eraser", glyph: "🧽" },
  { id: "fill", label: "Fill", glyph: "🪣" },
  { id: "picker", label: "Pick a color from the canvas", glyph: "💉" },
  { id: "text", label: "Text", glyph: "A" },
  { id: "line", label: "Line", glyph: "╱" },
  { id: "rect", label: "Rectangle", glyph: "▭" },
  { id: "ellipse", label: "Ellipse", glyph: "◯" },
  { id: "select", label: "Select", glyph: "⬚" },
];

const SIZES = [1, 3, 5, 9, 15, 25];
const FONT_SIZES = [12, 16, 24, 36, 48, 72];
const ZOOMS = [1, 2, 4, 8];

const PALETTE = [
  "#000000",
  "#7f7f7f",
  "#880015",
  "#ed1c24",
  "#ff7f27",
  "#fff200",
  "#22b14c",
  "#00a2e8",
  "#3f48cc",
  "#a349a4",
  "#b97a57",
  "#ff00ff",
  "#008080",
  "#800000",
  "#ffffff",
  "#c3c3c3",
  "#b5a2a2",
  "#ffaec9",
  "#ffc90e",
  "#efe4b0",
  "#b5e61d",
  "#99d9ea",
  "#7092be",
  "#c8bfe7",
  "#d2b48c",
  "#ffc0cb",
  "#40e0d0",
  "#000080",
];

export interface PaintActions {
  onNew: () => void;
  onOpen: (file: File) => void;
  onSave: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
}

const showsSize = (tool: Tool) =>
  ["brush", "eraser", "line", "rect", "ellipse"].includes(tool);

export function PaintActionBar({
  actions,
  onResize,
}: {
  actions: PaintActions;
  onResize: (w: number, h: number) => void;
}) {
  const { engine, zoom, setZoom, secondary } = usePaint();
  useSyncExternalStore(engine.subscribe, engine.getVersion);
  const fileRef = useRef<HTMLInputElement>(null);
  const rotateTarget = engine.selection ? "selection" : "canvas";

  return (
    <div className="paint__bar">
      <button type="button" className="paint__btn" onClick={actions.onNew}>
        New
      </button>
      <button
        type="button"
        className="paint__btn"
        onClick={() => fileRef.current?.click()}
      >
        Open
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        aria-label="Open an image"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) actions.onOpen(file);
        }}
      />
      <button type="button" className="paint__btn" onClick={actions.onSave}>
        Save
      </button>
      <span className="paint__sep" />
      <button
        type="button"
        className="paint__btn"
        disabled={!engine.history.canUndo && !engine.selection?.float}
        onClick={() => engine.undo()}
      >
        Undo
      </button>
      <button
        type="button"
        className="paint__btn"
        disabled={!engine.history.canRedo}
        onClick={() => engine.redo()}
      >
        Redo
      </button>
      <span className="paint__sep" />
      <button
        type="button"
        className="paint__btn"
        disabled={!engine.selection}
        onClick={actions.onCut}
      >
        Cut
      </button>
      <button
        type="button"
        className="paint__btn"
        title={
          engine.selection ? "Copy the selection" : "Copy the whole canvas"
        }
        onClick={actions.onCopy}
      >
        Copy
      </button>
      <button type="button" className="paint__btn" onClick={actions.onPaste}>
        Paste
      </button>
      <span className="paint__sep" />
      <button
        type="button"
        className="paint__btn"
        aria-label={`Rotate ${rotateTarget} left`}
        title={`Rotate the ${rotateTarget} 90° left`}
        onClick={() => engine.rotate(false, hexToPixel(secondary))}
      >
        ↺
      </button>
      <button
        type="button"
        className="paint__btn"
        aria-label={`Rotate ${rotateTarget} right`}
        title={`Rotate the ${rotateTarget} 90° right`}
        onClick={() => engine.rotate(true, hexToPixel(secondary))}
      >
        ↻
      </button>
      <span className="paint__sep" />
      <label className="paint__field">
        Zoom
        <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
          {ZOOMS.map((z) => (
            <option key={z} value={z}>
              {z}x
            </option>
          ))}
        </select>
      </label>
      <DimensionInputs
        width={engine.width}
        height={engine.height}
        onResize={onResize}
      />
    </div>
  );
}

function DimensionInputs({
  width,
  height,
  onResize,
}: {
  width: number;
  height: number;
  onResize: (w: number, h: number) => void;
}) {
  const [w, setW] = useState(String(width));
  const [h, setH] = useState(String(height));
  useEffect(() => {
    setW(String(width));
    setH(String(height));
  }, [width, height]);

  function apply() {
    const nextW = Number(w);
    const nextH = Number(h);
    if (nextW > 0 && nextH > 0) onResize(nextW, nextH);
    else {
      setW(String(width));
      setH(String(height));
    }
  }

  const props = {
    type: "number",
    min: 1,
    max: 2048,
    className: "paint__number",
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") apply();
    },
  };

  return (
    <fieldset
      aria-label="Canvas size"
      className="paint__field paint__size"
      // Only on leaving the pair: tabbing from width to height is one resize, and
      // applying the width alone would crop to a size nobody asked for.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) apply();
      }}
    >
      <input
        {...props}
        aria-label="Canvas width"
        value={w}
        onChange={(e) => setW(e.target.value)}
      />
      ×
      <input
        {...props}
        aria-label="Canvas height"
        value={h}
        onChange={(e) => setH(e.target.value)}
      />
    </fieldset>
  );
}

export function PaintTools() {
  const {
    tool,
    setTool,
    size,
    setSize,
    filled,
    setFilled,
    fontSize,
    setFontSize,
  } = usePaint();

  return (
    <div className="paint__tools">
      <div className="paint__tool-grid">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="paint__tool"
            aria-label={t.label}
            title={t.label}
            aria-pressed={tool === t.id}
            onClick={() => setTool(t.id)}
          >
            {t.glyph}
          </button>
        ))}
      </div>
      {showsSize(tool) ? (
        <label className="paint__option">
          Size
          <select
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          >
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s}px
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {tool === "rect" || tool === "ellipse" ? (
        <label className="paint__option">
          <input
            type="checkbox"
            checked={filled}
            onChange={(e) => setFilled(e.target.checked)}
          />
          Filled
        </label>
      ) : null}
      {tool === "text" ? (
        <label className="paint__option">
          Font
          <select
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
          >
            {FONT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}px
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

export function PaintColors() {
  const { hex, setHsva, secondary, setSecondary, swapColors } = usePaint();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="paint__colors" ref={rootRef}>
      <button
        type="button"
        className="paint__swatch paint__swatch--primary"
        style={{ background: hex }}
        aria-label={`Primary color ${hex}, open the color picker`}
        title="Primary color: click for the color picker"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      <button
        type="button"
        className="paint__swatch"
        style={{ background: secondary }}
        aria-label={`Secondary color ${secondary}, swap with primary`}
        title="Secondary color: click to swap"
        onClick={swapColors}
      />
      <div className="paint__palette">
        {PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            className="paint__chip"
            style={{ background: color }}
            aria-label={`Use ${color}`}
            title={`${color}: click for primary, right click for secondary`}
            onClick={() => setHsva(hexToHsva(color))}
            onContextMenu={(e) => {
              e.preventDefault();
              setSecondary(color);
            }}
          />
        ))}
      </div>
      {open ? (
        <div className="paint__popover">
          <ColorPickerModule />
        </div>
      ) : null}
    </div>
  );
}
