/**
 * Jobs › Marketing — admin only (docs/BUSINESS-FIGURES-SPEC.md §8, step 2).
 *
 * Adverts: where we advertise, what it costs, what's due next (a To Do for whoever
 * set it), whether the proof has come in — and what each one produced.
 * Tracked links: the short links / QR codes that go on the artwork. A scan is
 * counted and forwarded to the chosen page; an enquiry from it carries the code.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import ModalShell from '../components/ModalShell';
import { ukDatePlus, ukToday } from '../lib/ukDate';

interface Placement {
  id: string;
  name: string;
  channel: string;
  supplier: string | null;
  cost: number | null;
  startsOn: string | null;
  endsOn: string | null;
  nextDueOn: string | null;
  nextDueNote: string | null;
  proofReceivedOn: string | null;
  artworkUrl: string | null;
  status: string;
  notes: string | null;
  links: number;
  scans: number;
  enquiries: number;
  booked: number;
  bookedValue: number;
}

interface TrackedLink {
  id: string;
  code: string;
  shortUrl: string;
  label: string | null;
  destination: string;
  utmSource: string | null;
  utmMedium: string | null;
  placementId: string | null;
  placementName: string | null;
  isActive: boolean;
  scans: number;
  scans30: number;
  lastScanAt: string | null;
  enquiries: number;
  booked: number;
  bookedValue: number;
}

const CHANNEL_LABELS: Record<string, string> = {
  print: 'Print', online: 'Online listing', social: 'Social', search_ads: 'Search ads',
  event: 'Event', sponsorship: 'Sponsorship', other: 'Other',
};
const STATUS_LABELS: Record<string, string> = { planned: 'Planned', live: 'Live', ended: 'Ended', cancelled: 'Cancelled' };
const STATUS_TONE: Record<string, string> = {
  planned: 'bg-blue-50 text-blue-700', live: 'bg-green-50 text-green-700', ended: 'bg-gray-100 text-gray-600', cancelled: 'bg-gray-100 text-gray-400',
};

const inputCls = 'w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500';
const gbp0 = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
const gbp2 = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function shortDate(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '—';
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

// ── Advert form ─────────────────────────────────────────────────────────────

function AdvertModal({ advert, onClose, onSaved }: { advert: Placement | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: advert?.name || '', channel: advert?.channel || 'print', supplier: advert?.supplier || '',
    cost: advert?.cost !== null && advert?.cost !== undefined ? String(advert.cost) : '',
    startsOn: advert?.startsOn || '', endsOn: advert?.endsOn || '',
    nextDueOn: advert?.nextDueOn || '', nextDueNote: advert?.nextDueNote || '',
    proofReceivedOn: advert?.proofReceivedOn || '', artworkUrl: advert?.artworkUrl || '',
    status: advert?.status || 'planned', notes: advert?.notes || '',
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    if (!f.name.trim()) { setError('Give it a name, e.g. "Brighton Source — December issue".'); return; }
    const cost = f.cost.trim() === '' ? null : Number(f.cost.replace(/[£,\s]/g, ''));
    if (cost !== null && !Number.isFinite(cost)) { setError("The cost isn't an amount."); return; }
    const body = {
      name: f.name.trim(), channel: f.channel, supplier: f.supplier.trim() || null, cost,
      startsOn: f.startsOn || null, endsOn: f.endsOn || null,
      nextDueOn: f.nextDueOn || null, nextDueNote: f.nextDueNote.trim() || null,
      proofReceivedOn: f.proofReceivedOn || null, artworkUrl: f.artworkUrl.trim() || null,
      status: f.status, notes: f.notes.trim() || null,
    };
    setSaving(true);
    setError(null);
    try {
      if (advert) await api.patch(`/marketing/placements/${advert.id}`, body);
      else await api.post('/marketing/placements', body);
      onSaved();
    } catch (e) {
      setError((e as Error).message || 'Could not save.');
      setSaving(false);
    }
  };

  const field = (label: string, el: React.ReactNode, hint?: string) => (
    <label className="block text-sm">
      <span className="block text-gray-700 mb-1">{label}</span>
      {el}
      {hint && <span className="block text-[11px] text-gray-500 mt-0.5">{hint}</span>}
    </label>
  );

  return (
    <ModalShell title={advert ? 'Edit advert' : 'Add an advert'} subtitle="Where we're advertising, and what it costs." onClose={onClose} width="max-w-2xl">
      <div className="space-y-3">
        {field('Name', <input className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Brighton Source — December issue" />)}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {field('Type', (
            <select className={inputCls} value={f.channel} onChange={(e) => set('channel', e.target.value)}>
              {Object.entries(CHANNEL_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          ))}
          {field('Who with', <input className={inputCls} value={f.supplier} onChange={(e) => set('supplier', e.target.value)} placeholder="Magazine / site / organiser" />)}
          {field('Cost (£, what we pay)', <input className={inputCls} inputMode="decimal" value={f.cost} onChange={(e) => set('cost', e.target.value)} placeholder="0.00" />)}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {field('Runs from', <input type="date" className={inputCls} value={f.startsOn} onChange={(e) => set('startsOn', e.target.value)} />)}
          {field('Until', <input type="date" className={inputCls} value={f.endsOn} onChange={(e) => set('endsOn', e.target.value)} />)}
          {field('Status', (
            <select className={inputCls} value={f.status} onChange={(e) => set('status', e.target.value)}>
              {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {field('Next thing due', <input type="date" className={inputCls} value={f.nextDueOn} onChange={(e) => set('nextDueOn', e.target.value)} />, 'Becomes a To Do for you on the day.')}
          <div className="sm:col-span-2">
            {field('What\'s due', <input className={inputCls} value={f.nextDueNote} onChange={(e) => set('nextDueNote', e.target.value)} placeholder="Artwork deadline / renew the listing / book the next issue" />)}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {field('Proof / copy received', <input type="date" className={inputCls} value={f.proofReceivedOn} onChange={(e) => set('proofReceivedOn', e.target.value)} />, 'Leave blank until it arrives.')}
          <div className="sm:col-span-2">
            {field('Artwork / proof link', <input className={inputCls} value={f.artworkUrl} onChange={(e) => set('artworkUrl', e.target.value)} placeholder="Google Drive link" />)}
          </div>
        </div>
        {field('Notes', <textarea className={inputCls} rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />)}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">Cancel</button>
          <button type="button" onClick={save} disabled={saving} className="px-3 py-2 text-sm rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ── Link form ───────────────────────────────────────────────────────────────

function LinkModal({ link, adverts, onClose, onSaved }: { link: TrackedLink | null; adverts: Placement[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    label: link?.label || '', code: link?.code || '', destination: link?.destination || 'https://www.oooshtours.co.uk/',
    placementId: link?.placementId || '', utmSource: link?.utmSource || '', utmMedium: link?.utmMedium || '',
  });
  const [codeTouched, setCodeTouched] = useState(!!link);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const advert = adverts.find((a) => a.id === f.placementId);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = {
        label: f.label.trim() || null, destination: f.destination.trim(), placementId: f.placementId || null,
        utmSource: f.utmSource.trim() || (advert?.supplier ? slug(advert.supplier) : null),
        utmMedium: f.utmMedium.trim() || (advert ? advert.channel : null),
      };
      if (link) await api.patch(`/marketing/links/${link.id}`, body);
      else await api.post('/marketing/links', { ...body, code: f.code.trim() || slug(f.label) });
      onSaved();
    } catch (e) {
      setError((e as Error).message || 'Could not save.');
      setSaving(false);
    }
  };

  return (
    <ModalShell title={link ? 'Edit tracked link' : 'New tracked link'} subtitle="A short link and QR code for artwork. Every scan is counted, then sent to the page you choose." onClose={onClose} width="max-w-xl">
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="block text-gray-700 mb-1">What it's for</span>
          <input className={inputCls} value={f.label} placeholder="Brighton Source December — vans"
            onChange={(e) => setF((x) => ({ ...x, label: e.target.value, code: codeTouched ? x.code : slug(e.target.value) }))} />
        </label>
        <label className="block text-sm">
          <span className="block text-gray-700 mb-1">Short code</span>
          <div className="flex items-center gap-1">
            <span className="text-sm text-gray-500">go.oooshtours.co.uk/</span>
            <input className={inputCls} value={f.code} disabled={!!link}
              onChange={(e) => { setCodeTouched(true); setF((x) => ({ ...x, code: slug(e.target.value) })); }} />
          </div>
          <span className="block text-[11px] text-gray-500 mt-0.5">{link ? "Can't change once made — it's on the artwork." : 'Short and readable — people may type it. It can\'t change later.'}</span>
        </label>
        <label className="block text-sm">
          <span className="block text-gray-700 mb-1">Send people to</span>
          <input className={inputCls} value={f.destination} onChange={(e) => setF((x) => ({ ...x, destination: e.target.value }))} />
          <span className="block text-[11px] text-gray-500 mt-0.5">Any page on the website (copy it from the address bar). Can be changed later, even after printing. Another site works too — e.g. our Google review box — but then only scans are counted.</span>
        </label>
        <label className="block text-sm">
          <span className="block text-gray-700 mb-1">Advert</span>
          <select className={inputCls} value={f.placementId} onChange={(e) => setF((x) => ({ ...x, placementId: e.target.value }))}>
            <option value="">— not tied to an advert —</option>
            {adverts.filter((a) => a.status !== 'cancelled').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <details className="text-sm">
          <summary className="cursor-pointer text-gray-600">Campaign tags (optional)</summary>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <label className="block">
              <span className="block text-gray-700 mb-1 text-xs">Source</span>
              <input className={inputCls} value={f.utmSource} placeholder={advert?.supplier ? slug(advert.supplier) : 'ooosh-link'} onChange={(e) => setF((x) => ({ ...x, utmSource: e.target.value }))} />
            </label>
            <label className="block">
              <span className="block text-gray-700 mb-1 text-xs">Medium</span>
              <input className={inputCls} value={f.utmMedium} placeholder={advert?.channel || 'qr'} onChange={(e) => setF((x) => ({ ...x, utmMedium: e.target.value }))} />
            </label>
          </div>
          <p className="text-[11px] text-gray-500 mt-1">Filled from the advert when left blank. Shown in Google Analytics too.</p>
        </details>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">Cancel</button>
          <button type="button" onClick={save} disabled={saving} className="px-3 py-2 text-sm rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
            {saving ? 'Saving…' : link ? 'Save' : 'Make the link'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function QrModal({ link, onClose }: { link: TrackedLink; onClose: () => void }) {
  const [qr, setQr] = useState<{ url: string; svg: string; png: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ data: { url: string; svg: string; png: string } }>(`/marketing/links/${link.id}/qr`)
      .then((r) => setQr(r.data))
      .catch((e: Error) => setError(e.message || 'Could not make the QR code.'));
  }, [link.id]);
  const svgHref = qr ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}` : '';
  return (
    <ModalShell title={`QR code — ${link.code}`} subtitle={link.shortUrl} onClose={onClose} width="max-w-md">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!qr && !error && <p className="text-sm text-gray-500">Making it…</p>}
      {qr && (
        <div className="space-y-3 text-center">
          <img src={svgHref} alt={`QR code for ${qr.url}`} className="mx-auto w-56 h-56" />
          <p className="text-sm font-mono text-gray-700">{qr.url.replace('https://', '')}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <a href={svgHref} download={`ooosh-${link.code}.svg`} className="px-3 py-2 text-sm rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700">Download SVG (for print)</a>
            <a href={qr.png} download={`ooosh-${link.code}.png`} className="px-3 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">Download PNG</a>
          </div>
          <p className="text-[11px] text-gray-500">SVG stays sharp at any size — send that to the designer. Print it at least 2 cm across.</p>
        </div>
      )}
    </ModalShell>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function MarketingPage() {
  const role = useAuthStore((s) => s.user?.role);
  const [tab, setTab] = useState<'adverts' | 'links'>('adverts');
  const [adverts, setAdverts] = useState<Placement[] | null>(null);
  const [links, setLinks] = useState<TrackedLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advertModal, setAdvertModal] = useState<Placement | 'new' | null>(null);
  const [linkModal, setLinkModal] = useState<TrackedLink | 'new' | null>(null);
  const [qrFor, setQrFor] = useState<TrackedLink | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [a, l] = await Promise.all([
        api.get<{ data: Placement[] }>('/marketing/placements'),
        api.get<{ data: TrackedLink[] }>('/marketing/links'),
      ]);
      setAdverts(a.data);
      setLinks(l.data);
    } catch (e) {
      setError((e as Error).message || 'Could not load.');
    }
  }, []);
  useEffect(() => { if (role === 'admin') load(); }, [role, load]);

  if (role !== 'admin') return <div className="p-6 text-sm text-gray-600">Marketing is for admins only.</div>;

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); setTimeout(() => setCopied(null), 1500); } catch { /* clipboard blocked — the address is on screen */ }
  };
  const togglePause = async (l: TrackedLink) => {
    try { await api.patch(`/marketing/links/${l.id}`, { isActive: !l.isActive }); await load(); } catch (e) { setError((e as Error).message); }
  };
  const today = ukToday();
  const soon = (d: string | null) => !!d && d <= ukDatePlus(7);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Marketing <span className="ml-1 align-middle text-[11px] font-semibold text-violet-800 bg-violet-100 rounded-full px-2 py-0.5">Admin</span>
          </h1>
          <p className="text-sm text-gray-600 mt-0.5">
            Where we advertise and what it brings in · <Link to="/money/business" className="text-ooosh-700 hover:underline">Business figures</Link>
          </p>
        </div>
        <button type="button" onClick={() => (tab === 'adverts' ? setAdvertModal('new') : setLinkModal('new'))}
          className="px-3 py-2 text-sm rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700">
          {tab === 'adverts' ? '+ Add an advert' : '+ New tracked link'}
        </button>
      </div>

      <div className="inline-flex rounded-lg border border-gray-300 p-0.5 text-sm">
        {(['adverts', 'links'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-md ${tab === t ? 'bg-ooosh-600 text-white' : 'text-gray-700 hover:bg-gray-50'}`}>
            {t === 'adverts' ? `Adverts${adverts ? ` (${adverts.length})` : ''}` : `Tracked links${links ? ` (${links.length})` : ''}`}
          </button>
        ))}
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {(!adverts || !links) && !error && <p className="text-sm text-gray-500">Loading…</p>}

      {tab === 'adverts' && adverts && (
        adverts.length === 0
          ? <p className="text-sm text-gray-500 rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center">No adverts yet. Add the first one — the magazine, the date it runs, what it costs and when the artwork is due.</p>
          : (
            <div className="rounded-xl border border-gray-200 bg-white overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-xs text-gray-500 whitespace-nowrap">
                  <tr>
                    <th className="text-left font-semibold px-3 py-2">Advert</th>
                    <th className="text-left font-semibold px-3 py-2">Runs</th>
                    <th className="text-left font-semibold px-3 py-2">Next due</th>
                    <th className="text-left font-semibold px-3 py-2">Proof</th>
                    <th className="text-right font-semibold px-3 py-2">Cost</th>
                    <th className="text-right font-semibold px-3 py-2">Scans</th>
                    <th className="text-right font-semibold px-3 py-2">Enquiries</th>
                    <th className="text-right font-semibold px-3 py-2">Booked</th>
                    <th className="text-right font-semibold px-3 py-2" title="Cost ÷ enquiries, and ÷ bookings">Cost per</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {adverts.map((a) => (
                    <tr key={a.id} className={a.status === 'cancelled' ? 'opacity-50' : ''}>
                      <td className="px-3 py-2">
                        <p className="text-gray-900">{a.name} <span className={`ml-1 text-[10px] font-semibold rounded px-1.5 py-0.5 ${STATUS_TONE[a.status] || ''}`}>{STATUS_LABELS[a.status] || a.status}</span></p>
                        <p className="text-[11px] text-gray-500">{CHANNEL_LABELS[a.channel] || a.channel}{a.supplier ? ` · ${a.supplier}` : ''}{a.links ? ` · ${a.links} link${a.links === 1 ? '' : 's'}` : ''}</p>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-700">{a.startsOn ? `${shortDate(a.startsOn)}${a.endsOn ? ` – ${shortDate(a.endsOn)}` : ''}` : '—'}</td>
                      <td className={`px-3 py-2 ${a.nextDueOn && a.nextDueOn < today ? 'text-red-700' : soon(a.nextDueOn) ? 'text-amber-700' : 'text-gray-700'}`}>
                        {a.nextDueOn ? <><span className="whitespace-nowrap">{shortDate(a.nextDueOn)}</span>{a.nextDueNote && <span className="block text-[11px]">{a.nextDueNote}</span>}</> : '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {a.proofReceivedOn
                          ? <span className="text-green-700">✓ {shortDate(a.proofReceivedOn)}</span>
                          : a.channel === 'print' ? <span className="text-amber-700">Waiting</span> : <span className="text-gray-400">—</span>}
                        {a.artworkUrl && <a href={a.artworkUrl} target="_blank" rel="noopener noreferrer" className="block text-[11px] text-ooosh-700 hover:underline">Artwork</a>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{a.cost !== null ? gbp2(a.cost) : '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{a.scans || '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{a.enquiries || '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-green-700">{a.booked ? `${a.booked}${a.bookedValue ? ` · ${gbp0(a.bookedValue)}` : ''}` : '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs text-gray-600 whitespace-nowrap">
                        {a.cost && a.enquiries ? <span className="block">{gbp0(a.cost / a.enquiries)} / enquiry</span> : null}
                        {a.cost && a.booked ? <span className="block">{gbp0(a.cost / a.booked)} / booking</span> : null}
                        {!(a.cost && (a.enquiries || a.booked)) && '—'}
                      </td>
                      <td className="px-3 py-2 text-right"><button type="button" onClick={() => setAdvertModal(a)} className="text-xs text-ooosh-700 hover:underline">Edit</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-gray-500 px-3 py-2 border-t border-gray-100">
                Enquiries and bookings count only people who came through one of the advert's tracked links. Someone who saw it and phoned shows under "Heard about us: Magazine / print" on Business figures instead.
              </p>
            </div>
          )
      )}

      {tab === 'links' && links && (
        links.length === 0
          ? <p className="text-sm text-gray-500 rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center">No tracked links yet. Make one for each advert (or each page an advert points at), then download its QR code for the artwork.</p>
          : (
            <div className="rounded-xl border border-gray-200 bg-white overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-xs text-gray-500 whitespace-nowrap">
                  <tr>
                    <th className="text-left font-semibold px-3 py-2">Link</th>
                    <th className="text-left font-semibold px-3 py-2">Goes to</th>
                    <th className="text-left font-semibold px-3 py-2">Advert</th>
                    <th className="text-right font-semibold px-3 py-2">Scans (30 days)</th>
                    <th className="text-right font-semibold px-3 py-2">Enquiries</th>
                    <th className="text-right font-semibold px-3 py-2">Booked</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {links.map((l) => (
                    <tr key={l.id} className={l.isActive ? '' : 'opacity-60'}>
                      <td className="px-3 py-2">
                        <p className="font-mono text-gray-900">{l.shortUrl.replace('https://', '')}{!l.isActive && <span className="ml-1 font-sans text-[10px] font-semibold bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">Paused</span>}</p>
                        {l.label && <p className="text-[11px] text-gray-500">{l.label}</p>}
                      </td>
                      <td className="px-3 py-2 max-w-xs truncate text-gray-700" title={l.destination}>{l.destination.replace(/^https?:\/\/(www\.)?/, '')}</td>
                      <td className="px-3 py-2 text-gray-700">{l.placementName || '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{l.scans}{l.scans30 !== l.scans && <span className="text-gray-400"> ({l.scans30})</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{l.enquiries || '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-green-700">{l.booked ? `${l.booked}${l.bookedValue ? ` · ${gbp0(l.bookedValue)}` : ''}` : '—'}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap space-x-2 text-xs">
                        <button type="button" onClick={() => copy(l.shortUrl)} className="text-ooosh-700 hover:underline">{copied === l.shortUrl ? 'Copied' : 'Copy'}</button>
                        <button type="button" onClick={() => setQrFor(l)} className="text-ooosh-700 hover:underline">QR</button>
                        <button type="button" onClick={() => setLinkModal(l)} className="text-ooosh-700 hover:underline">Edit</button>
                        <button type="button" onClick={() => togglePause(l)} className="text-gray-500 hover:underline">{l.isActive ? 'Pause' : 'Resume'}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-gray-500 px-3 py-2 border-t border-gray-100">
                Scans exclude link previews (WhatsApp, Facebook…) and crawlers. A paused link sends people to the home page instead.
              </p>
            </div>
          )
      )}

      {advertModal && <AdvertModal advert={advertModal === 'new' ? null : advertModal} onClose={() => setAdvertModal(null)} onSaved={() => { setAdvertModal(null); load(); }} />}
      {linkModal && adverts && <LinkModal link={linkModal === 'new' ? null : linkModal} adverts={adverts} onClose={() => setLinkModal(null)} onSaved={() => { setLinkModal(null); load(); }} />}
      {qrFor && <QrModal link={qrFor} onClose={() => setQrFor(null)} />}
    </div>
  );
}
