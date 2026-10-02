/**
 * Damage marking on a van outline (docs/INCIDENT-CLAIMS-SPEC.md §10.1).
 *
 * The Vito and both Sprinters use the original shaded outline sheets drawn for
 * Ooosh (outlines/*.svg — roof, offside + front, nearside + rear, drawn to
 * scale in mm; jon, Oct 2026). Use them as they are — don't restyle them.
 * Anything else ('generic') falls back to the simple drawing generated below
 * from a handful of proportions.
 *
 * Tap anywhere to drop a cross (damage) or an arrow (point / angle of impact),
 * with an optional note. No zones (D11) — photos carry the detail. Marks are
 * stored as percentages of the sheet, and a PNG of sheet + marks is rendered
 * in the browser for the broker PDF.
 */
import { useRef, useState } from 'react';
import type { DamageMark, OutlineType } from '@claimform';
import vitoSvg from './outlines/vito.svg?raw';
import sprinterMwbSvg from './outlines/sprinter-mwb.svg?raw';
import sprinterLwbSvg from './outlines/sprinter-lwb.svg?raw';

/** The generated fallback sheet's size. */
const W = 1000;
const H = 640;

interface Art { w: number; h: number; inner: string }

/** Split an artwork file into its viewBox size and its drawing (inlined into our own <svg>). */
function parseArt(raw: string): Art {
  const vb = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(raw);
  const inner = raw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return { w: Number(vb?.[1] || W), h: Number(vb?.[2] || H), inner };
}

const ART: Partial<Record<OutlineType, Art>> = {
  vito: parseArt(vitoSvg),
  sprinter_mwb: parseArt(sprinterMwbSvg),
  sprinter_lwb: parseArt(sprinterLwbSvg),
};

/** The sheet's coordinate size for a type — marks are stored as % of it. */
function sheetSize(type: OutlineType): { w: number; h: number } {
  const a = ART[type];
  return a ? { w: a.w, h: a.h } : { w: W, h: H };
}

interface Shape { length: number; height: number; nose: number; slope: number; frontWidth: number; label: string }

const SHAPES: Record<OutlineType, Shape> = {
  vito:         { length: 0.80, height: 0.62, nose: 0.20, slope: 0.14, frontWidth: 0.78, label: 'Vito' },
  sprinter_mwb: { length: 0.88, height: 0.95, nose: 0.13, slope: 0.10, frontWidth: 0.90, label: 'Sprinter MWB' },
  sprinter_lwb: { length: 1.00, height: 0.95, nose: 0.115, slope: 0.09, frontWidth: 0.90, label: 'Sprinter LWB' },
  generic:      { length: 0.90, height: 0.85, nose: 0.14, slope: 0.10, frontWidth: 0.86, label: 'Van' },
};

const STROKE = '#334155';
const LIGHT = '#94a3b8';

