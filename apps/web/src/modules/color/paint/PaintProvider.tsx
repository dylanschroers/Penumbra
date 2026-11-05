import { STORAGE_NAMESPACE } from "@penumbra/shared";
import {
  type HsvaColor,
  hexToHsva,
  hsvaToHex,
  validHex,
} from "@uiw/react-color";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { PaintEngine, type Tool } from "./engine";
import { loadCanvas, saveCanvas } from "./persist";

// The one state owner for the color module (workspace/types.ts → SplitViewModule):
// the dock's picker and the windowed Paint both read and set the same color, and
// the drawing outlives the window being closed back to the dock.

const STORAGE_KEY = `${STORAGE_NAMESPACE}.color-picker.hex.v1`;
const DEFAULT_HEX = "#4f46e5"; // matches --primary
const AUTOSAVE_DELAY_MS = 800;

function loadHsva(): HsvaColor {
  try {
    const hex = localStorage.getItem(STORAGE_KEY);
    if (hex && validHex(hex)) return hexToHsva(hex);
  } catch {
    // Ignore unavailable/blocked storage; fall back to the default.
  }
  return hexToHsva(DEFAULT_HEX);
}

interface PaintContextValue {
  engine: PaintEngine;
  /** The primary color. Held as HSV so hue survives a trip through black. */
  hsva: HsvaColor;
  setHsva: (next: HsvaColor) => void;
  hex: string;
  secondary: string;
  setSecondary: (hex: string) => void;
  swapColors: () => void;
  tool: Tool;
  setTool: (tool: Tool) => void;
  size: number;
  setSize: (size: number) => void;
  filled: boolean;
  setFilled: (filled: boolean) => void;
  zoom: number;
  setZoom: (zoom: number) => void;
  fontSize: number;
  setFontSize: (size: number) => void;
}

const PaintContext = createContext<PaintContextValue | null>(null);

export function usePaint(): PaintContextValue {
  const value = useContext(PaintContext);
  if (!value) throw new Error("usePaint needs a PaintProvider above it.");
  return value;
}

export function PaintProvider({ children }: { children: ReactNode }) {
  const [engine] = useState(() => new PaintEngine());
  const [hsva, setHsva] = useState<HsvaColor>(loadHsva);
  const [secondary, setSecondary] = useState("#ffffff");
  const [tool, setToolState] = useState<Tool>("pencil");
  const [size, setSize] = useState(3);
  const [filled, setFilled] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fontSize, setFontSize] = useState(24);
  const hex = hsvaToHex(hsva);

  // Persist the chosen color on every change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, hex);
    } catch {
      // Ignore quota/serialization errors; the in-memory color still works.
    }
  }, [hex]);

  useEffect(() => {
    let live = true;
    void loadCanvas().then((saved) => {
      // Drawing started before the load landed wins over the older save.
      if (live && saved && engine.revision === 0 && !engine.busy) {
        engine.restore(saved);
      }
    });

    let savedRevision = engine.revision;
    let timer: number | null = null;
    const flush = () => {
      timer = null;
      savedRevision = engine.revision;
      void saveCanvas(engine.committed);
    };
    const unsubscribe = engine.subscribe(() => {
      if (engine.revision === savedRevision || timer !== null) return;
      timer = window.setTimeout(flush, AUTOSAVE_DELAY_MS);
    });
    return () => {
      live = false;
      unsubscribe();
      if (timer !== null) {
        clearTimeout(timer);
        flush();
      }
    };
  }, [engine]);

  const value = useMemo<PaintContextValue>(
    () => ({
      engine,
      hsva,
      setHsva,
      hex,
      secondary,
      setSecondary,
      swapColors: () => {
        setHsva(hexToHsva(secondary));
        setSecondary(hex);
      },
      tool,
      setTool: (next) => {
        if (next !== "select") engine.commitSelection();
        setToolState(next);
      },
      size,
      setSize,
      filled,
      setFilled,
      zoom,
      setZoom,
      fontSize,
      setFontSize,
    }),
    [engine, hsva, hex, secondary, tool, size, filled, zoom, fontSize],
  );

  return (
    <PaintContext.Provider value={value}>{children}</PaintContext.Provider>
  );
}
