import { useEffect, useRef, useState } from 'react';

const MIN_SCALE = 1;
const MAX_SCALE = 6;

export interface ImageLightboxProps {
  /** Image source — typically an object URL from an authenticated blob fetch. */
  src: string;
  alt?: string;
  /** Filename for the Download button. Omit to hide the button. */
  filename?: string;
  onClose: () => void;
}

/**
 * Full-screen image viewer with zoom + pan. Scroll wheel / pinch to zoom,
 * drag (or one-finger when zoomed) to pan, double-click/tap to toggle,
 * +/− buttons, optional Download, Escape or backdrop click to close.
 *
 * Adapted from the vehicle module's HireRecordPage lightbox so damage
 * photos can be magnified into a specific dent rather than just scaled
 * to the viewport. Caller owns the src lifecycle (revoke object URLs
 * after close).
 */
export default function ImageLightbox({ src, alt, filename, onClose }: ImageLightboxProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Mutable interaction state for native (non-passive) listeners.
  const g = useRef({ scale: 1, dragging: false, lastX: 0, lastY: 0, pinchDist: 0, pinchStartScale: 1 });

  useEffect(() => { g.current.scale = scale; }, [scale]);

  const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  const applyScale = (next: number) => {
    const s = clamp(next);
    setScale(s);
    if (s === 1) setOffset({ x: 0, y: 0 });
  };

  // Native listeners so we can preventDefault (page scroll / browser pinch).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      applyScale(g.current.scale * (e.deltaY < 0 ? 1.15 : 0.87));
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0]!.clientX - e.touches[1]!.clientX;
        const dy = e.touches[0]!.clientY - e.touches[1]!.clientY;
        g.current.pinchDist = Math.hypot(dx, dy);
        g.current.pinchStartScale = g.current.scale;
      } else if (e.touches.length === 1) {
        g.current.dragging = true;
        g.current.lastX = e.touches[0]!.clientX;
        g.current.lastY = e.touches[0]!.clientY;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && g.current.pinchDist > 0) {
        e.preventDefault();
        const dx = e.touches[0]!.clientX - e.touches[1]!.clientX;
        const dy = e.touches[0]!.clientY - e.touches[1]!.clientY;
        applyScale(g.current.pinchStartScale * (Math.hypot(dx, dy) / g.current.pinchDist));
      } else if (e.touches.length === 1 && g.current.dragging && g.current.scale > 1) {
        e.preventDefault();
        const t = e.touches[0]!;
        const ndx = t.clientX - g.current.lastX;
        const ndy = t.clientY - g.current.lastY;
        g.current.lastX = t.clientX;
        g.current.lastY = t.clientY;
        setOffset(o => ({ x: o.x + ndx, y: o.y + ndy }));
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) { g.current.dragging = false; g.current.pinchDist = 0; }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (scale <= 1) return;
    g.current.dragging = true;
    g.current.lastX = e.clientX;
    g.current.lastY = e.clientY;
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!g.current.dragging) return;
    const ndx = e.clientX - g.current.lastX;
    const ndy = e.clientY - g.current.lastY;
    g.current.lastX = e.clientX;
    g.current.lastY = e.clientY;
    setOffset(o => ({ x: o.x + ndx, y: o.y + ndy }));
  };
  const endDrag = () => { g.current.dragging = false; };

  const download = () => {
    const a = document.createElement('a');
    a.href = src;
    a.download = filename || 'photo.jpg';
    a.click();
  };

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex touch-none select-none items-center justify-center overflow-hidden bg-black/85"
      onClick={e => { if (e.target === containerRef.current) onClose(); }}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      <img
        src={src}
        alt={alt || 'Full size'}
        draggable={false}
        onMouseDown={onMouseDown}
        onDoubleClick={() => applyScale(scale > 1 ? 1 : 3)}
        onClick={e => e.stopPropagation()}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          cursor: scale > 1 ? 'grab' : 'zoom-in',
          transition: g.current.dragging ? 'none' : 'transform 0.08s ease-out',
        }}
        className="max-h-full max-w-full rounded will-change-transform"
      />

      <div className="absolute right-4 top-4 flex items-center gap-2" onClick={e => e.stopPropagation()}>
        <button type="button" onClick={() => applyScale(scale - 0.5)} title="Zoom out"
                className="h-8 w-8 rounded-full bg-white/90 text-lg font-bold text-gray-800 hover:bg-white">−</button>
        <span className="min-w-[3rem] text-center text-xs font-medium text-white/90">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => applyScale(scale + 0.5)} title="Zoom in"
                className="h-8 w-8 rounded-full bg-white/90 text-lg font-bold text-gray-800 hover:bg-white">+</button>
        {filename && (
          <button type="button" onClick={download}
                  className="rounded-full bg-white/90 px-3 py-1 text-sm font-medium text-gray-800 hover:bg-white">Download</button>
        )}
        <button type="button" onClick={onClose}
                className="rounded-full bg-white/90 px-3 py-1 text-sm font-medium text-gray-800 hover:bg-white">Close</button>
      </div>

      <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] text-white/60">
        Scroll or pinch to zoom · drag to pan · double-click to reset
      </p>
    </div>
  );
}