/** One side view, front facing right; `mirror` flips it to face left. */
function SideView({ x, y, w, h, s, mirror, label }: { x: number; y: number; w: number; h: number; s: Shape; mirror?: boolean; label: string }) {
  const bL = w * s.length;
  const r = h * 0.11;
  const ground = y + h;
  const yb = ground - r * 0.9;
  const bodyH = (h - r) * s.height;
  const yt = yb - bodyH;
  const xs = x + (w - bL) / 2;
  const xe = xs + bL;
  const hoodY = yb - bodyH * 0.42;
  const screenBase = xe - s.nose * bL;
  const roofEnd = screenBase - s.slope * bL;
  const body = [
    `M ${xs} ${yb}`, `L ${xs} ${yt + 8}`, `Q ${xs} ${yt} ${xs + 8} ${yt}`,
    `L ${roofEnd} ${yt}`, `L ${screenBase} ${hoodY}`, `L ${xe - 6} ${hoodY + 10}`,
    `Q ${xe} ${hoodY + 14} ${xe} ${yb - 14}`, `L ${xe} ${yb}`, 'Z',
  ].join(' ');
  const winTop = yt + bodyH * 0.1;
  const winBot = yt + bodyH * 0.36;
  const cabDoor = roofEnd - bL * 0.14;
  const panes = 3;
  const paneStart = xs + bL * 0.06;
  const paneEnd = cabDoor - 10;
  const paneW = (paneEnd - paneStart) / panes;
  const cx = x + w / 2;
  return (
    <g>
      <text x={x} y={y - 8} fontSize="16" fill="#475569" fontFamily="sans-serif">{label}</text>
      <g transform={mirror ? `translate(${2 * cx} 0) scale(-1 1)` : undefined}>
        <path d={body} fill="#fff" stroke={STROKE} strokeWidth="2.5" />
        {/* cab window */}
        <path d={`M ${cabDoor + 6} ${winTop} L ${roofEnd + 2} ${winTop} L ${screenBase - 6} ${hoodY - 6} L ${cabDoor + 6} ${hoodY - 6} Z`} fill="#e2e8f0" stroke={STROKE} strokeWidth="1.5" />
        {/* rear side windows */}
        {Array.from({ length: panes }).map((_, i) => (
          <rect key={i} x={paneStart + i * paneW + 4} y={winTop} width={paneW - 8} height={winBot - winTop} rx="4" fill="#e2e8f0" stroke={STROKE} strokeWidth="1.5" />
        ))}
        {/* door lines */}
        <line x1={cabDoor} y1={yt + 4} x2={cabDoor} y2={yb - 4} stroke={LIGHT} strokeWidth="1.5" />
        <line x1={cabDoor - bL * 0.26} y1={yt + 4} x2={cabDoor - bL * 0.26} y2={yb - 4} stroke={LIGHT} strokeWidth="1.5" />
        {/* lights */}
        <rect x={xe - 10} y={hoodY + 16} width="8" height="12" rx="2" fill="#fde68a" stroke={STROKE} strokeWidth="1" />
        <rect x={xs + 1} y={yb - bodyH * 0.35} width="6" height={bodyH * 0.18} fill="#fca5a5" stroke={STROKE} strokeWidth="1" />
        {/* wheels */}
        {[xs + bL * 0.18, screenBase - bL * 0.06].map((wx) => (
          <g key={wx}>
            <circle cx={wx} cy={ground - r} r={r} fill="#fff" stroke={STROKE} strokeWidth="2.5" />
            <circle cx={wx} cy={ground - r} r={r * 0.45} fill="none" stroke={LIGHT} strokeWidth="1.5" />
          </g>
        ))}
      </g>
    </g>
  );
}

function TopView({ x, y, w, h, s }: { x: number; y: number; w: number; h: number; s: Shape }) {
  const bL = w * s.length;
  const bW = h * 0.72;
  const xs = x + (w - bL) / 2;
  const xe = xs + bL;
  const yc = y + h / 2;
  const screen = xe - s.nose * bL;
  return (
    <g>
      <text x={x} y={y - 8} fontSize="16" fill="#475569" fontFamily="sans-serif">Top (front →)</text>
      <rect x={xs} y={yc - bW / 2} width={bL} height={bW} rx="14" fill="#fff" stroke={STROKE} strokeWidth="2.5" />
      <path d={`M ${screen - s.slope * bL} ${yc - bW / 2 + 6} L ${screen} ${yc - bW / 2 + 10} L ${screen} ${yc + bW / 2 - 10} L ${screen - s.slope * bL} ${yc + bW / 2 - 6} Z`} fill="#e2e8f0" stroke={STROKE} strokeWidth="1.5" />
      {[0.25, 0.45, 0.65].map((f) => (
        <line key={f} x1={xs + bL * f} y1={yc - bW / 2 + 8} x2={xs + bL * f} y2={yc + bW / 2 - 8} stroke={LIGHT} strokeWidth="1.5" />
      ))}
      <rect x={screen - s.slope * bL - 10} y={yc - bW / 2 - 12} width="14" height="12" rx="3" fill="#fff" stroke={STROKE} strokeWidth="1.5" />
      <rect x={screen - s.slope * bL - 10} y={yc + bW / 2} width="14" height="12" rx="3" fill="#fff" stroke={STROKE} strokeWidth="1.5" />
    </g>
  );
}

