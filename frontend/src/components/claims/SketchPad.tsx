/**
 * Freehand sketch of the scene (docs/INCIDENT-CLAIMS-SPEC.md §10.2, D10) — a
 * bigger cousin of the book-out SignatureCapture: draw with a finger or mouse,
 * a few colours, undo, clear, and hand back a PNG. Strokes are kept as point
 * lists so undo is a redraw, not a pixel snapshot.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

const CW = 1000;
const CH = 700;
const COLOURS = [
  { key: '#111827', label: 'Black' },
  { key: '#dc2626', label: 'Red' },
  { key: '#2563eb', label: 'Blue' },
];

interface Stroke { colour: string; width: number; points: Array<[number, number]> }

export interface SketchPadHandle {
  toBlob: () => Promise<Blob | null>;
  isEmpty: () => boolean;
}

export const SketchPad = forwardRef<SketchPadHandle, { onChange?: () => void }>(function SketchPad({ onChange }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [colour, setColour] = useState(COLOURS[0].key);
  const [width, setWidth] = useState(4);
  const drawing = useRef<Stroke | null>(null);

  const redraw = useCallback((list: Stroke[]) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, CW, CH);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of list) {
      if (!s.points.length) continue;
      ctx.strokeStyle = s.colour;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(s.points[0][0], s.points[0][1]);
      for (const [x, y] of s.points.slice(1)) ctx.lineTo(x, y);
      if (s.points.length === 1) ctx.lineTo(s.points[0][0] + 0.1, s.points[0][1] + 0.1);
      ctx.stroke();
    }
  }, []);

  useEffect(() => { redraw(strokes); }, [strokes, redraw]);

  useImperativeHandle(ref, () => ({
    toBlob: () => new Promise((resolve) => {
      if (!strokes.length || !canvasRef.current) { resolve(null); return; }
      canvasRef.current.toBlob((b) => resolve(b), 'image/png');
    }),
    isEmpty: () => strokes.length === 0,
  }), [strokes]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - rect.left) / rect.width) * CW, ((e.clientY - rect.top) / rect.height) * CH];
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = { colour, width, points: [point(e)] };
    redraw([...strokes, drawing.current]);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current.points.push(point(e));
    redraw([...strokes, drawing.current]);
  };
  const up = () => {
    if (!drawing.current) return;
    const s = drawing.current;
    drawing.current = null;
    setStrokes((prev) => [...prev, s]);
    onChange?.();
  };

  const btn = 'px-3 py-2 text-sm rounded-lg border';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {COLOURS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setColour(c.key)}
            className={`${btn} ${colour === c.key ? 'ring-2 ring-offset-1 ring-ooosh-500' : ''}`}
            style={{ color: c.key }}
          >
            ● {c.label}
          </button>
        ))}
        <button type="button" onClick={() => setWidth((w) => (w === 4 ? 9 : 4))} className={btn}>{width === 4 ? 'Thin pen' : 'Thick pen'}</button>
        <button type="button" disabled={!strokes.length} onClick={() => { setStrokes((s) => s.slice(0, -1)); onChange?.(); }} className={`${btn} disabled:opacity-40`}>Undo</button>
        <button type="button" disabled={!strokes.length} onClick={() => { if (confirm('Clear the whole sketch?')) { setStrokes([]); onChange?.(); } }} className={`${btn} disabled:opacity-40`}>Clear</button>
      </div>
      <canvas
        ref={canvasRef}
        width={CW}
        height={CH}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className="w-full h-auto border-2 border-slate-300 rounded-lg bg-white touch-none"
      />
    </div>
  );
});
