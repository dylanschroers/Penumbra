import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { type PixelBlock, WHITE } from "./engine";
import { copyImage, decodeImage, readClipboardImage, savePng } from "./imageIo";
import { PaintCanvas } from "./PaintCanvas";
import { usePaint } from "./PaintProvider";
import {
  PaintActionBar,
  type PaintActions,
  PaintColors,
  PaintTools,
} from "./PaintToolbar";
import { createRaster, hexToPixel } from "./raster";

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const isTextField = (target: EventTarget) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement;

/** The windowed view: the full drawing tool. */
export function PaintExpanded() {
  const { engine, secondary } = usePaint();
  const [status, setStatus] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  // Copies made here, for pasting when the system clipboard can't be read.
  const clip = useRef<PixelBlock | null>(null);
  const pasteEventFired = useRef(false);

  // WebKit only sends `paste` to a non-editable element if `beforepaste` was
  // cancelled first. React has no prop for it.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const allow = (e: Event) => {
      if (!isTextField(e.target as EventTarget)) e.preventDefault();
    };
    root.addEventListener("beforepaste", allow);
    return () => root.removeEventListener("beforepaste", allow);
  }, []);

  function copy() {
    const block = engine.copyBlock();
    clip.current = block;
    const copied = engine.selection ? "Copied selection" : "Copied canvas";
    copyImage(block).then(
      () => setStatus(copied),
      () => setStatus("Copied inside Paint only: clipboard unavailable"),
    );
  }

  function cut() {
    if (!engine.selection) return;
    copy();
    engine.deleteSelection(hexToPixel(secondary));
  }

  function pasteInternal() {
    if (clip.current) {
      engine.paste({ ...clip.current, px: clip.current.px.slice() });
      setStatus("");
    } else {
      setStatus("Nothing to paste");
    }
  }

  async function pasteFromApi() {
    const block = await readClipboardImage();
    if (block) {
      engine.paste(block);
      setStatus("");
    } else {
      pasteInternal();
    }
  }

  function onPasteEvent(e: ClipboardEvent) {
    if (isTextField(e.target)) return;
    pasteEventFired.current = true;
    const file = [...e.clipboardData.files].find((f) =>
      f.type.startsWith("image/"),
    );
    e.preventDefault();
    if (!file) {
      pasteInternal();
      return;
    }
    decodeImage(file).then(
      (block) => engine.paste(block),
      (err) => setStatus(message(err)),
    );
  }

  const actions: PaintActions = {
    onNew: () => {
      engine.replace(createRaster(engine.width, engine.height, WHITE));
      setStatus("");
    },
    onOpen: (file) => {
      decodeImage(file).then(
        (block) => {
          engine.replace({ width: block.w, height: block.h, px: block.px });
          setStatus(`Opened ${file.name}`);
        },
        (err) => setStatus(message(err)),
      );
    },
    onSave: () => {
      engine.commitSelection();
      savePng({
        w: engine.width,
        h: engine.height,
        px: engine.committed.px,
      }).then(
        (path) => {
          if (path === null) return;
          setStatus(path ? `Saved to ${path}` : "Downloaded drawing.png");
        },
        (err) => setStatus(message(err)),
      );
    },
    onCut: cut,
    onCopy: copy,
    onPaste: () => void pasteFromApi(),
  };

  function onKeyDown(e: KeyboardEvent) {
    if (isTextField(e.target)) return;
    if (e.key === "Escape") {
      engine.cancel();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (engine.selection) {
        e.preventDefault();
        engine.deleteSelection(hexToPixel(secondary));
      }
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "z") {
      e.preventDefault();
      if (e.shiftKey) engine.redo();
      else engine.undo();
    } else if (key === "y") {
      e.preventDefault();
      engine.redo();
    } else if (key === "x") {
      e.preventDefault();
      cut();
    } else if (key === "c") {
      e.preventDefault();
      copy();
    } else if (key === "a") {
      e.preventDefault();
      engine.selectAll();
    } else if (key === "v") {
      // Left to the browser, so `paste` can carry the image. Where it never
      // arrives (see the WebKit note above), read the clipboard directly.
      pasteEventFired.current = false;
      window.setTimeout(() => {
        if (!pasteEventFired.current) void pasteFromApi();
      }, 50);
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a focus scope, so shortcuts only apply while Paint has focus
    <div
      ref={rootRef}
      className="paint"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: see above
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPaste={onPasteEvent}
    >
      <PaintActionBar
        actions={actions}
        onResize={(w, h) => engine.resize(w, h, hexToPixel(secondary))}
      />
      <div className="paint__main">
        <PaintTools />
        <div className="paint__work">
          <PaintCanvas status={status} />
        </div>
      </div>
      <PaintColors />
    </div>
  );
}
