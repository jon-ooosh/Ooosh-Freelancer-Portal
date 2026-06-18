import { useEffect, useState, useCallback, ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { HeldItemsSection } from '../components/HeldItemsSection';

// ── Types ───────────────────────────────────────────────────────────────
type SizeCat = 'small' | 'medium' | 'large' | 'xl';

interface Overview {
  rooms_by_status: Record<string, number>;
  active_tenancies: number;
  weekly_revenue: number;
  monthly_revenue: number;
  billing_due: number;
  reviews_due: number;
  access_open: number;
  waiting: number;
}
interface Room {
  id: string; name: string; size_category: SizeCat; location_type: string | null; default_weekly_rate: number | null;
  dimensions: string | null; area_sqft: number | null; description: string | null;
  photos?: { name: string; url: string; type?: string }[];
  status: string; notes: string | null; occupant_name?: string | null; tenancy_id?: string | null;
}
interface Tenancy {
  id: string; room_id: string; room_name: string; size_category: SizeCat; location_type?: string | null;
  organisation_id: string | null;
  organisation_name: string | null; lead_contact_name: string | null; lead_contact_person_id: string | null; status: string;
  move_in_date: string | null; move_out_date: string | null; weekly_rate: number; billing_mode: string;
  billing_cadence: string; next_bill_date: string | null; next_rate_review_date: string | null;
  last_rate_change_date: string | null; previous_weekly_rate: number | null; tcs_accepted_at: string | null;
  notes: string | null; access_type?: string | null; access_code?: string | null; key_location?: string | null;
  rate_history?: { id: string; effective_date: string; old_rate: number | null; new_rate: number; notes: string | null }[];
  access_list?: { id: string; person_name: string | null; name: string | null; phone: string | null; relationship: string | null }[];
  invoices?: { id: string; due_date: string; amount: number | null; sent_at: string }[];
}
interface AccessEvent {
  id: string; type: string; description: string | null; method: string; requested_date: string | null;
  status: string; room_name: string | null; organisation_name: string | null;
  attendee_person_name: string | null; attendee_name: string | null; actioned_at: string | null; notes: string | null;
}
interface Waiting {
  id: string; organisation_name: string | null; person_name: string | null; contact_name: string | null;
  contact_email: string | null; contact_phone: string | null; preferred_size: string | null;
  date_requested: string; date_last_offered: string | null; status: string; notes: string | null;
}
interface TcsVersion { id: string; version: string; is_current: boolean; effective_date: string; body: string; }

const TABS = ['tenancies', 'rooms', 'waiting', 'access', 'tcs'] as const;
type Tab = typeof TABS[number];
const TAB_LABELS: Record<Tab, string> = { rooms: 'Rooms', tenancies: 'Tenancies', waiting: 'Waiting List', access: 'Access Requests', tcs: 'T&Cs' };

const money = (n: number | null | undefined) => `£${Number(n || 0).toFixed(2)}`;
const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB') : '—');
const ROOM_STATUS_COLOUR: Record<string, string> = {
  available: 'bg-green-100 text-green-800', occupied: 'bg-blue-100 text-blue-800',
  reserved: 'bg-amber-100 text-amber-800', out_of_use: 'bg-slate-200 text-slate-600',
};

// ── Reusable: entity search picker ─────────────────────────────────────────
function EntitySearch({ kind, value, label, onPick }: {
  kind: 'organisations' | 'people'; value: string; label: string;
  onPick: (id: string | null, name: string) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ data: Array<Record<string, string>> }>(`/${kind}?search=${encodeURIComponent(q)}&limit=8`);
        setResults(r.data.map((x) => ({ id: x.id, name: kind === 'people' ? `${x.first_name || ''} ${x.last_name || ''}`.trim() : x.name })));
        setOpen(true);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(t);
  }, [q, kind]);
  return (
    <div className="relative">
      {label && <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>}
      {value ? (
        <div className="flex items-center gap-2 border border-slate-300 rounded-lg px-3 py-2 bg-slate-50">
          <span className="text-sm flex-1">{value}</span>
          <button type="button" onClick={() => { onPick(null, ''); setQ(''); }} className="text-xs text-red-500">clear</button>
        </div>
      ) : (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${kind}…`}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
          {open && results.length > 0 && (
            <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow max-h-48 overflow-y-auto">
              {results.map((r) => (
                <button type="button" key={r.id} onClick={() => { onPick(r.id, r.name); setOpen(false); }}
                  className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-50">{r.name}</button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Lead-contact picker scoped to the selected org (global search fallback) ──
interface OrgPerson { person_id: string; person_name: string; role: string | null; status: string }
function ContactPicker({ orgId, value, onPick }: { orgId: string | null; value: string; onPick: (id: string | null, name: string) => void }) {
  const [orgPeople, setOrgPeople] = useState<OrgPerson[]>([]);
  const [searchAll, setSearchAll] = useState(false);
  useEffect(() => {
    setSearchAll(false);
    if (!orgId) { setOrgPeople([]); return; }
    api.get<{ people?: OrgPerson[] }>(`/organisations/${orgId}`)
      .then((o) => setOrgPeople((o.people || []).filter((p) => p.status !== 'ended')))
      .catch(() => setOrgPeople([]));
  }, [orgId]);
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1">Lead contact</label>
      {value ? (
        <div className="flex items-center gap-2 border border-slate-300 rounded-lg px-3 py-2 bg-slate-50">
          <span className="text-sm flex-1">{value}</span>
          <button type="button" onClick={() => onPick(null, '')} className="text-xs text-red-500">clear</button>
        </div>
      ) : orgId && orgPeople.length > 0 && !searchAll ? (
        <div className="space-y-1">
          {orgPeople.map((p) => (
            <button type="button" key={p.person_id} onClick={() => onPick(p.person_id, p.person_name)}
              className="block w-full text-left px-3 py-2 text-sm border border-slate-200 rounded-lg hover:bg-slate-50">
              {p.person_name}{p.role ? <span className="text-slate-400"> · {p.role}</span> : ''}
            </button>
          ))}
          <button type="button" onClick={() => setSearchAll(true)} className="text-xs text-[#7B5EA7]">search all people instead</button>
        </div>
      ) : (
        <>
          <EntitySearch kind="people" label="" value="" onPick={onPick} />
          {orgId && orgPeople.length > 0 && <button type="button" onClick={() => setSearchAll(false)} className="text-xs text-[#7B5EA7] mt-1">back to {`${orgPeople.length}`} org contact{orgPeople.length !== 1 ? 's' : ''}</button>}
        </>
      )}
    </div>
  );
}

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

const inputCls = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm';

// ════════════════════════════════════════════════════════════════════════
export default function StoragePage() {
  const role = useAuthStore((s) => s.user?.role) || '';
  const isAdminManager = role === 'admin' || role === 'manager';
  const [params, setParams] = useSearchParams();
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'tenancies') as Tab;
  const setTab = (t: Tab) => setParams({ tab: t });

  const [overview, setOverview] = useState<Overview | null>(null);
  const loadOverview = useCallback(async () => {
    try { setOverview((await api.get<{ data: Overview }>('/storage/overview')).data); } catch { /* */ }
  }, []);
  useEffect(() => { loadOverview(); }, [loadOverview]);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-2xl font-bold text-slate-800">Storage</h1>
        {overview && (
          <div className="flex flex-wrap gap-2 text-sm">
            <Stat label="Occupied" value={`${overview.rooms_by_status.occupied || 0}`} />
            <Stat label="Available" value={`${overview.rooms_by_status.available || 0}`} tone="green" />
            <Stat label="Monthly revenue" value={money(overview.monthly_revenue)} />
            {overview.billing_due > 0 && <Stat label="Invoices due" value={`${overview.billing_due}`} tone="amber" />}
            {overview.reviews_due > 0 && <Stat label="Rate reviews" value={`${overview.reviews_due}`} tone="amber" />}
            {overview.access_open > 0 && <Stat label="Access open" value={`${overview.access_open}`} tone="amber" />}
            {overview.waiting > 0 && <Stat label="Waiting" value={`${overview.waiting}`} />}
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b mb-5 overflow-x-auto overflow-y-hidden scrollbar-hide">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px ${tab === t ? 'border-[#7B5EA7] text-[#7B5EA7]' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === 'rooms' && <RoomsTab isAdminManager={isAdminManager} onChange={loadOverview} />}
      {tab === 'tenancies' && <TenanciesTab isAdminManager={isAdminManager} onChange={loadOverview} />}
      {tab === 'waiting' && <WaitingTab onChange={loadOverview} />}
      {tab === 'access' && <AccessTab onChange={loadOverview} />}
      {tab === 'tcs' && <TcsTab isAdminManager={isAdminManager} />}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'amber' }) {
  const cls = tone === 'green' ? 'bg-green-50 text-green-700' : tone === 'amber' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-700';
  return <span className={`px-3 py-1.5 rounded-lg ${cls}`}><span className="font-semibold">{value}</span> <span className="text-xs">{label}</span></span>;
}

// ════════════════════════ ROOMS TAB ════════════════════════
function RoomsTab({ isAdminManager, onChange }: { isAdminManager: boolean; onChange: () => void }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [editing, setEditing] = useState<Room | null>(null);
  const [creating, setCreating] = useState(false);
  const [vacancySize, setVacancySize] = useState<string | null>(null);
  const load = useCallback(async () => { setRooms((await api.get<{ data: Room[] }>('/storage/rooms')).data); }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      {isAdminManager && (
        <button onClick={() => setCreating(true)} className="mb-4 bg-[#7B5EA7] text-white px-4 py-2 rounded-lg text-sm font-medium">+ Add Room</button>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rooms.map((r) => (
          <div key={r.id} className="border border-slate-200 rounded-xl p-4 bg-white">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-semibold text-slate-800">{r.name}</h3>
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${ROOM_STATUS_COLOUR[r.status] || 'bg-slate-100'}`}>{r.status.replace('_', ' ')}</span>
            </div>
            <p className="text-xs text-slate-500 mb-2 capitalize">
              {r.size_category}{r.location_type ? ` · ${r.location_type}` : ''}{r.dimensions ? ` · ${r.dimensions}` : ''}
            </p>
            {r.occupant_name && <p className="text-sm text-slate-700 mb-1">📦 {r.occupant_name}</p>}
            {r.default_weekly_rate != null && <p className="text-xs text-slate-500">Default {money(r.default_weekly_rate)}/wk</p>}
            {(r.photos?.length ?? 0) > 0 && <p className="text-xs text-slate-400">📷 {r.photos!.length} photo{r.photos!.length !== 1 ? 's' : ''}</p>}
            <div className="flex items-center gap-3 mt-2">
              {isAdminManager && <button onClick={() => setEditing(r)} className="text-xs text-[#7B5EA7]">Edit</button>}
              {r.status === 'available' && <button onClick={() => setVacancySize(r.size_category)} className="text-xs text-[#7B5EA7]">Find tenant →</button>}
            </div>
          </div>
        ))}
        {rooms.length === 0 && <p className="text-slate-400 text-sm">No rooms yet.</p>}
      </div>
      {(creating || editing) && (
        <RoomModal room={editing} onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); load(); onChange(); }} />
      )}
      {vacancySize && <VacancyMatchModal size={vacancySize} onClose={() => setVacancySize(null)} />}
    </div>
  );
}