function EndView({ x, y, w, h, s, rear, label }: { x: number; y: number; w: number; h: number; s: Shape; rear?: boolean; label: string }) {
  const r = h * 0.11;
  const ground = y + h;
  const yb = ground - r * 0.9;
  const bodyH = (h - r) * s.height;
  const yt = yb - bodyH;
  const fw = w * s.frontWidth;
  const xs = x + (w - fw) / 2;
  const xe = xs + fw;
  const cx = x + w / 2;
  return (
    <g>
      <text x={x} y={y - 8} fontSize="16" fill="#475569" fontFamily="sans-serif">{label}</text>
      <path d={`M ${xs + 6} ${yb} L ${xs} ${yt + 18} Q ${xs + 4} ${yt} ${xs + 20} ${yt} L ${xe - 20} ${yt} Q ${xe - 4} ${yt} ${xe} ${yt + 18} L ${xe - 6} ${yb} Z`} fill="#fff" stroke={STROKE} strokeWidth="2.5" />
      {/* wheels peeking out */}
      <rect x={xs + 4} y={yb - 2} width={fw * 0.16} height={r * 1.2} rx="4" fill="#475569" />
      <rect x={xe - 4 - fw * 0.16} y={yb - 2} width={fw * 0.16} height={r * 1.2} rx="4" fill="#475569" />
      {rear ? (
        <>
          <line x1={cx} y1={yt + 6} x2={cx} y2={yb - 8} stroke={STROKE} strokeWidth="1.5" />
          <rect x={xs + fw * 0.12} y={yt + bodyH * 0.1} width={fw * 0.34} height={bodyH * 0.28} rx="4" fill="#e2e8f0" stroke={STROKE} strokeWidth="1.5" />
          <rect x={cx + fw * 0.04} y={yt + bodyH * 0.1} width={fw * 0.34} height={bodyH * 0.28} rx="4" fill="#e2e8f0" stroke={STROKE} strokeWidth="1.5" />
          <rect x={xs + 2} y={yt + bodyH * 0.45} width="8" height={bodyH * 0.3} fill="#fca5a5" stroke={STROKE} strokeWidth="1" />
          <rect x={xe - 10} y={yt + bodyH * 0.45} width="8" height={bodyH * 0.3} fill="#fca5a5" stroke={STROKE} strokeWidth="1" />
          <rect x={xs + 8} y={yb - bodyH * 0.1} width={fw - 16} height={bodyH * 0.07} fill="#cbd5e1" stroke={STROKE} strokeWidth="1" />
        </>
      ) : (
        <>
          <path d={`M ${xs + fw * 0.1} ${yt + bodyH * 0.08} L ${xe - fw * 0.1} ${yt + bodyH * 0.08} L ${xe - fw * 0.06} ${yt + bodyH * 0.45} L ${xs + fw * 0.06} ${yt + bodyH * 0.45} Z`} fill="#e2e8f0" stroke={STROKE} strokeWidth="1.5" />
          <rect x={cx - fw * 0.2} y={yt + bodyH * 0.6} width={fw * 0.4} height={bodyH * 0.16} rx="4" fill="#fff" stroke={STROKE} strokeWidth="1.5" />
          <rect x={xs + 8} y={yt + bodyH * 0.58} width={fw * 0.16} height={bodyH * 0.1} rx="3" fill="#fde68a" stroke={STROKE} strokeWidth="1" />
          <rect x={xe - 8 - fw * 0.16} y={yt + bodyH * 0.58} width={fw * 0.16} height={bodyH * 0.1} rx="3" fill="#fde68a" stroke={STROKE} strokeWidth="1" />
          <rect x={xs - 16} y={yt + bodyH * 0.3} width="14" height="20" rx="3" fill="#fff" stroke={STROKE} strokeWidth="1.5" />
          <rect x={xe + 2} y={yt + bodyH * 0.3} width="14" height="20" rx="3" fill="#fff" stroke={STROKE} strokeWidth="1.5" />
        </>
      )}
    </g>
  );
}

