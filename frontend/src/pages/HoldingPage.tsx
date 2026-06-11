import { useEffect, useState, useCallback, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { EntitySearch } from '../components/holding/EntitySearch';
import { JobNumberField } from '../components/holding/JobNumberField';
import { NotifyClientModal } from '../components/holding/NotifyClientModal';
import { OrgJobSuggestions } from '../components/holding/OrgJobSuggestions';
import { DuplicateNudge } from '../components/holding/DuplicateNudge';
import { uploadHeldItemPhotos } from '../components/holding/photo-upload';
import { locationLabelOrDash } from '../components/holding/format';
import { ChaseReviewPanel } from '../components/holding/ChaseReviewPanel';
import type { HeldItem, HeldItemKind, HeldItemLocation } from '../../../shared/types';

// ── Helpers ─────────────────────────────────────────────────────────────────
const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB') : '—');
const inputCls = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm';

type View = 'held' | 'lost_property';
const VIEW_KINDS: Record<View, HeldItemKind[]> = {
  held: ['incoming', 'temp_storage'],
  lost_property: ['lost_property'],
};

const STATUS_COLOUR: Record<string, string> = {
  expected: 'bg-slate-100 text-slate-600',
  arrived: 'bg-blue-100 text-blue-800',
  stored: 'bg-blue-100 text-blue-800',
  client_notified: 'bg-amber-100 text-amber-800',
  collection_arranged: 'bg-amber-100 text-amber-800',
  collected: 'bg-green-100 text-green-700',
  given_to_client: 'bg-green-100 text-green-700',
  shipped_back: 'bg-green-100 text-green-700',
  disposed: 'bg-slate-200 text-slate-500',
  unclaimed: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-200 text-slate-500',
};
const statusLabel = (s: string) => s.replace(/_/g, ' ');
const KIND_LABEL: Record<HeldItemKind, string> = {
  incoming: 'Delivery', temp_storage: 'Temp storage', lost_property: 'Lost property',
};

// Inline photo thumbnail — authenticated blob fetch (download endpoint needs the JWT header)
function PhotoThumb({ photoKey, onOpen }: { photoKey: string; onOpen: () => void }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let url = '';
    api.blob(`/files/download?key=${encodeURIComponent(photoKey)}`)
      .then(({ blob }) => { url = URL.createObjectURL(blob); setSrc(url); })
      .catch(() => {});
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [photoKey]);
  return src
    ? <img src={src} onClick={onOpen} className="w-20 h-20 object-cover rounded-lg border border-slate-200 cursor-pointer hover:opacity-90" alt="" />
    : <div className="w-20 h-20 rounded-lg bg-slate-100 animate-pulse" />;
}
const FOUND_IN_LABEL: Record<string, string> = {
  van: 'Van', rehearsal: 'Rehearsal room', backline: 'Backline', elsewhere: 'Somewhere else',
};

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// Photo upload (shared shape with the rest of the app — R2 key in `url`)
async function uploadPhotos(files: FileList | null, onDone: (atts: { name: string; url: string; type: string }[]) => void, onErr: (m: string) => void, setBusy: (b: boolean) => void) {
  if (!files || files.length === 0) return;
  setBusy(true);
  try { onDone(await uploadHeldItemPhotos(files)); }
  catch (e) { onErr(e instanceof Error ? e.message : 'Upload failed'); } finally { setBusy(false); }
}

