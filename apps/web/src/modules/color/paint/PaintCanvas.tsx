import { hexToHsva } from "@uiw/react-color";
import {
  type PointerEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { renderText } from "./imageIo";
import { usePaint } from "./PaintProvider";
import { hexToPixel } from "./raster";

/** The on-screen canvas, its selection overlay, its text box and the status bar.
 *  `status` is the latest message from a toolbar action. */
export function PaintCanvas({ status }: { status: string }) {
  const paint = usePaint();
  const { engine, tool, zoom, fontSize, hex, secondary } = paint;
  useSyncExternalStore(engine.subscribe, engine.getVersion);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const positionRef = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState<{
    x: number;
    y: number;
    value: string;
  } | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const skipTextPlace = useRef(false);
  const picking = useRef<"primary" | "secondary" | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let image: ImageData | null = null;
    let frame = 0;

    const draw = () => {
      frame = 0;
      const { working } = engine;
      let rect = engine.takeViewDirty();
      if (canvas.width !== working.width || canvas.height !== working.height) {
        canvas.width = working.width;
        canvas.height = working.height;
        image = null;
      }
      if (image?.data.buffer !== working.px.buffer) {
        image = new ImageData(
          new Uint8ClampedArray(working.px.buffer as ArrayBuffer),
          working.width,
          working.height,
        );
        rect = { x: 0, y: 0, w: working.width, h: working.height };
      }
      if (rect) ctx.putImageData(image, 0, 0, rect.x, rect.y, rect.w, rect.h);
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(draw);
    };

    draw();
    const unsubscribe = engine.subscribeView(schedule);
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [engine]);

  function toDoc(e: PointerEvent) {
    const box = canvasRef.current!.getBoundingClientRect();
    // Rounded because the canvas paints snapped to whole pixels however fractional
    // its layout box. WebKit's integer clientX would otherwise land one to the left.
    const left = Math.round(box.left);
    const top = Math.round(box.top);
    return {
      x: Math.floor(((e.clientX - left) / box.width) * engine.width),
      y: Math.floor(((e.clientY - top) / box.height) * engine.height),
    };
  }

  function sample(x: number, y: number) {
    const color = engine.colorAt(x, y);
    if (!color) return;
    if (picking.current === "primary") paint.setHsva(hexToHsva(color));
    else paint.setSecondary(color);
  }

  function finishText() {
    const current = textRef.current;
    if (!current) return;
    textRef.current = null;
    setText(null);
    const rendered = renderText(current.value, fontSize, hex);
    if (rendered) {
      engine.stampRgba(
        current.x,
        current.y,
        rendered.w,
        rendered.h,
        rendered.rgba,
      );
    }
  }

  function onPointerDown(e: PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0 && e.button !== 2) return;
    const useSecondary = e.button === 2 || e.ctrlKey;
    const { x, y } = toDoc(e);
    e.currentTarget.setPointerCapture(e.pointerId);

    if (tool === "text") {
      skipTextPlace.current = textRef.current !== null;
      return;
    }
    if (tool === "picker") {
      picking.current = useSecondary ? "secondary" : "primary";
      sample(x, y);
      return;
    }
    engine.begin(
      tool,
      x,
      y,
      {
        color: hexToPixel(useSecondary ? secondary : hex),
        back: hexToPixel(useSecondary ? hex : secondary),
        size: paint.size,
        filled: paint.filled,
      },
      e.shiftKey,
    );
  }

  function onPointerMove(e: PointerEvent<HTMLCanvasElement>) {
    const { x, y } = toDoc(e);
    if (positionRef.current) positionRef.current.textContent = `${x}, ${y}`;
    if (picking.current) {
      sample(x, y);
    } else if (engine.busy) {
      engine.move(x, y, e.shiftKey);
    } else {
      const s = engine.selection;
      const over =
        tool === "select" &&
        s &&
        x >= s.rect.x &&
        y >= s.rect.y &&
        x < s.rect.x + s.rect.w &&
        y < s.rect.y + s.rect.h;
      e.currentTarget.style.cursor = over ? "move" : "";
    }
  }

  function onPointerUp(e: PointerEvent<HTMLCanvasElement>) {
    picking.current = null;
    if (engine.busy) engine.end();
    if (tool !== "text" || e.button !== 0) return;
    if (skipTextPlace.current) {
      skipTextPlace.current = false;
      return;
    }
    setText({ ...toDoc(e), value: "" });
  }

  const selection = engine.selection;

  return (
    <>
      <div className="paint__stage">
        <div
          className="paint__sheet"
          style={{
            width: engine.width * zoom,
            height: engine.height * zoom,
          }}
        >
          <canvas
            ref={canvasRef}
            className="paint__canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              if (positionRef.current) positionRef.current.textContent = "";
            }}
            onContextMenu={(e) => e.preventDefault()}
          />
          {selection ? (
            <div
              className="paint__selection"
              style={{
                left: selection.rect.x * zoom,
                top: selection.rect.y * zoom,
                width: selection.rect.w * zoom,
                height: selection.rect.h * zoom,
              }}
            />
          ) : null}
          {text ? (
            <input
              className="paint__text"
              // biome-ignore lint/a11y/noAutofocus: the box exists only to be typed into, and appears on the user's click
              autoFocus
              aria-label="Text to place on the canvas"
              value={text.value}
              spellCheck={false}
              size={Math.max(4, text.value.length + 1)}
              style={{
                left: text.x * zoom,
                top: text.y * zoom,
                color: hex,
                fontSize: fontSize * zoom,
              }}
              onChange={(e) => setText({ ...text, value: e.target.value })}
              onBlur={finishText}
              onKeyDown={(e) => {
                if (e.key === "Enter") finishText();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  textRef.current = null;
                  setText(null);
                }
              }}
            />
          ) : null}
        </div>
      </div>
      <div className="paint__status">
        <span>
          {engine.width} × {engine.height}
        </span>
        <span ref={positionRef} />
        <span className="paint__status-message" aria-live="polite">
          {status}
        </span>
      </div>
    </>
  );
}