function RoomModal({ room, onClose, onSaved }: { room: Room | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: room?.name || '', size_category: room?.size_category || 'medium',
    location_type: room?.location_type || '', default_weekly_rate: room?.default_weekly_rate != null ? String(room.default_weekly_rate) : '',
    dimensions: room?.dimensions || '', description: room?.description || '', status: room?.status || 'available', notes: room?.notes || '',
  });
  const [photos, setPhotos] = useState<{ name: string; url: string; type?: string }[]>(room?.photos || []);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true); setErr('');
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('attachment_only', 'true');
        const token = useAuthStore.getState().accessToken;
        const res = await fetch('/api/files/upload', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd });
        if (!res.ok) throw new Error('Upload failed');
        const j = await res.json();
        setPhotos((p) => [...p, { name: j.filename || file.name, url: j.r2_key, type: 'image' }]);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : 'Upload failed'); } finally { setUploading(false); }
  }

  async function save() {
    if (!f.name.trim()) { setErr('Name is required'); return; }
    setSaving(true); setErr('');
    try {
      const body = {
        name: f.name, size_category: f.size_category, status: f.status,
        location_type: f.location_type || null,
        default_weekly_rate: f.default_weekly_rate ? Number(f.default_weekly_rate) : null,
        dimensions: f.dimensions || null, description: f.description || null, notes: f.notes || null, photos,
      };
      if (room) await api.put(`/storage/rooms/${room.id}`, body);
      else await api.post('/storage/rooms', body);
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed'); } finally { setSaving(false); }
  }
  return (
    <Modal title={room ? `Edit ${room.name}` : 'Add Room'} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-xs text-slate-500 mb-1">Name</label><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><label className="block text-xs text-slate-500 mb-1">Size</label>
            <select className={inputCls} value={f.size_category} onChange={(e) => setF({ ...f, size_category: e.target.value as SizeCat })}>
              <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option><option value="xl">XL</option>
            </select></div>
          <div><label className="block text-xs text-slate-500 mb-1">Location</label>
            <select className={inputCls} value={f.location_type} onChange={(e) => setF({ ...f, location_type: e.target.value })}>
              <option value="">—</option><option value="internal">Internal</option><option value="external">External</option>
            </select></div>
          <div><label className="block text-xs text-slate-500 mb-1">Default rate £/wk</label><input className={inputCls} type="number" value={f.default_weekly_rate} onChange={(e) => setF({ ...f, default_weekly_rate: e.target.value })} placeholder="e.g. 25" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-xs text-slate-500 mb-1">Dimensions / area</label><input className={inputCls} value={f.dimensions} onChange={(e) => setF({ ...f, dimensions: e.target.value })} placeholder="e.g. 3m × 4m" /></div>
          <div><label className="block text-xs text-slate-500 mb-1">Status</label>
            <select className={inputCls} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="available">Available</option><option value="occupied">Occupied</option><option value="reserved">Reserved</option><option value="out_of_use">Out of use</option>
            </select></div>
        </div>
        <div><label className="block text-xs text-slate-500 mb-1">Description</label><textarea className={inputCls} rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Reference detail for enquiries" /></div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Photos</label>
          <div className="flex flex-wrap gap-2 mb-2">
            {photos.map((p, idx) => (
              <span key={idx} className="inline-flex items-center gap-1 text-xs bg-slate-100 rounded px-2 py-1">
                📷 {p.name}
                <button type="button" onClick={() => setPhotos((cur) => cur.filter((_, j) => j !== idx))} className="text-red-500">×</button>
              </span>
            ))}
          </div>
          <input type="file" accept="image/*" multiple onChange={(e) => handleUpload(e.target.files)} className="text-xs" />
          {uploading && <span className="text-xs text-slate-400 ml-2">Uploading…</span>}
        </div>
        {err && <p className="text-red-600 text-sm">{err}</p>}
        <div className="flex justify-end gap-2"><button onClick={onClose} className="px-4 py-2 text-sm text-slate-600">Cancel</button><button onClick={save} disabled={saving} className="px-4 py-2 text-sm bg-[#7B5EA7] text-white rounded-lg disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button></div>
      </div>
    </Modal>
  );
}