// ════════════════════════════════════════════════════════════════════════
export default function HoldingPage({ view }: { view: View }) {
  const [items, setItems] = useState<HeldItem[]>([]);
  const [locations, setLocations] = useState<HeldItemLocation[]>([]);
  const [search, setSearch] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [unknownOnly, setUnknownOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (showDone) qs.set('include_done', 'true');
      if (search.trim()) qs.set('search', search.trim());
      const r = await api.get<{ data: HeldItem[] }>(`/holding?${qs.toString()}`);
      setItems(r.data);
    } finally { setLoading(false); }
  }, [showDone, search]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get<{ data: HeldItemLocation[] }>('/holding/locations').then((r) => setLocations(r.data)).catch(() => {}); }, []);

  const [searchParams] = useSearchParams();
  const kinds = VIEW_KINDS[view];
  const rows = items.filter((i) => kinds.includes(i.kind) && (!unknownOnly || i.owner_unknown));
  const openCount = items.filter((i) => kinds.includes(i.kind) && !['collected', 'given_to_client', 'shipped_back', 'disposed', 'cancelled'].includes(i.status)).length;

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-2xl font-bold text-slate-800">{view === 'held' ? 'Held for Clients' : 'Lost Property'}</h1>
        <button onClick={() => setCreating(true)} className="bg-[#7B5EA7] text-white px-4 py-2 rounded-lg text-sm font-medium">
          {view === 'held' ? '+ Log Item' : '+ Log Lost Property'}
        </button>
      </div>

      {view === 'lost_property' && <ChaseReviewPanel defaultOpen={searchParams.get('review') === '1'} onChanged={load} />}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search description / client / job # / notes…"
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm flex-1 min-w-[200px]" />
        <label className="text-sm text-slate-600 flex items-center gap-2"><input type="checkbox" checked={unknownOnly} onChange={(e) => setUnknownOnly(e.target.checked)} /> Unknown owner</label>
        <label className="text-sm text-slate-600 flex items-center gap-2"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done</label>
        <span className="text-xs text-slate-400">{openCount} open</span>
      </div>

      <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs"><tr>
            <th className="text-left px-3 py-2">Item</th>
            <th className="text-left px-3 py-2">Client</th>
            {view === 'held'
              ? <><th className="text-left px-3 py-2">Job</th><th className="text-left px-3 py-2">Boxes</th><th className="text-left px-3 py-2">Needed by</th></>
              : <><th className="text-left px-3 py-2">Found in</th><th className="text-left px-3 py-2">Found</th></>}
            <th className="text-left px-3 py-2">Location</th>
            <th className="text-left px-3 py-2">Status</th>
          </tr></thead>
          <tbody>
            {rows.map((h) => {
              const client = h.owner_person_name || h.owner_organisation_name || h.client_name_text;
              const received = h.received_count != null && h.box_count != null ? `${h.received_count}/${h.box_count}` : (h.box_count != null ? String(h.box_count) : '—');
              return (
                <tr key={h.id} onClick={() => setDetailId(h.id)} className="border-t hover:bg-slate-50 cursor-pointer">
                  <td className="px-3 py-2 font-medium text-slate-800">
                    {h.description || <span className="text-slate-400 italic">No description</span>}
                    {view === 'held' && <span className="ml-1 text-xs text-slate-400">· {KIND_LABEL[h.kind]}</span>}
                  </td>
                  <td className="px-3 py-2">
                    {h.owner_unknown
                      ? <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">❓ Unknown</span>
                      : (client || <span className="text-slate-400">—</span>)}
                  </td>
                  {view === 'held'
                    ? <>
                        <td className="px-3 py-2">{h.hh_job_number ? `#${h.hh_job_number}` : '—'}</td>
                        <td className="px-3 py-2">{received}</td>
                        <td className="px-3 py-2">{fmtDate(h.needed_by)}</td>
                      </>
                    : <>
                        <td className="px-3 py-2">{h.found_in ? FOUND_IN_LABEL[h.found_in] : '—'}{h.found_vehicle_reg ? ` (${h.found_vehicle_reg})` : ''}</td>
                        <td className="px-3 py-2">{fmtDate(h.found_date)}</td>
                      </>}
                  <td className="px-3 py-2">{locationLabelOrDash(h)}</td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_COLOUR[h.status] || 'bg-slate-100'}`}>{statusLabel(h.status)}</span></td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={view === 'held' ? 6 : 5} className="px-3 py-8 text-center text-slate-400">{loading ? 'Loading…' : 'Nothing here.'}</td></tr>}
          </tbody>
        </table>
      </div>

      {creating && <CreateModal view={view} locations={locations} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
      {detailId && <DetailModal id={detailId} locations={locations} onClose={() => setDetailId(null)} onChange={load} />}
    </div>
  );
}

// ════════════════════════ CREATE ════════════════════════
function CreateModal({ view, locations, onClose, onSaved }: { view: View; locations: HeldItemLocation[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    kind: (view === 'lost_property' ? 'lost_property' : 'incoming') as HeldItemKind,
    description: '', box_count: '',
    owner_unknown: false,
    owner_organisation_id: null as string | null, org_name: '',
    owner_person_id: null as string | null, person_name: '',
    client_name_text: '', hh_job_number: '',
    found_in: 'van', found_location_text: '',
    storage_location_id: '', storage_location_text: '',
    expected_date: '', import_charge_flag: '', hold_until: '', notes: '',
  });
  const [photos, setPhotos] = useState<{ name: string; url: string; type: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const GIVEN = '__given__';
  const givenStraight = f.storage_location_id === GIVEN;
  const somewhereElse = (() => {
    const loc = locations.find((l) => l.id === f.storage_location_id);
    return loc?.name === 'Somewhere else';
  })();

  async function save() {
    setSaving(true); setErr('');
    try {
      await api.post('/holding', {
        kind: f.kind,
        owner_unknown: f.owner_unknown,
        description: f.description || null,
        box_count: f.box_count ? Number(f.box_count) : null,
        owner_organisation_id: f.owner_unknown ? null : f.owner_organisation_id,
        owner_person_id: f.owner_unknown ? null : f.owner_person_id,
        client_name_text: f.owner_unknown ? null : (f.client_name_text || null),
        hh_job_number: f.hh_job_number ? Number(f.hh_job_number) : null,
        found_in: f.kind === 'lost_property' ? f.found_in : null,
        found_location_text: f.kind === 'lost_property' ? (f.found_location_text || null) : null,
        storage_location_id: givenStraight ? null : (f.storage_location_id || null),
        storage_location_text: somewhereElse ? (f.storage_location_text || null) : null,
        status: givenStraight ? 'given_to_client' : undefined,
        expected_date: f.kind === 'incoming' && f.expected_date ? f.expected_date : null,
        import_charge_flag: f.kind === 'incoming' && f.import_charge_flag ? f.import_charge_flag : null,
        hold_until: f.kind === 'temp_storage' && f.hold_until ? f.hold_until : null,
        notes: f.notes || null,
        photos,
      });
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed'); } finally { setSaving(false); }
  }

  return (
    <Modal title={view === 'held' ? 'Log Held Item' : 'Log Lost Property'} onClose={onClose}>
      <div className="space-y-3">
        {view === 'held' && (
          <div className="flex gap-2">
            {(['incoming', 'temp_storage'] as HeldItemKind[]).map((k) => (
              <button key={k} type="button" onClick={() => setF({ ...f, kind: k })}
                className={`px-3 py-1.5 rounded-lg text-sm border ${f.kind === k ? 'bg-[#7B5EA7] text-white border-[#7B5EA7]' : 'bg-white text-slate-600 border-slate-300'}`}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        )}

        <div><label className="block text-xs text-slate-500 mb-1">Description</label>
          <input className={inputCls} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })}
            placeholder={view === 'lost_property' ? 'e.g. Black rucksack, 2 cables' : 'e.g. 3 merch boxes'} /></div>

        {f.kind !== 'lost_property' && (
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs text-slate-500 mb-1">Number of boxes/items</label><input className={inputCls} type="number" value={f.box_count} onChange={(e) => setF({ ...f, box_count: e.target.value })} /></div>
            {f.kind === 'incoming' && <div><label className="block text-xs text-slate-500 mb-1">Expected date</label><input className={inputCls} type="date" value={f.expected_date} onChange={(e) => setF({ ...f, expected_date: e.target.value })} /></div>}
          </div>
        )}

        {f.kind === 'lost_property' && (
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs text-slate-500 mb-1">Found in</label>
              <select className={inputCls} value={f.found_in} onChange={(e) => setF({ ...f, found_in: e.target.value })}>
                <option value="van">Van</option><option value="rehearsal">Rehearsal room</option><option value="backline">Backline</option><option value="elsewhere">Somewhere else</option>
              </select></div>
            {f.found_in === 'van' && <div><label className="block text-xs text-slate-500 mb-1">Van reg</label><input className={inputCls} value={f.found_location_text} onChange={(e) => setF({ ...f, found_location_text: e.target.value })} placeholder="e.g. RX22SXL" /></div>}
          </div>
        )}

        {/* Owner — HireHop job # first; we derive the client from it */}
        <div className="border border-slate-200 rounded-lg p-3 space-y-2">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={f.owner_unknown} onChange={(e) => setF({ ...f, owner_unknown: e.target.checked })} />
            Owner unknown (log now, link later)
          </label>
          {!f.owner_unknown && (
            <>
              <JobNumberField value={f.hh_job_number} onChange={(v) => setF({ ...f, hh_job_number: v })} />
              <DuplicateNudge hhJobNumber={f.hh_job_number} />
              <EntitySearch kind="organisations" label="Client / band (organisation)" value={f.org_name} onPick={(id, name) => setF({ ...f, owner_organisation_id: id, org_name: name })} />
              <OrgJobSuggestions orgId={f.owner_organisation_id} hasNumber={!!f.hh_job_number} onPick={(n) => setF({ ...f, hh_job_number: n })} />
              <EntitySearch kind="people" label="Or a person" value={f.person_name} onPick={(id, name) => setF({ ...f, owner_person_id: id, person_name: name })} />
              <div><label className="block text-xs text-slate-500 mb-1">Or just a name (free text)</label><input className={inputCls} value={f.client_name_text} onChange={(e) => setF({ ...f, client_name_text: e.target.value })} /></div>
            </>
          )}
        </div>

        {/* Where stored */}
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-xs text-slate-500 mb-1">Where stored</label>
            <select className={inputCls} value={f.storage_location_id} onChange={(e) => setF({ ...f, storage_location_id: e.target.value })}>
              <option value="">—</option>
              <option value={GIVEN}>✋ Given straight to client</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select></div>
          {somewhereElse && <div><label className="block text-xs text-slate-500 mb-1">Where exactly?</label><input className={inputCls} value={f.storage_location_text} onChange={(e) => setF({ ...f, storage_location_text: e.target.value })} /></div>}
        </div>

        {f.kind === 'incoming' && (
          <div><label className="block text-xs text-slate-500 mb-1">Customs / import charge?</label>
            <select className={inputCls} value={f.import_charge_flag} onChange={(e) => setF({ ...f, import_charge_flag: e.target.value })}>
              <option value="">—</option><option value="no">No</option><option value="yes">Yes</option><option value="unknown">Don't know</option>
            </select></div>
        )}

        {f.kind === 'temp_storage' && (
          <div><label className="block text-xs text-slate-500 mb-1">Hold until (optional)</label>
            <input className={inputCls} type="date" value={f.hold_until} onChange={(e) => setF({ ...f, hold_until: e.target.value })} />
            <p className="text-[11px] text-slate-400 mt-1">We'll remind the team 3 days before this date.</p></div>
        )}

        {/* Photos */}
        <div>
          <label className="block text-xs text-slate-500 mb-1">Photos</label>
          <div className="flex flex-wrap gap-2 mb-2">
            {photos.map((p, idx) => (
              <span key={idx} className="inline-flex items-center gap-1 text-xs bg-slate-100 rounded px-2 py-1">📷 {p.name}
                <button type="button" onClick={() => setPhotos((cur) => cur.filter((_, j) => j !== idx))} className="text-red-500">×</button></span>
            ))}
          </div>
          <input type="file" accept="image/*" multiple capture="environment" className="text-xs"
            onChange={(e) => uploadPhotos(e.target.files, (a) => setPhotos((p) => [...p, ...a]), setErr, setUploading)} />
          {uploading && <span className="text-xs text-slate-400 ml-2">Uploading…</span>}
        </div>

        <div><label className="block text-xs text-slate-500 mb-1">Notes</label><textarea className={inputCls} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>

        {err && <p className="text-red-600 text-sm">{err}</p>}
        <div className="flex justify-end gap-2"><button onClick={onClose} className="px-4 py-2 text-sm text-slate-600">Cancel</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm bg-[#7B5EA7] text-white rounded-lg disabled:opacity-50">{saving ? 'Saving…' : 'Log it'}</button></div>
      </div>
    </Modal>
  );
}

// ════════════════════════ DETAIL ════════════════════════
function DetailModal({ id, locations, onClose, onChange }: { id: string; locations: HeldItemLocation[]; onClose: () => void; onChange: () => void }) {
  const [h, setH] = useState<HeldItem | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [openAction, setOpenAction] = useState<null | 'collect' | 'ship' | 'location'>(null);

  const load = useCallback(async () => { setH((await api.get<{ data: HeldItem }>(`/holding/${id}`)).data); }, [id]);
  useEffect(() => { load(); }, [load]);

  async function action(label: string, fn: () => Promise<void>) {
    setBusy(label); setMsg('');
    try { await fn(); await load(); onChange(); } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(''); }
  }
  if (!h) return <Modal title="Held item" onClose={onClose}><p className="text-slate-400">Loading…</p></Modal>;

  const client = h.owner_person_name || h.owner_organisation_name || h.client_name_text;
  const isOpen = !['collected', 'given_to_client', 'shipped_back', 'disposed', 'cancelled'].includes(h.status);

  async function viewPhoto(key: string) {
    try {
      const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(key)}`);
      window.open(URL.createObjectURL(blob), '_blank');
    } catch { setMsg('Could not open photo.'); }
  }

  return (
    <Modal title={h.description || KIND_LABEL[h.kind]} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_COLOUR[h.status] || 'bg-slate-100'}`}>{statusLabel(h.status)}</span>
          <span className="text-xs text-slate-400">{KIND_LABEL[h.kind]}</span>
          {h.owner_unknown && <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">❓ Unknown owner</span>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Client" value={client || (h.owner_unknown ? 'Unknown' : '—')} />
          <div>
            <p className="text-xs text-slate-400">Job (HH #)</p>
            {h.hh_job_number
              ? (h.job_id
                  ? <Link to={`/jobs/${h.job_id}`} title="Opens the job in the operations portal" className="text-ooosh-600 hover:underline">#{h.hh_job_number} · open job in OP →</Link>
                  : <p className="text-slate-800">#{h.hh_job_number} <span className="text-xs text-slate-400">(not linked in OP)</span></p>)
              : <p className="text-slate-800">—</p>}
          </div>
          {h.kind !== 'lost_property' && <Field label="Boxes" value={h.received_count != null && h.box_count != null ? `${h.received_count}/${h.box_count}` : (h.box_count != null ? String(h.box_count) : '—')} />}
          {/* Before arrival: show expected / needed-by. After: show the arrival log. */}
          {h.kind !== 'lost_property' && h.status === 'expected' && <>
            <Field label="Expected" value={fmtDate(h.expected_date)} />
            <Field label="Needed by" value={fmtDate(h.needed_by)} />
          </>}
          {h.kind !== 'lost_property' && h.status !== 'expected' && h.arrived_at &&
            <Field label="Arrived" value={`${fmtDate(h.arrived_at)}${h.received_by_name ? ` by ${h.received_by_name}` : ''}`} />}
          {h.kind === 'lost_property' && <Field label="Found in" value={h.found_in ? `${FOUND_IN_LABEL[h.found_in]}${h.found_vehicle_reg ? ` (${h.found_vehicle_reg})` : (h.found_location_text ? ` (${h.found_location_text})` : '')}` : '—'} />}
          {h.kind === 'lost_property' && <Field label="Found date" value={fmtDate(h.found_date)} />}
          <Field label="Location" value={locationLabelOrDash(h)} />
          {h.import_charge_flag && <Field label="Import charge" value={h.import_charge_flag} />}
          {h.collected_at && <Field label="Collected" value={`${fmtDate(h.collected_at)}${h.collected_by ? ` by ${h.collected_by}` : ''}`} />}
          {h.return_method && <Field label="Shipped back" value={`${h.return_method}${h.tracking_number ? ` · ${h.tracking_number}` : ''}`} />}
        </div>

        {h.notes && <p className="text-slate-600"><span className="text-xs text-slate-400">Notes: </span>{h.notes}</p>}

        {/* Photos — inline thumbnails */}
        {(h.photos || []).length > 0 && (
          <div className="flex flex-wrap gap-2">
            {h.photos.map((p, idx) => <PhotoThumb key={idx} photoKey={p.url} onOpen={() => viewPhoto(p.url)} />)}
          </div>
        )}

        {msg && <p className="text-red-600">{msg}</p>}

        {/* Chase & collection (lost property) */}
        {h.kind === 'lost_property' && isOpen && <ChaseCollectionSection item={h} onChange={() => { load(); onChange(); }} />}

        {/* Hold until (temp storage) */}
        {h.kind === 'temp_storage' && isOpen && <HoldUntilSection item={h} onChange={() => { load(); onChange(); }} />}

        {/* Link / backfill owner */}
        {isOpen && (
          <div>
            <button onClick={() => setLinkOpen((v) => !v)} className="text-xs text-[#7B5EA7] font-medium">
              {h.owner_unknown ? '🔗 Link owner / job' : '✎ Change owner / job'}
            </button>
            {linkOpen && <LinkForm item={h} onDone={() => { setLinkOpen(false); load(); onChange(); }} />}
          </div>
        )}

        {/* Actions — when one inline action is open, the rest hide so the
            "next step" isn't surrounded by unrelated buttons. */}
        {isOpen && (
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            {openAction === 'collect' && <CollectButton id={id} kind={h.kind} busy={busy} open onClose={() => setOpenAction(null)} onAction={action} />}
            {openAction === 'ship' && <ShipBackButton id={id} busy={busy} open onClose={() => setOpenAction(null)} onAction={action} />}
            {openAction === 'location' && <LocationButton id={id} locations={locations} current={h.storage_location_id} open onClose={() => setOpenAction(null)} onDone={() => { load(); onChange(); }} />}
            {openAction === null && (
              <>
                {(h.status === 'expected' || h.status === 'arrived' || h.status === 'stored' || h.status === 'client_notified') && (
                  <button disabled={!!busy} onClick={() => setNotifyOpen(true)}
                    className="px-3 py-1.5 bg-slate-700 text-white rounded-lg text-xs">✉ Notify client</button>
                )}
                <CollectButton id={id} kind={h.kind} busy={busy} onOpen={() => setOpenAction('collect')} onAction={action} />
                <ShipBackButton id={id} busy={busy} onOpen={() => setOpenAction('ship')} onAction={action} />
                {h.kind === 'incoming' && h.status === 'expected' && (
                  <button disabled={!!busy} onClick={() => { if (confirm("Mark this as not arriving? It'll drop off the prep checklist.")) action('cancel', async () => { await api.put(`/holding/${id}`, { status: 'cancelled' }); onClose(); }); }}
                    className="px-3 py-1.5 bg-white border border-slate-300 text-slate-600 rounded-lg text-xs">✕ Won't arrive</button>
                )}
                {h.kind === 'lost_property' && (
                  <button disabled={!!busy} onClick={() => action('chase', async () => { await api.post(`/holding/${id}/chase`, {}); setMsg('Chase logged (escalation bumped).'); })}
                    className="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs">📨 Log chase (lvl {h.escalation_level})</button>
                )}
                <button disabled={!!busy} onClick={() => { if (confirm('Mark as disposed?')) action('dispose', async () => { await api.post(`/holding/${id}/dispose`, {}); onClose(); }); }}
                  className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs">🗑 Dispose</button>
                <LocationButton id={id} locations={locations} current={h.storage_location_id} onOpen={() => setOpenAction('location')} onDone={() => { load(); onChange(); }} />
              </>
            )}
          </div>
        )}
      </div>
      {notifyOpen && (
        <NotifyClientModal item={h} onClose={() => setNotifyOpen(false)}
          onSent={(n) => { setNotifyOpen(false); setMsg(n > 0 ? `Sent to ${n} recipient${n === 1 ? '' : 's'}.` : 'Marked notified.'); load(); onChange(); }} />
      )}
    </Modal>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs text-slate-400">{label}</p><p className="text-slate-800 capitalize">{value}</p></div>;
}

const dstr = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB') : null);
function addDays(d: string, n: number): string {
  const x = new Date(d); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-GB');
}

// Lost property: two timers (last contacted / next chase due) + defer control.
function ChaseCollectionSection({ item, onChange }: { item: HeldItem; onChange: () => void }) {
  const [date, setDate] = useState(item.expected_collection_date ? item.expected_collection_date.slice(0, 10) : '');
  const [saving, setSaving] = useState(false);
  const paused = item.expected_collection_date && new Date(item.expected_collection_date) >= new Date();
  const nextDue = paused
    ? `Paused until ${dstr(item.expected_collection_date)}`
    : item.last_chased_at ? addDays(item.last_chased_at, 7)
    : item.found_date ? addDays(item.found_date, 7) : '—';

  async function save(val: string | null) {
    setSaving(true);
    try { await api.put(`/holding/${item.id}`, { expected_collection_date: val }); onChange(); }
    finally { setSaving(false); }
  }

  return (
    <div className="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50/50">
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div><p className="text-slate-400">Last contacted</p><p className="text-slate-700">{dstr(item.last_chased_at) || 'Not yet'}</p></div>
        <div><p className="text-slate-400">Next chase due</p><p className={paused ? 'text-blue-600' : 'text-slate-700'}>{nextDue}</p></div>
        <div><p className="text-slate-400">Chases sent</p><p className="text-slate-700">{item.escalation_level || 0}</p></div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1 border-t">
        <label className="text-xs text-slate-500">Expected collection date:</label>
        <input type="date" className="border border-slate-300 rounded px-2 py-1 text-xs" value={date} onChange={(e) => setDate(e.target.value)} />
        <button disabled={saving || !date} onClick={() => save(date)} className="text-xs bg-[#7B5EA7] text-white px-3 py-1 rounded disabled:opacity-40">Save (pause chases)</button>
        {item.expected_collection_date && <button disabled={saving} onClick={() => { setDate(''); save(null); }} className="text-xs text-slate-500">clear</button>}
      </div>
      <p className="text-[11px] text-slate-400">Set a date the client's said they'll collect — chases pause until it passes.</p>
    </div>
  );
}

// Temp storage: hold-until date (staff reminded 3 days before).
function HoldUntilSection({ item, onChange }: { item: HeldItem; onChange: () => void }) {
  const [date, setDate] = useState(item.hold_until ? item.hold_until.slice(0, 10) : '');
  const [saving, setSaving] = useState(false);
  async function save(val: string | null) {
    setSaving(true);
    try { await api.put(`/holding/${item.id}`, { hold_until: val }); onChange(); }
    finally { setSaving(false); }
  }
  return (
    <div className="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50/50">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-500">Hold until:</label>
        <input type="date" className="border border-slate-300 rounded px-2 py-1 text-xs" value={date} onChange={(e) => setDate(e.target.value)} />
        <button disabled={saving || !date} onClick={() => save(date)} className="text-xs bg-[#7B5EA7] text-white px-3 py-1 rounded disabled:opacity-40">Save</button>
        {item.hold_until && <button disabled={saving} onClick={() => { setDate(''); save(null); }} className="text-xs text-slate-500">clear</button>}
        {item.hold_until && <span className="text-xs text-slate-500">currently {dstr(item.hold_until)}</span>}
      </div>
      <p className="text-[11px] text-slate-400">We'll remind the team 3 days before this date.</p>
    </div>
  );
}

function LinkForm({ item, onDone }: { item: HeldItem; onDone: () => void }) {
  const [org, setOrg] = useState({ id: item.owner_organisation_id, name: item.owner_organisation_name || '' });
  const [person, setPerson] = useState({ id: item.owner_person_id, name: item.owner_person_name || '' });
  const [clientText, setClientText] = useState(item.client_name_text || '');
  const [hh, setHh] = useState(item.hh_job_number ? String(item.hh_job_number) : '');
  const [saving, setSaving] = useState(false);
  return (
    <div className="border border-slate-200 rounded-lg p-3 mt-2 space-y-2">
      <EntitySearch kind="organisations" label="Client / band" value={org.name} onPick={(id, name) => setOrg({ id, name })} />
      <EntitySearch kind="people" label="Person" value={person.name} onPick={(id, name) => setPerson({ id, name })} />
      <div><label className="block text-xs text-slate-500 mb-1">Or a name</label><input className={inputCls} value={clientText} onChange={(e) => setClientText(e.target.value)} /></div>
      <div><label className="block text-xs text-slate-500 mb-1">HireHop job #</label><input className={inputCls} type="number" value={hh} onChange={(e) => setHh(e.target.value)} /></div>
      <div className="flex justify-end">
        <button disabled={saving} onClick={async () => {
          setSaving(true);
          try {
            await api.post(`/holding/${item.id}/link`, {
              owner_organisation_id: org.id, owner_person_id: person.id,
              client_name_text: clientText || null, hh_job_number: hh ? Number(hh) : null,
            });
            onDone();
          } finally { setSaving(false); }
        }} className="text-xs bg-[#7B5EA7] text-white px-3 py-1.5 rounded-lg disabled:opacity-50">Save link</button>
      </div>
    </div>
  );
}

function CollectButton({ id, kind, busy, open, onOpen, onClose, onAction }: { id: string; kind: HeldItemKind; busy: string; open?: boolean; onOpen?: () => void; onClose?: () => void; onAction: (l: string, fn: () => Promise<void>) => void }) {
  const [who, setWho] = useState('');
  const label = kind === 'incoming' ? '✅ Given to client' : '✅ Collected';
  if (!open) return <button disabled={!!busy} onClick={onOpen} className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs">{label}</button>;
  return (
    <div className="w-full border border-slate-200 rounded-lg p-2 flex flex-wrap items-center gap-2">
      <input autoFocus className="border border-slate-300 rounded px-2 py-1 text-xs flex-1 min-w-[140px]" placeholder="Collected/received by (name)" value={who} onChange={(e) => setWho(e.target.value)} />
      <button className="text-xs text-slate-500" onClick={onClose}>cancel</button>
      <button className="text-xs bg-green-600 text-white px-3 py-1 rounded" onClick={() => onAction('collected', async () => { await api.post(`/holding/${id}/collected`, { collected_by: who || null }); })}>Confirm</button>
    </div>
  );
}

function ShipBackButton({ id, busy, open, onOpen, onClose, onAction }: { id: string; busy: string; open?: boolean; onOpen?: () => void; onClose?: () => void; onAction: (l: string, fn: () => Promise<void>) => void }) {
  const [method, setMethod] = useState('');
  const [tracking, setTracking] = useState('');
  const [notify, setNotify] = useState(true);
  if (!open) return <button disabled={!!busy} onClick={onOpen} className="px-3 py-1.5 bg-slate-700 text-white rounded-lg text-xs">📮 Ship back</button>;
  return (
    <div className="w-full border border-slate-200 rounded-lg p-2 flex flex-wrap items-center gap-2">
      <input autoFocus className="border border-slate-300 rounded px-2 py-1 text-xs" placeholder="Postage method" value={method} onChange={(e) => setMethod(e.target.value)} />
      <input className="border border-slate-300 rounded px-2 py-1 text-xs" placeholder="Tracking #" value={tracking} onChange={(e) => setTracking(e.target.value)} />
      <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> email client</label>
      <button className="text-xs text-slate-500" onClick={onClose}>cancel</button>
      <button disabled={!method.trim()} className="text-xs bg-slate-700 text-white px-3 py-1 rounded disabled:opacity-40" onClick={() => onAction('ship', async () => { await api.post(`/holding/${id}/ship-back`, { return_method: method, tracking_number: tracking || null, notify }); })}>Confirm</button>
    </div>
  );
}

function LocationButton({ id, locations, current, open, onOpen, onClose, onDone }: { id: string; locations: HeldItemLocation[]; current: string | null; open?: boolean; onOpen?: () => void; onClose?: () => void; onDone: () => void }) {
  const [loc, setLoc] = useState(current || '');
  const [text, setText] = useState('');
  const somewhereElse = locations.find((l) => l.id === loc)?.name === 'Somewhere else';
  if (!open) return <button onClick={onOpen} className="px-3 py-1.5 bg-white border border-slate-300 text-slate-600 rounded-lg text-xs">📍 Move</button>;
  return (
    <div className="w-full border border-slate-200 rounded-lg p-2 flex flex-wrap items-center gap-2">
      <select className="border border-slate-300 rounded px-2 py-1 text-xs" value={loc} onChange={(e) => setLoc(e.target.value)}>
        <option value="">—</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
      {somewhereElse && <input className="border border-slate-300 rounded px-2 py-1 text-xs" placeholder="Where?" value={text} onChange={(e) => setText(e.target.value)} />}
      <button className="text-xs text-slate-500" onClick={onClose}>cancel</button>
      <button className="text-xs bg-[#7B5EA7] text-white px-3 py-1 rounded" onClick={async () => { await api.put(`/holding/${id}`, { storage_location_id: loc || null, storage_location_text: somewhereElse ? (text || null) : null }); onClose?.(); onDone(); }}>Save</button>
    </div>
  );
}