/** A mark, sized relative to the sheet (k = 1 on the 1000-wide fallback sheet). */
function Mark({ m, selected, w, h }: { m: DamageMark; selected: boolean; w: number; h: number }) {
  const px = (m.x / 100) * w;
  const py = (m.y / 100) * h;
  const k = w / 1000;
  const red = '#dc2626';
  return (
    <g>
      {selected && <circle data-ui="1" cx={px} cy={py} r={22 * k} fill="none" stroke="#2563eb" strokeWidth={2 * k} strokeDasharray={`${4 * k} ${3 * k}`} />}
      {m.kind === 'cross' ? (
        <g stroke={red} strokeWidth={5 * k} strokeLinecap="round">
          <line x1={px - 11 * k} y1={py - 11 * k} x2={px + 11 * k} y2={py + 11 * k} />
          <line x1={px - 11 * k} y1={py + 11 * k} x2={px + 11 * k} y2={py - 11 * k} />
        </g>
      ) : (
        // Arrow whose TIP is the tapped point, pointing along `angle`.
        <g transform={`rotate(${m.angle || 0} ${px} ${py})`} stroke={red} strokeWidth={5 * k} strokeLinecap="round" fill={red}>
          <line x1={px - 50 * k} y1={py} x2={px - 12 * k} y2={py} />
          <path d={`M ${px} ${py} L ${px - 16 * k} ${py - 10 * k} L ${px - 16 * k} ${py + 10 * k} Z`} strokeWidth={k} />
        </g>
      )}
    </g>
  );
}

/** The sheet itself — shared by the editor and read-only displays. */
export function OutlineSheet({ type, marks, selected, svgRef, onTap }: {
  type: OutlineType;
  marks: DamageMark[];
  selected?: number | null;
  svgRef?: React.Ref<SVGSVGElement>;
  onTap?: (xPct: number, yPct: number) => void;
}) {
  const s = SHAPES[type] || SHAPES.generic;
  const art = ART[type];
  const { w, h } = sheetSize(type);
  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      className="w-full h-auto select-none touch-manipulation bg-white"
      style={{ cursor: onTap ? 'crosshair' : 'default' }}
      onClick={(e) => {
        if (!onTap) return;
        const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        onTap(((e.clientX - rect.left) / rect.width) * 100, ((e.clientY - rect.top) / rect.height) * 100);
      }}
    >
      {art ? (
        // Our own artwork file, bundled at build time — not user content.
        <g dangerouslySetInnerHTML={{ __html: art.inner }} />
      ) : (
        <>
          <rect x="0" y="0" width={W} height={H} fill="#fff" />
          <TopView x={40} y={35} w={620} h={150} s={s} />
          <SideView x={40} y={225} w={620} h={185} s={s} mirror label="Nearside (passenger side)" />
          <SideView x={40} y={445} w={620} h={185} s={s} label="Offside (driver's side)" />
          <EndView x={720} y={225} w={240} h={185} s={s} label="Front" />
          <EndView x={720} y={445} w={240} h={185} s={s} rear label="Rear" />
          <text x={W - 20} y={28} fontSize="14" textAnchor="end" fill={LIGHT} fontFamily="sans-serif">{s.label}</text>
        </>
      )}
      {marks.map((m, i) => <Mark key={i} m={m} selected={selected === i} w={w} h={h} />)}
    </svg>
  );
}