// ════════════════════════ TENANCIES TAB ════════════════════════
function TenanciesTab({ isAdminManager, onChange }: { isAdminManager: boolean; onChange: () => void }) {
  const [rows, setRows] = useState<Tenancy[]>([]);
  const [showEnded, setShowEnded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [vacancySize, setVacancySize] = useState<string | null>(null);
  const load = useCallback(async () => {
    setRows((await api.get<{ data: Tenancy[] }>(`/storage/tenancies?status=${showEnded ? 'all' : 'live'}`)).data);
  }, [showEnded]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="flex items-center justify-end mb-3">
        <label className="text-sm text-slate-600 flex items-center gap-2"><input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> Show ended</label>
      </div>
      <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs"><tr>
            <th className="text-left px-3 py-2">Room</th><th className="text-left px-3 py-2">Client</th>
            <th className="text-left px-3 py-2">Rate/wk</th><th className="text-left px-3 py-2">Billing</th>
            <th className="text-left px-3 py-2">Next bill</th><th className="text-left px-3 py-2">Review</th>
            <th className="text-left px-3 py-2">T&Cs</th><th className="text-left px-3 py-2">Status</th>
          </tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} onClick={() => setDetailId(t.id)} className="border-t hover:bg-slate-50 cursor-pointer">
                <td className="px-3 py-2 font-medium">{t.room_name}</td>
                <td className="px-3 py-2">{t.organisation_name || t.lead_contact_name || '—'}</td>
                <td className="px-3 py-2">{money(t.weekly_rate)}</td>
                <td className="px-3 py-2 capitalize">{t.billing_mode === 'recurring' ? 'Recurring' : t.billing_cadence}</td>
                <td className="px-3 py-2">{t.billing_mode === 'manual' ? fmtDate(t.next_bill_date) : '—'}</td>
                <td className="px-3 py-2">{fmtDate(t.next_rate_review_date)}</td>
                <td className="px-3 py-2">{t.tcs_accepted_at ? '✓' : <span className="text-amber-600">—</span>}</td>
                <td className="px-3 py-2 capitalize">{t.status}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">No tenancies.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="mt-4">
        <button onClick={() => setCreating(true)} className="bg-[#7B5EA7] text-white px-4 py-2 rounded-lg text-sm font-medium">+ Move In Client</button>
      </div>
      {creating && <MoveInModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); onChange(); }} />}
      {detailId && <TenancyDetailModal id={detailId} isAdminManager={isAdminManager} onClose={() => setDetailId(null)} onChange={() => { load(); onChange(); }} onMovedOut={(size) => setVacancySize(size)} />}
      {vacancySize && <VacancyMatchModal size={vacancySize} onClose={() => setVacancySize(null)} />}
    </div>
  );
}

function MoveInModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [f, setF] = useState({ room_id: '', organisation_id: null as string | null, org_name: '', lead_contact_person_id: null as string | null, contact_name: '', weekly_rate: '', access_type: 'door_code', access_code: '', key_location: '', billing_mode: 'manual', billing_cadence: 'monthly', next_bill_date: '', next_rate_review_date: '', move_in_date: new Date().toISOString().slice(0, 10), notes: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.get<{ data: Room[] }>('/storage/rooms?status=available').then((r) => setRooms(r.data)); }, []);
  function pickRoom(roomId: string) {
    const room = rooms.find((r) => r.id === roomId);
    // Prefill the rate from the room's default if the user hasn't typed one yet
    setF((cur) => ({ ...cur, room_id: roomId, weekly_rate: cur.weekly_rate || (room?.default_weekly_rate != null ? String(room.default_weekly_rate) : '') }));
  }
  async function save() {
    if (!f.room_id) { setErr('Pick a room'); return; }
    setSaving(true); setErr('');
    try {
      await api.post('/storage/tenancies', {
        room_id: f.room_id, organisation_id: f.organisation_id, lead_contact_person_id: f.lead_contact_person_id,
        weekly_rate: Number(f.weekly_rate) || 0, access_type: f.access_type, access_code: f.access_code || null, key_location: f.key_location || null,
        billing_mode: f.billing_mode, billing_cadence: f.billing_cadence,
        next_bill_date: f.next_bill_date || null, next_rate_review_date: f.next_rate_review_date || null,
        move_in_date: f.move_in_date || null, notes: f.notes || null,
      });
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed'); } finally { setSaving(false); }
  }
  return (
    <Modal title="Move In Client" onClose={onClose}>
      <div className="space-y-3">
        <div><label className="block text-xs text-slate-500 mb-1">Room (available)</label>
          <select className={inputCls} value={f.room_id} onChange={(e) => pickRoom(e.target.value)}>
            <option value="">Select a room…</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.size_category}){r.default_weekly_rate != null ? ` · ${money(r.default_weekly_rate)}/wk` : ''}</option>)}
          </select></div>
        <EntitySearch kind="organisations" label="Client organisation" value={f.org_name} onPick={(id, name) => setF({ ...f, organisation_id: id, org_name: name, lead_contact_person_id: null, contact_name: '' })} />
        <ContactPicker orgId={f.organisation_id} value={f.contact_name} onPick={(id, name) => setF({ ...f, lead_contact_person_id: id, contact_name: name })} />
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-xs text-slate-500 mb-1">Weekly rate £</label><input className={inputCls} type="number" value={f.weekly_rate} onChange={(e) => setF({ ...f, weekly_rate: e.target.value })} /></div>
          <div><label className="block text-xs text-slate-500 mb-1">Move-in date</label><input className={inputCls} type="date" value={f.move_in_date} onChange={(e) => setF({ ...f, move_in_date: e.target.value })} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-xs text-slate-500 mb-1">Access</label>
            <select className={inputCls} value={f.access_type} onChange={(e) => setF({ ...f, access_type: e.target.value })}>
              <option value="door_code">Door code</option><option value="we_hold_key">We hold a key</option><option value="client_key">Client key / padlock</option>
            </select></div>
          {f.access_type === 'door_code' && <div><label className="block text-xs text-slate-500 mb-1">Door code</label><input className={inputCls} value={f.access_code} onChange={(e) => setF({ ...f, access_code: e.target.value })} /></div>}
          {f.access_type === 'we_hold_key' && <div><label className="block text-xs text-slate-500 mb-1">Key location</label><input className={inputCls} value={f.key_location} onChange={(e) => setF({ ...f, key_location: e.target.value })} /></div>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-xs text-slate-500 mb-1">Billing</label>
            <select className={inputCls} value={f.billing_mode} onChange={(e) => setF({ ...f, billing_mode: e.target.value })}>
              <option value="manual">We invoice</option><option value="recurring">Recurring (Xero)</option>
            </select></div>
          {f.billing_mode === 'manual' && <div><label className="block text-xs text-slate-500 mb-1">Cadence</label>
            <select className={inputCls} value={f.billing_cadence} onChange={(e) => setF({ ...f, billing_cadence: e.target.value })}>
              <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option><option value="custom">Custom</option>
            </select></div>}
        </div>
        {f.billing_mode === 'manual' && <div><label className="block text-xs text-slate-500 mb-1">Next invoice due</label><input className={inputCls} type="date" value={f.next_bill_date} onChange={(e) => setF({ ...f, next_bill_date: e.target.value })} /></div>}
        <div><label className="block text-xs text-slate-500 mb-1">Next rate review</label><input className={inputCls} type="date" value={f.next_rate_review_date} onChange={(e) => setF({ ...f, next_rate_review_date: e.target.value })} /></div>
        {err && <p className="text-red-600 text-sm">{err}</p>}
        <div className="flex justify-end gap-2"><button onClick={onClose} className="px-4 py-2 text-sm text-slate-600">Cancel</button><button onClick={save} disabled={saving} className="px-4 py-2 text-sm bg-[#7B5EA7] text-white rounded-lg disabled:opacity-50">{saving ? 'Saving…' : 'Move in'}</button></div>
      </div>
    </Modal>
  );
}

