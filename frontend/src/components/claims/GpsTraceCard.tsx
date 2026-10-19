/**
 * The van's GPS route around the incident (docs/INCIDENT-CLAIMS-SPEC.md §14, §21).
 *
 * Loads only when asked (each look is a Traccar call). Staff widen / narrow the
 * window, then Attach saves the points as a CSV case file; saved traces are
 * redrawn from their own file, so the evidence doesn't depend on Traccar still
 * having the history. No map image is saved — the points are the record.
 */
import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../../services/api';

interface RoutePoint { time: string; lat: number; lng: number; speedKph: number; course: number | null; address: string | null }
interface SavedTrace { id: string; caption: string | null; filename: string }

/** ISO → the value a datetime-local input wants, in the browser's (UK) time. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fromLocalInput = (v: string): string | null => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const hm = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });

function RouteMap({ points }: { points: RoutePoint[] }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: true, attributionControl: false }).setView([50.84, -0.17], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => { map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current; const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    if (!points.length) return;
    const line = points.map((p) => [p.lat, p.lng] as [number, number]);
    L.polyline(line, { color: '#7B5EA7', weight: 4 }).addTo(g);
    const dot = (p: RoutePoint, colour: string, label: string) =>
      L.circleMarker([p.lat, p.lng], { radius: 7, color: '#fff', weight: 2, fillColor: colour, fillOpacity: 1 })
        .bindTooltip(`${label} ${hm(p.time)}${p.address ? ` · ${p.address}` : ''}`).addTo(g);
    // Every point is hoverable for its time and speed.
    points.forEach((p) => L.circleMarker([p.lat, p.lng], { radius: 3, color: '#7B5EA7', weight: 1, fillOpacity: 0.6 })
      .bindTooltip(`${hm(p.time)} · ${Math.round(p.speedKph * 0.621)} mph`).addTo(g));
    dot(points[0], '#16a34a', 'Start');
    dot(points[points.length - 1], '#dc2626', 'End');
    m.fitBounds(L.latLngBounds(line).pad(0.15));
  }, [points]);

  return <div ref={el} className="h-80 w-full rounded border z-0" />;
}

export function GpsTraceCard({ claimId, hasVan, saved, onChange }: {
  claimId: string;
  hasVan: boolean;
  saved: SavedTrace[];
  onChange: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [points, setPoints] = useState<RoutePoint[] | null>(null);
  const [showing, setShowing] = useState<string>('');   // '' = the live window, else a saved file id
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = async (window?: { from: string; to: string }) => {
    setBusy(true); setNote(''); setShowing('');
    try {
      const qs = window ? `?from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}` : '';
      const r = await api.get<{ data: { from: string | null; to: string | null; points: RoutePoint[]; gps: boolean; needs_date?: boolean } }>(`/claims/${claimId}/gps${qs}`);
      if (r.data.from) setFrom(toLocalInput(r.data.from));
      if (r.data.to) setTo(toLocalInput(r.data.to));
      setPoints(r.data.points);
      if (r.data.needs_date) setNote('No incident date yet — pick a window below.');
      else if (!r.data.gps) setNote('No GPS tracker found for this van.');
      else if (!r.data.points.length) setNote('No positions in this window — the van may have been parked, or the tracking server no longer has that day.');
    } catch (e) {
      setNote((e as { body?: { error?: string } }).body?.error || 'Could not load the route');
    } finally { setBusy(false); }
  };
  const pickedWindow = () => {
    const f = fromLocalInput(from); const t = fromLocalInput(to);
    if (!f || !t) { setNote('Pick a start and end time'); return null; }
    return { from: f, to: t };
  };
  const shift = (minutes: number) => {
    const f = new Date(from); const t = new Date(to);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return;
    const nf = new Date(f.getTime() - minutes * 60000).toISOString();
    const nt = new Date(t.getTime() + minutes * 60000).toISOString();
    setFrom(toLocalInput(nf)); setTo(toLocalInput(nt));
    load({ from: nf, to: nt });
  };
  const attach = async () => {
    const w = pickedWindow(); if (!w) return;
    setBusy(true); setNote('');
    try {
      const r = await api.post<{ data: { points: number } }>(`/claims/${claimId}/gps/attach`, w);
      onChange(`GPS trace saved to the case (${r.data.points} points).`);
    } catch (e) {
      setNote((e as { body?: { error?: string } }).body?.error || 'Could not save the trace');
    } finally { setBusy(false); }
  };
  const showSaved = async (id: string) => {
    setOpen(true); setBusy(true); setNote('');
    try {
      const r = await api.get<{ data: { points: RoutePoint[] } }>(`/claims/${claimId}/gps/files/${id}`);
      setPoints(r.data.points); setShowing(id);
    } catch { setNote('Could not read that trace'); } finally { setBusy(false); }
  };

  const btn = 'px-2 py-1 text-xs rounded border bg-white disabled:opacity-50';
  const maxMph = points?.length ? Math.round(Math.max(...points.map((p) => p.speedKph)) * 0.621) : 0;

  return (
    <div className="bg-white rounded-lg border p-4">
      <div className="flex items-center justify-between mb-2 gap-2">
        <h2 className="text-sm font-semibold text-slate-700">GPS trace</h2>
        {!open && (
          <button type="button" className={btn} disabled={!hasVan || busy} onClick={() => { setOpen(true); load(); }}>
            {hasVan ? 'Show the van’s route' : 'Set the van first'}
          </button>
        )}
      </div>
      {saved.length > 0 && (
        <ul className="text-xs mb-2 space-y-1">
          {saved.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <span className={showing === t.id ? 'font-medium text-slate-800' : 'text-slate-600'}>📍 {t.caption || t.filename}</span>
              <button type="button" className="text-ooosh-700 hover:underline" onClick={() => showSaved(t.id)}>Show on map</button>
            </li>
          ))}
        </ul>
      )}
      {!open && !saved.length && (
        <p className="text-xs text-slate-500">From the tracker: where the van went around the incident. One is saved automatically the day after the incident date is known.</p>
      )}
      {open && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2 text-xs">
            <label>From<input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className="block border rounded px-2 py-1" /></label>
            <label>To<input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className="block border rounded px-2 py-1" /></label>
            <button type="button" className={btn} disabled={busy} onClick={() => { const w = pickedWindow(); if (w) load(w); }}>Show</button>
            <button type="button" className={btn} disabled={busy} onClick={() => shift(30)} title="30 minutes more each side">Wider</button>
            <button type="button" className={btn} disabled={busy} onClick={() => shift(-15)} title="15 minutes less each side">Narrower</button>
            <button type="button" className="px-3 py-1 text-xs rounded bg-ooosh-600 text-white disabled:opacity-50" disabled={busy || !points?.length || !!showing} onClick={attach}
              title="Save these points to the case as a CSV file">
              Attach to case
            </button>
          </div>
          {showing && <p className="text-xs text-slate-500">Showing a saved trace. <button type="button" className="text-ooosh-700 hover:underline" onClick={() => { const w = pickedWindow(); if (w) load(w); }}>Back to the window above</button></p>}
          {note && <p className="text-xs text-amber-700">{note}</p>}
          {points && points.length > 0 && (
            <p className="text-xs text-slate-500">
              {points.length} positions, {hm(points[0].time)} – {hm(points[points.length - 1].time)} · top speed about {maxMph} mph. Hover a dot for its time and speed.
            </p>
          )}
          <RouteMap points={points || []} />
        </div>
      )}
    </div>
  );
}