/** Render the sheet + marks to a PNG data URL (UI-only elements stripped). */
export async function outlineToPng(svg: SVGSVGElement): Promise<string> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll('[data-ui]').forEach((n) => n.remove());
  clone.removeAttribute('class');
  // Render at 1400px wide whatever the sheet's own units (the artwork is in mm).
  const vb = svg.viewBox.baseVal;
  const outW = 1400;
  const outH = Math.round(outW * ((vb?.height || H) / (vb?.width || W)));
  clone.setAttribute('width', String(outW));
  clone.setAttribute('height', String(outH));
  const text = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('render failed')); img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, 0, 0, outW, outH);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function DamageOutlineEditor({ type, initial, onSave, large }: {
  type: OutlineType;
  initial: DamageMark[];
  onSave: (marks: DamageMark[], pngDataUrl: string | null) => Promise<void>;
  large?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [marks, setMarks] = useState<DamageMark[]>(initial || []);
  const [tool, setTool] = useState<'cross' | 'arrow'>('cross');
  const [selected, setSelected] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const btn = large ? 'px-4 py-2.5 text-sm rounded-lg border' : 'px-3 py-1 text-xs rounded border';
  const change = (next: DamageMark[]) => { setMarks(next); setDirty(true); };

  const tap = (x: number, y: number) => {
    // Tapping near an existing mark selects it rather than adding another
    // (about 2.4% of the sheet's width, whatever its units).
    const { w, h } = sheetSize(type);
    const near = marks.findIndex((m) => Math.hypot((m.x - x) * (w / 100), (m.y - y) * (h / 100)) < 24 * (w / 1000));
    if (near >= 0) { setSelected(near); return; }
    const m: DamageMark = tool === 'arrow' ? { x, y, kind: 'arrow', angle: 0 } : { x, y, kind: 'cross' };
    change([...marks, m]);
    setSelected(marks.length);
  };
  const update = (patch: Partial<DamageMark>) => {
    if (selected === null) return;
    change(marks.map((m, i) => (i === selected ? { ...m, ...patch } : m)));
  };
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      setSelected(null);
      const png = svgRef.current && marks.length ? await outlineToPng(svgRef.current) : null;
      await onSave(marks, png);
      setDirty(false);
    } catch {
      setError('Could not save the marks — please try again.');
    } finally {
      setSaving(false);
    }
  };
  const sel = selected !== null ? marks[selected] : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={large ? 'text-sm text-slate-700' : 'text-xs text-slate-600'}>Tap to add:</span>
        <button type="button" onClick={() => setTool('cross')} className={`${btn} ${tool === 'cross' ? 'bg-red-600 text-white border-red-600' : 'bg-white'}`}>✕ Damage</button>
        <button type="button" onClick={() => setTool('arrow')} className={`${btn} ${tool === 'arrow' ? 'bg-red-600 text-white border-red-600' : 'bg-white'}`}>➜ Point of impact</button>
        <button type="button" disabled={!marks.length} onClick={() => { change(marks.slice(0, -1)); setSelected(null); }} className={`${btn} bg-white disabled:opacity-40`}>Undo</button>
      </div>
      <div className="border rounded-lg overflow-hidden">
        <OutlineSheet type={type} marks={marks} selected={selected} svgRef={svgRef} onTap={tap} />
      </div>
      {sel && (
        <div className="flex flex-wrap items-center gap-2 border rounded-lg p-2 bg-slate-50">
          <span className="text-xs text-slate-600">{sel.kind === 'arrow' ? 'Arrow' : 'Cross'} {selected! + 1}</span>
          {sel.kind === 'arrow' && (
            <>
              <button type="button" className={`${btn} bg-white`} onClick={() => update({ angle: ((sel.angle || 0) - 45 + 360) % 360 })}>↺ Turn</button>
              <button type="button" className={`${btn} bg-white`} onClick={() => update({ angle: ((sel.angle || 0) + 45) % 360 })}>↻ Turn</button>
            </>
          )}
          <input
            value={sel.note || ''}
            onChange={(e) => update({ note: e.target.value.slice(0, 200) })}
            placeholder="Note (optional)"
            className={`flex-1 min-w-[10rem] border rounded ${large ? 'px-3 py-2 text-base' : 'px-2 py-1 text-sm'}`}
          />
          <button type="button" className={`${btn} bg-white text-red-600`} onClick={() => { change(marks.filter((_, i) => i !== selected)); setSelected(null); }}>Remove</button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button type="button" onClick={save} disabled={saving || !dirty} className={`${btn} bg-ooosh-600 text-white border-ooosh-600 disabled:opacity-40`}>
          {saving ? 'Saving…' : 'Save marks'}
        </button>
        {dirty && <span className="text-xs text-amber-700">Not saved yet</span>}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}