// Full edit of a tenancy's mutable fields (everything except weekly rate, which
// goes through Change rate so it keeps history, and the room, which is fixed for
// the life of the tenancy — a room change is a move-out + move-in).
function EditTenancyForm({ t, onCancel, onSaved }: { t: Tenancy; onCancel: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    organisation_id: t.organisation_id, org_name: t.organisation_name || '',
    lead_contact_person_id: t.lead_contact_person_id, contact_name: t.lead_contact_name || '',
    access_type: t.access_type || 'door_code', access_code: t.access_code || '', key_location: t.key_location || '',
    billing_mode: t.billing_mode, billing_cadence: t.billing_cadence,
    next_bill_date: (t.next_bill_date || '').slice(0, 10),
    next_rate_review_date: (t.next_rate_review_date || '').slice(0, 10),
    move_in_date: (t.move_in_date || '').slice(0, 10),
    status: t.status, notes: t.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    setSaving(true); setErr('');
    try {
      await api.put(`/storage/tenancies/${t.id}`, {
        organisation_id: f.organisation_id, lead_contact_person_id: f.lead_contact_person_id,
        status: f.status, move_in_date: f.move_in_date || null,
        access_type: f.access_type, access_code: f.access_code || null, key_location: f.key_location || null,
        billing_mode: f.billing_mode, billing_cadence: f.billing_cadence,
        next_bill_date: f.next_bill_date || null, next_rate_review_date: f.next_rate_review_date || null,
        notes: f.notes || null,
      });
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed'); } finally { setSaving(false); }
  }
  return (
    <div className="space-y-3">
      <EntitySearch kind="organisations" label="Client organisation" value={f.org_name}
        onPick={(id, name) => setF({ ...f, organisation_id: id, org_name: name, lead_contact_person_id: null, contact_name: '' })} />
      <ContactPicker orgId={f.organisation_id} value={f.contact_name}
        onPick={(id, name) => setF({ ...f, lead_contact_person_id: id, contact_name: name })} />
      <div className="grid grid-cols-2 gap-3">
        <div><label className="block text-xs text-slate-500 mb-1">Access</label>
          <select className={inputCls} value={f.access_type} onChange={(e) => setF({ ...f, access_type: e.target.value })}>
            <option value="door_code">Door code</option><option value="we_hold_key">We hold a key</option><option value="client_key">Client key / padlock</option>
          </select></div>
        {f.access_type === 'door_code' && <div><label className="block text-xs text-slate-500 mb-1">Door code</label><input className={inputCls} value={f.access_code} onChange={(e) => setF({ ...f, access_code: e.target.value })} /></div>}
        {f.access_type === 'we_hold_key' && <div><label className="block text-xs text-slate-500 mb-1">Key location</label><input className={inputCls} value={f.key_location} onChange={(e) => setF({ ...f, key_location: e.target.value })} /></div>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="block text-xs text-slate-500 mb-1">Billing</label>
          <select className={inputCls} value={f.billing_mode} onChange={(e) => setF({ ...f, billing_mode: e.target.value })}>
            <option value="manual">We invoice</option><option value="recurring">Recurring (Xero)</option>
          </select></div>
        {f.billing_mode === 'manual' && <div><label className="block text-xs text-slate-500 mb-1">Cadence</label>
          <select className={inputCls} value={f.billing_cadence} onChange={(e) => setF({ ...f, billing_cadence: e.target.value })}>
            <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option><option value="custom">Custom</option>
          </select></div>}
      </div>
      {f.billing_mode === 'manual' && <div><label className="block text-xs text-slate-500 mb-1">Next invoice due</label><input className={inputCls} type="date" value={f.next_bill_date} onChange={(e) => setF({ ...f, next_bill_date: e.target.value })} /></div>}
      <div className="grid grid-cols-2 gap-3">
        <div><label className="block text-xs text-slate-500 mb-1">Next rate review</label><input className={inputCls} type="date" value={f.next_rate_review_date} onChange={(e) => setF({ ...f, next_rate_review_date: e.target.value })} /></div>
        <div><label className="block text-xs text-slate-500 mb-1">Move-in date</label><input className={inputCls} type="date" value={f.move_in_date} onChange={(e) => setF({ ...f, move_in_date: e.target.value })} /></div>
      </div>
      <div><label className="block text-xs text-slate-500 mb-1">Status</label>
        <select className={inputCls} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="reserved">Reserved</option><option value="active">Active</option><option value="notice">Notice</option>
        </select></div>
      <div><label className="block text-xs text-slate-500 mb-1">Notes</label><textarea className={inputCls} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
      {err && <p className="text-red-600 text-sm">{err}</p>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-400">Weekly rate is changed via “Change rate” (keeps history).</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-slate-600">Cancel</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm bg-[#7B5EA7] text-white rounded-lg disabled:opacity-50">{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      </div>
    </div>
  );
}

function TenancyDetailModal({ id, isAdminManager, onClose, onChange, onMovedOut }: { id: string; isAdminManager: boolean; onClose: () => void; onChange: () => void; onMovedOut?: (size: string) => void }) {
  const [t, setT] = useState<Tenancy | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState(false);
  const load = useCallback(async () => { setT((await api.get<{ data: Tenancy }>(`/storage/tenancies/${id}`)).data); }, [id]);
  useEffect(() => { load(); }, [load]);

  async function action(label: string, fn: () => Promise<void>) {
    setBusy(label); setMsg('');
    try { await fn(); await load(); onChange(); } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(''); }
  }
  if (!t) return <Modal title="Tenancy" onClose={onClose}><p className="text-slate-400">Loading…</p></Modal>;

  if (editing) {
    return (
      <Modal title={`Edit — ${t.room_name}`} onClose={() => setEditing(false)}>
        <EditTenancyForm t={t} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); load(); onChange(); }} />
      </Modal>
    );
  }

  return (
    <Modal title={`${t.room_name} — ${t.organisation_name || t.lead_contact_name || 'Tenancy'}`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Weekly rate" value={money(t.weekly_rate)} />
          <Field label="Status" value={t.status} />
          <Field label="Billing" value={t.billing_mode === 'recurring' ? 'Recurring (Xero)' : `We invoice (${t.billing_cadence})`} />
          {t.billing_mode === 'manual' && <Field label="Next invoice due" value={fmtDate(t.next_bill_date)} />}
          <Field label="Next rate review" value={fmtDate(t.next_rate_review_date)} />
          <Field label="T&Cs" value={t.tcs_accepted_at ? `Accepted ${fmtDate(t.tcs_accepted_at)}` : 'Not accepted'} />
          <Field label="Access" value={
            t.access_type === 'door_code' ? `Door code: ${t.access_code || '— not set'}`
            : t.access_type === 'we_hold_key' ? `We hold a key${t.key_location ? ` · ${t.key_location}` : ''}`
            : t.access_type === 'client_key' ? 'Client key / padlock'
            : '—'
          } />
        </div>

        {msg && <p className="text-red-600">{msg}</p>}

        <div className="flex flex-wrap gap-2">
          {t.billing_mode === 'manual' && t.status !== 'ended' && (
            <button disabled={!!busy} onClick={() => action('invoiced', async () => { await api.post(`/storage/tenancies/${id}/mark-invoiced`, {}); })}
              className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs">✓ Mark invoice sent</button>
          )}
          {!t.tcs_accepted_at && t.status !== 'ended' && (
            <button disabled={!!busy} onClick={() => action('tcs', async () => { await api.post(`/storage/tenancies/${id}/send-tcs`, {}); setMsg('T&Cs link sent.'); })}
              className="px-3 py-1.5 bg-slate-700 text-white rounded-lg text-xs">✉ Send T&Cs</button>
          )}
          {t.status !== 'ended' && (
            <button disabled={!!busy} onClick={() => setEditing(true)}
              className="px-3 py-1.5 bg-[#7B5EA7] text-white rounded-lg text-xs">✏️ Edit details</button>
          )}
          {isAdminManager && t.status !== 'ended' && <RateButton id={id} current={t.weekly_rate} onDone={() => { load(); onChange(); }} />}
          {t.status !== 'ended' && (
            <button disabled={!!busy} onClick={() => { if (confirm('Move this client out? The tenancy will be ended and the room freed.')) action('moveout', async () => { await api.post(`/storage/tenancies/${id}/move-out`, {}); onClose(); onMovedOut?.(t.size_category); }); }}
              className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs">Move out</button>
          )}
        </div>

        {/* Access list */}
        <div>
          <h4 className="font-medium text-slate-700 mb-1">Allowed access</h4>
          {(t.access_list || []).length === 0 && <p className="text-slate-400 text-xs mb-1">No one added yet.</p>}
          {(t.access_list || []).map((a) => (
            <div key={a.id} className="flex items-center justify-between text-xs py-1 border-b last:border-0">
              <span>{a.person_name || a.name}{a.relationship ? ` · ${a.relationship}` : ''}{a.phone ? ` · ${a.phone}` : ''}</span>
              <button onClick={() => action('del', async () => { await api.delete(`/storage/access-list/${a.id}`); })} className="text-red-500">remove</button>
            </div>
          ))}
          <AddAccessPerson tenancyId={id} onAdded={() => load()} />
        </div>

        {/* Packages held for this storage client (Stage 9 cross-link) */}
        {t.organisation_id && (
          <HeldItemsSection entityType="organisation" entityId={t.organisation_id}
            heading="Packages held" openOnly hideWhenEmpty bare />
        )}

        {/* Rate history */}
        {(t.rate_history || []).length > 0 && (
          <div>
            <h4 className="font-medium text-slate-700 mb-1">Rate history</h4>
            {(t.rate_history || []).map((h) => (
              <p key={h.id} className="text-xs text-slate-500">{fmtDate(h.effective_date)}: {h.old_rate != null ? `${money(h.old_rate)} → ` : ''}{money(h.new_rate)}{h.notes ? ` (${h.notes})` : ''}</p>
            ))}
          </div>
        )}
        {/* Invoice log */}
        {(t.invoices || []).length > 0 && (
          <div>
            <h4 className="font-medium text-slate-700 mb-1">Invoices sent</h4>
            {(t.invoices || []).map((iv) => (
              <p key={iv.id} className="text-xs text-slate-500">{fmtDate(iv.sent_at)} — {money(iv.amount)} (cycle {fmtDate(iv.due_date)})</p>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs text-slate-400">{label}</p><p className="text-slate-800 capitalize">{value}</p></div>;
}

function RateButton({ id, current, onDone }: { id: string; current: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [rate, setRate] = useState(String(current));
  const [review, setReview] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  if (!open) return <button onClick={() => setOpen(true)} className="px-3 py-1.5 bg-[#7B5EA7] text-white rounded-lg text-xs">Change rate</button>;
  return (
    <div className="w-full border border-slate-200 rounded-lg p-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <input className={inputCls} type="number" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="New weekly rate" />
        <input className={inputCls} type="date" value={review} onChange={(e) => setReview(e.target.value)} title="Next review date" />
      </div>
      <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (e.g. annual review)" />
      <div className="flex gap-2 justify-end">
        <button onClick={() => setOpen(false)} className="text-xs text-slate-500">Cancel</button>
        <button disabled={saving} onClick={async () => { setSaving(true); try { await api.post(`/storage/tenancies/${id}/rate`, { new_rate: Number(rate), next_rate_review_date: review || null, notes: notes || null }); setOpen(false); onDone(); } finally { setSaving(false); } }}
          className="text-xs bg-[#7B5EA7] text-white px-3 py-1.5 rounded-lg">Save rate</button>
      </div>
    </div>
  );
}

function AddAccessPerson({ tenancyId, onAdded }: { tenancyId: string; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [rel, setRel] = useState('');
  const [phone, setPhone] = useState('');
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      <input className="border border-slate-300 rounded px-2 py-1 text-xs" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="border border-slate-300 rounded px-2 py-1 text-xs" placeholder="Relationship" value={rel} onChange={(e) => setRel(e.target.value)} />
      <input className="border border-slate-300 rounded px-2 py-1 text-xs" placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <button disabled={!name.trim()} onClick={async () => { await api.post(`/storage/tenancies/${tenancyId}/access-list`, { name, relationship: rel || null, phone: phone || null }); setName(''); setRel(''); setPhone(''); onAdded(); }}
        className="text-xs bg-slate-700 text-white px-3 py-1 rounded disabled:opacity-40">Add</button>
    </div>
  );
}

// ════════════════════════ WAITING LIST TAB ════════════════════════
function WaitingTab({ onChange }: { onChange: () => void }) {
  const [rows, setRows] = useState<Waiting[]>([]);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => { setRows((await api.get<{ data: Waiting[] }>('/storage/waiting-list')).data); }, []);
  useEffect(() => { load(); }, [load]);
  async function patch(id: string, body: Record<string, unknown>) { await api.patch(`/storage/waiting-list/${id}`, body); load(); onChange(); }
  return (
    <div>
      <button onClick={() => setAdding(true)} className="mb-4 bg-[#7B5EA7] text-white px-4 py-2 rounded-lg text-sm font-medium">+ Add to Waiting List</button>
      <div className="space-y-2">
        {rows.map((w) => (
          <div key={w.id} className="border border-slate-200 rounded-lg p-3 bg-white flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium text-slate-800">{w.organisation_name || w.person_name || w.contact_name || 'Unnamed'}</p>
              <p className="text-xs text-slate-500">Wants: {w.preferred_size || 'any'} · asked {fmtDate(w.date_requested)}{w.date_last_offered ? ` · last offered ${fmtDate(w.date_last_offered)}` : ''}{w.contact_email ? ` · ${w.contact_email}` : ''}</p>
              {w.notes && <p className="text-xs text-slate-400">{w.notes}</p>}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs px-2 py-0.5 rounded bg-slate-100 capitalize">{w.status}</span>
              {w.status === 'waiting' && <button onClick={() => patch(w.id, { mark_offered: true })} className="text-xs text-[#7B5EA7]">Mark offered</button>}
              {w.status !== 'converted' && w.status !== 'withdrawn' && <button onClick={() => patch(w.id, { status: 'converted' })} className="text-xs text-green-600">Converted</button>}
              {w.status !== 'withdrawn' && <button onClick={() => patch(w.id, { status: 'withdrawn' })} className="text-xs text-red-500">Remove</button>}
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="text-slate-400 text-sm">Waiting list is empty.</p>}
      </div>
      {adding && <WaitingModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); onChange(); }} />}
    </div>
  );
}

function WaitingModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ organisation_id: null as string | null, org_name: '', contact_name: '', contact_email: '', contact_phone: '', preferred_size: 'any', notes: '' });
  const [saving, setSaving] = useState(false);
  return (
    <Modal title="Add to Waiting List" onClose={onClose}>
      <div className="space-y-3">
        <EntitySearch kind="organisations" label="Organisation (optional)" value={f.org_name} onPick={(id, name) => setF({ ...f, organisation_id: id, org_name: name })} />
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-xs text-slate-500 mb-1">Contact name</label><input className={inputCls} value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} /></div>
          <div><label className="block text-xs text-slate-500 mb-1">Preferred size</label>
            <select className={inputCls} value={f.preferred_size} onChange={(e) => setF({ ...f, preferred_size: e.target.value })}>
              <option value="any">Any</option><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option><option value="xl">XL</option>
            </select></div>
          <div><label className="block text-xs text-slate-500 mb-1">Email</label><input className={inputCls} value={f.contact_email} onChange={(e) => setF({ ...f, contact_email: e.target.value })} /></div>
          <div><label className="block text-xs text-slate-500 mb-1">Phone</label><input className={inputCls} value={f.contact_phone} onChange={(e) => setF({ ...f, contact_phone: e.target.value })} /></div>
        </div>
        <div><label className="block text-xs text-slate-500 mb-1">Notes</label><textarea className={inputCls} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        <div className="flex justify-end gap-2"><button onClick={onClose} className="px-4 py-2 text-sm text-slate-600">Cancel</button>
          <button disabled={saving} onClick={async () => { setSaving(true); try { await api.post('/storage/waiting-list', { organisation_id: f.organisation_id, contact_name: f.contact_name || null, contact_email: f.contact_email || null, contact_phone: f.contact_phone || null, preferred_size: f.preferred_size, notes: f.notes || null }); onSaved(); } finally { setSaving(false); } }}
            className="px-4 py-2 text-sm bg-[#7B5EA7] text-white rounded-lg disabled:opacity-50">Add</button></div>
      </div>
    </Modal>
  );
}

// Vacancy matching — waiting-list clients who fit a freed/available room's size.
function VacancyMatchModal({ size, onClose }: { size: string; onClose: () => void }) {
  const [matches, setMatches] = useState<Waiting[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try { setMatches((await api.get<{ data: Waiting[] }>(`/storage/waiting-list/matches?size=${encodeURIComponent(size)}`)).data); }
    finally { setLoading(false); }
  }, [size]);
  useEffect(() => { load(); }, [load]);
  return (
    <Modal title={`Waiting list — fits a ${size} room`} onClose={onClose}>
      {loading ? <p className="text-slate-400 text-sm">Loading…</p> : matches.length === 0 ? (
        <p className="text-slate-500 text-sm">No one on the waiting list matches this size right now.</p>
      ) : (
        <div className="space-y-2">
          {matches.map((w) => (
            <div key={w.id} className="border border-slate-200 rounded-lg p-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium text-slate-800">{w.organisation_name || w.person_name || w.contact_name || 'Unnamed'}</p>
                <p className="text-xs text-slate-500">Wants {w.preferred_size || 'any'} · asked {fmtDate(w.date_requested)}{w.date_last_offered ? ` · last offered ${fmtDate(w.date_last_offered)}` : ''}{w.contact_email ? ` · ${w.contact_email}` : ''}</p>
              </div>
              <button onClick={async () => { await api.patch(`/storage/waiting-list/${w.id}`, { mark_offered: true }); load(); }}
                className="text-xs bg-[#7B5EA7] text-white px-3 py-1.5 rounded-lg">Mark offered</button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ════════════════════════ ACCESS TAB ════════════════════════
function AccessTab({ onChange }: { onChange: () => void }) {
  const [rows, setRows] = useState<AccessEvent[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => { setRows((await api.get<{ data: AccessEvent[] }>(`/storage/access-events${showDone ? '' : '?status=open'}`)).data); }, [showDone]);
  useEffect(() => { load(); }, [load]);
  async function setStatus(id: string, status: string) { await api.patch(`/storage/access-events/${id}`, { status }); load(); onChange(); }
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <button onClick={() => setAdding(true)} className="bg-[#7B5EA7] text-white px-4 py-2 rounded-lg text-sm font-medium">+ Log Access Request</button>
        <label className="text-sm text-slate-600 flex items-center gap-2"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done</label>
      </div>
      <div className="space-y-2">
        {rows.map((e) => (
          <div key={e.id} className="border border-slate-200 rounded-lg p-3 bg-white flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium text-slate-800">{e.room_name || 'Storage'} · {e.type.replace('_', ' ')}{e.method === 'courier' ? ' 🚚' : ''}</p>
              <p className="text-sm text-slate-600">{e.description}</p>
              <p className="text-xs text-slate-400">{e.attendee_person_name || e.attendee_name || ''}{e.requested_date ? ` · ${fmtDate(e.requested_date)}` : ''}{e.organisation_name ? ` · ${e.organisation_name}` : ''}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs px-2 py-0.5 rounded bg-slate-100 capitalize">{e.status}</span>
              {e.status !== 'done' && e.status !== 'cancelled' && <button onClick={() => setStatus(e.id, 'done')} className="text-xs bg-green-600 text-white px-3 py-1 rounded">✓ Done</button>}
              {e.status !== 'done' && e.status !== 'cancelled' && <button onClick={() => setStatus(e.id, 'cancelled')} className="text-xs text-red-500">Cancel</button>}
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="text-slate-400 text-sm">No access requests.</p>}
      </div>
      {adding && <AccessModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); onChange(); }} />}
    </div>
  );
}

interface StaffUser { id: string; first_name: string | null; last_name: string | null; role: string; is_active: boolean; }
function AccessModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const currentUserId = useAuthStore((s) => s.user?.id) || '';
  const [tenancies, setTenancies] = useState<Tenancy[]>([]);
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [f, setF] = useState({ tenancy_id: '', type: 'visit', description: '', attendee_name: '', method: 'in_person', requested_date: '', delivery_method: 'both', notes: '' });
  const [recipients, setRecipients] = useState<string[]>(currentUserId ? [currentUserId] : []);
  const [warn, setWarn] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get<{ data: Tenancy[] }>('/storage/tenancies?status=live').then((r) => setTenancies(r.data));
    api.get<{ data: StaffUser[] }>('/users').then((r) => setUsers(r.data.filter((u) => u.is_active && u.role !== 'freelancer'))).catch(() => {});
  }, []);
  const toggleRecipient = (id: string) => setRecipients((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  return (
    <Modal title="Log Access Request" onClose={onClose}>
      <div className="space-y-3">
        <div><label className="block text-xs text-slate-500 mb-1">Storage unit / tenancy</label>
          <select className={inputCls} value={f.tenancy_id} onChange={(e) => setF({ ...f, tenancy_id: e.target.value })}>
            <option value="">Select…</option>
            {tenancies.map((t) => <option key={t.id} value={t.id}>{t.room_name} — {t.organisation_name || t.lead_contact_name || ''}</option>)}
          </select></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-xs text-slate-500 mb-1">Type</label>
            <select className={inputCls} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="visit">Client visiting</option><option value="retrieve">Retrieve item</option><option value="courier_out">Courier out</option><option value="deposit">Deposit item</option>
            </select></div>
          <div><label className="block text-xs text-slate-500 mb-1">Method</label>
            <select className={inputCls} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
              <option value="in_person">In person</option><option value="courier">Courier</option>
            </select></div>
        </div>
        <div><label className="block text-xs text-slate-500 mb-1">What / details</label><input className={inputCls} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Get the '63 Strat out" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-xs text-slate-500 mb-1">Who's attending</label><input className={inputCls} value={f.attendee_name} onChange={(e) => setF({ ...f, attendee_name: e.target.value })} /></div>
          <div><label className="block text-xs text-slate-500 mb-1">When</label><input className={inputCls} type="date" value={f.requested_date} onChange={(e) => setF({ ...f, requested_date: e.target.value })} /></div>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Notify</label>
          <div className="flex flex-wrap gap-1.5 mb-2 max-h-28 overflow-y-auto border border-slate-200 rounded-lg p-2">
            {users.map((u) => {
              const on = recipients.includes(u.id);
              const name = `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'User';
              return (
                <button type="button" key={u.id} onClick={() => toggleRecipient(u.id)}
                  className={`text-xs px-2 py-1 rounded-full border ${on ? 'bg-[#7B5EA7] text-white border-[#7B5EA7]' : 'bg-white text-slate-600 border-slate-300'}`}>
                  {name}{on ? ' ✓' : ''}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500">Send via</label>
            <select className="border border-slate-300 rounded px-2 py-1 text-xs" value={f.delivery_method} onChange={(e) => setF({ ...f, delivery_method: e.target.value })}>
              <option value="both">Bell + email</option><option value="notification">Bell only</option><option value="email">Email only</option>
            </select>
            <span className="text-xs text-slate-400">{f.requested_date ? 'fires on the day' : 'fires now'}</span>
          </div>
        </div>
        {warn && <p className="text-amber-600 text-sm">⚠️ {warn}</p>}
        <div className="flex justify-end gap-2"><button onClick={onClose} className="px-4 py-2 text-sm text-slate-600">Cancel</button>
          <button disabled={saving} onClick={async () => {
            setSaving(true); setWarn('');
            try {
              const r = await api.post<{ not_on_access_list?: boolean }>('/storage/access-events', { tenancy_id: f.tenancy_id || null, type: f.type, description: f.description || null, attendee_name: f.attendee_name || null, method: f.method, requested_date: f.requested_date || null, notify_user_ids: recipients, delivery_method: f.delivery_method, notes: f.notes || null });
              if (r.not_on_access_list && f.attendee_name) { setWarn(`${f.attendee_name} isn't on the access list for this unit. Logged anyway.`); setTimeout(onSaved, 1800); }
              else onSaved();
            } finally { setSaving(false); }
          }} className="px-4 py-2 text-sm bg-[#7B5EA7] text-white rounded-lg disabled:opacity-50">Log request</button></div>
      </div>
    </Modal>
  );
}

// ════════════════════════ T&Cs TAB ════════════════════════
function TcsTab({ isAdminManager }: { isAdminManager: boolean }) {
  const [versions, setVersions] = useState<TcsVersion[]>([]);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => { setVersions((await api.get<{ data: TcsVersion[] }>('/storage/tcs-versions')).data); }, []);
  useEffect(() => { load(); }, [load]);
  if (!isAdminManager) return <p className="text-slate-500 text-sm">T&Cs management is restricted to admins and managers.</p>;
  return (
    <div>
      <button onClick={() => setAdding(true)} className="mb-4 bg-[#7B5EA7] text-white px-4 py-2 rounded-lg text-sm font-medium">+ New Version</button>
      <div className="space-y-2">
        {versions.map((v) => (
          <div key={v.id} className="border border-slate-200 rounded-lg p-3 bg-white">
            <div className="flex items-center justify-between">
              <span className="font-medium">Version {v.version} {v.is_current && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded ml-2">Current</span>}</span>
              <span className="text-xs text-slate-400">Effective {fmtDate(v.effective_date)}</span>
            </div>
          </div>
        ))}
        {versions.length === 0 && <p className="text-slate-400 text-sm">No T&Cs versions yet. Add one before sending to clients.</p>}
      </div>
      {adding && <TcsVersionModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
    </div>
  );
}

function TcsVersionModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [version, setVersion] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Modal title="New T&Cs Version" onClose={onClose}>
      <div className="space-y-3">
        <div><label className="block text-xs text-slate-500 mb-1">Version label</label><input className={inputCls} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. 1.0" /></div>
        <div><label className="block text-xs text-slate-500 mb-1">Terms (HTML allowed)</label><textarea className={inputCls} rows={12} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Paste or write the storage terms & conditions here…" /></div>
        {err && <p className="text-red-600 text-sm">{err}</p>}
        <div className="flex justify-end gap-2"><button onClick={onClose} className="px-4 py-2 text-sm text-slate-600">Cancel</button>
          <button disabled={saving} onClick={async () => { if (!version.trim() || !body.trim()) { setErr('Version and body required'); return; } setSaving(true); setErr(''); try { await api.post('/storage/tcs-versions', { version, body, make_current: true }); onSaved(); } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed'); } finally { setSaving(false); } }}
            className="px-4 py-2 text-sm bg-[#7B5EA7] text-white rounded-lg disabled:opacity-50">Save &amp; make current</button></div>
      </div>
    </Modal>
  );
}
