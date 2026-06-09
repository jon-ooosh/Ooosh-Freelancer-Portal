/**
 * Quick Actions — mobile-first launcher for "grab a phone, done in 10 seconds".
 *
 * Mounted full-screen at /quick (staff JWT, no Layout chrome) so it can be
 * saved to a phone home screen. A registry of big touch tiles; the Holding
 * actions (package arrived / lost property / handover) capture inline, the
 * rest deep-link to existing flows. Capture is deliberately minimal — owner is
 * free-text or "unknown", proper linking happens later on the desktop pages.
 */
import { useEffect, useState, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { EntitySearch } from '../components/holding/EntitySearch';
import { NotifyClientModal } from '../components/holding/NotifyClientModal';
import type { HeldItem, HeldItemLocation } from '../../../shared/types';

const PURPLE = '#7B5EA7';
const inputCls = 'w-full border border-slate-300 rounded-xl px-4 py-3 text-base';

type Action = 'package' | 'lost' | 'handover';

export default function QuickActionsPage() {
  const navigate = useNavigate();
  const name = useAuthStore((s) => s.user)?.email || '';
  const [active, setActive] = useState<Action | null>(null);
  const [locations, setLocations] = useState<HeldItemLocation[]>([]);
  const [toast, setToast] = useState('');

  useEffect(() => { api.get<{ data: HeldItemLocation[] }>('/holding/locations').then((r) => setLocations(r.data)).catch(() => {}); }, []);

  function done(msg: string) { setActive(null); setToast(msg); setTimeout(() => setToast(''), 2500); }

  const tiles: { id: string; emoji: string; label: string; onClick: () => void; tone: string }[] = [
    { id: 'package', emoji: '📦', label: 'Package arrived', onClick: () => setActive('package'), tone: 'bg-[#7B5EA7]' },
    { id: 'lost', emoji: '🔍', label: 'Lost property', onClick: () => setActive('lost'), tone: 'bg-amber-600' },
    { id: 'handover', emoji: '✅', label: 'Handover / collected', onClick: () => setActive('handover'), tone: 'bg-green-600' },
    { id: 'receipt', emoji: '🧾', label: 'Upload receipt', onClick: () => navigate('/money/costs'), tone: 'bg-slate-700' },
    { id: 'checkin', emoji: '↩️', label: 'Check vehicle in', onClick: () => navigate('/vehicles/check-in'), tone: 'bg-blue-700' },
  ];

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <span className="text-xl">⚡</span>
          <h1 className="font-bold text-slate-800">Quick Log</h1>
        </div>
        <button onClick={() => navigate('/')} className="text-sm text-slate-500">← App</button>
      </header>

      {name && <p className="text-xs text-slate-400 px-4 pt-3">{name}</p>}

      <div className="p-4 grid grid-cols-2 gap-3">
        {tiles.map((t) => (
          <button key={t.id} onClick={t.onClick}
            className={`${t.tone} text-white rounded-2xl p-5 flex flex-col items-center justify-center gap-2 min-h-[120px] active:scale-95 transition-transform shadow`}>
            <span className="text-4xl">{t.emoji}</span>
            <span className="text-sm font-semibold text-center leading-tight">{t.label}</span>
          </button>
        ))}
      </div>

      <p className="text-center text-xs text-slate-400 px-6 mt-2">Tip: add this page to your home screen for one-tap access.</p>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm px-5 py-3 rounded-full shadow-lg z-50">{toast}</div>
      )}

      {active === 'package' && (
        <PackageArrivedSheet locations={locations} onClose={() => setActive(null)} onSaved={() => done('✓ Package logged')} />
      )}
      {active === 'lost' && (
        <QuickLogSheet kind="lost_property" locations={locations}
          onClose={() => setActive(null)} onSaved={() => done('✓ Lost property logged')} />
      )}
      {active === 'handover' && <HandoverSheet onClose={() => setActive(null)} onSaved={() => done('✓ Marked collected')} />}
    </div>
  );
}

// ── Full-screen sheet wrapper ───────────────────────────────────────────────
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 bg-white flex flex-col">
      <header className="border-b px-4 py-3 flex items-center justify-between">
        <button onClick={onClose} className="text-slate-500 text-sm">Cancel</button>
        <h2 className="font-semibold text-slate-800">{title}</h2>
        <span className="w-12" />
      </header>
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
    </div>
  );
}

async function uploadPhotos(files: FileList | null, onDone: (a: { name: string; url: string; type: string }[]) => void, onErr: (m: string) => void, setBusy: (b: boolean) => void) {
  if (!files || files.length === 0) return;
  setBusy(true);
  try {
    const out: { name: string; url: string; type: string }[] = [];
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('attachment_only', 'true');
      const token = useAuthStore.getState().accessToken;
      const res = await fetch('/api/files/upload', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd });
      if (!res.ok) throw new Error('Upload failed');
      const j = await res.json();
      out.push({ name: j.filename || file.name, url: j.r2_key, type: 'image' });
    }
    onDone(out);
  } catch (e) { onErr(e instanceof Error ? e.message : 'Upload failed'); } finally { setBusy(false); }
}

// ── Package arrived — search FIRST (receive an expected/known one), then create ──
// Collapses "is it already on the list?" and "log a new one" into one screen so
// staff don't flick between pages.
function PackageArrivedSheet({ locations, onClose, onSaved }: { locations: HeldItemLocation[]; onClose: () => void; onSaved: () => void }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'search' | 'create'>('search');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<HeldItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams();
        if (q.trim()) qs.set('search', q.trim());
        const r = await api.get<{ data: HeldItem[] }>(`/holding?${qs.toString()}`);
        setItems(r.data.filter((i) => i.kind === 'incoming' || i.kind === 'temp_storage'));
      } finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  if (mode === 'create') {
    // Reuse the create form; its Cancel returns to search rather than closing.
    return <QuickLogSheet kind="incoming" locations={locations} onClose={() => setMode('search')} onSaved={onSaved} />;
  }

  return (
    <Sheet title="📦 Package arrived" onClose={onClose}>
      <div className="max-w-md mx-auto">
        <p className="text-sm text-slate-500 mb-2">Is it already expected? Search by job #, client or description — tap to receive it. If it's not listed, log it as new.</p>
        <input autoFocus className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search expected deliveries…" />
        <div className="mt-3 space-y-2">
          {loading && <p className="text-slate-400 text-sm text-center py-3">Loading…</p>}
          {!loading && items.length === 0 && <p className="text-slate-400 text-sm text-center py-3">Nothing matching — log it as new below.</p>}
          {items.map((h) => (
            <button key={h.id} onClick={() => navigate(`/holding/receipt/${h.id}`)}
              className="w-full text-left border border-slate-200 rounded-xl px-4 py-3 active:bg-slate-50">
              <p className="font-medium text-slate-800">{h.description || 'Delivery'}
                <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded capitalize ${h.status === 'expected' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-700'}`}>{h.status.replace(/_/g, ' ')}</span></p>
              <p className="text-xs text-slate-500">
                {h.owner_person_name || h.owner_organisation_name || h.client_name_text || (h.owner_unknown ? '❓ Unknown' : '—')}
                {h.hh_job_number ? ` · #${h.hh_job_number}` : ''}{h.box_count ? ` · ${h.box_count} box(es)` : ''}
              </p>
            </button>
          ))}
        </div>
        <button onClick={() => setMode('create')}
          className="w-full mt-4 border-2 border-dashed border-slate-300 rounded-xl py-3 text-slate-600 font-medium">
          + Not listed — log a new package
        </button>
      </div>
    </Sheet>
  );
}

// ── Package arrived / Lost property ─────────────────────────────────────────
function QuickLogSheet({ kind, locations, onClose, onSaved }: { kind: 'incoming' | 'lost_property'; locations: HeldItemLocation[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    description: '', box_count: '', client_name_text: '',
    owner_organisation_id: null as string | null, org_name: '',
    owner_person_id: null as string | null, person_name: '',
    owner_unknown: false, hh_job_number: '',
    found_in: 'van', found_location_text: '', storage_location_id: '', storage_location_text: '', notes: '',
  });
  const [photos, setPhotos] = useState<{ name: string; url: string; type: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  // After saving lost property we offer to notify the client (§7 / §11).
  const [savedItem, setSavedItem] = useState<HeldItem | null>(null);
  const GIVEN = '__given__';
  const givenStraight = f.storage_location_id === GIVEN;
  const somewhereElse = locations.find((l) => l.id === f.storage_location_id)?.name === 'Somewhere else';

  async function save() {
    setSaving(true); setErr('');
    try {
      const r = await api.post<{ data: HeldItem }>('/holding', {
        kind,
        owner_unknown: f.owner_unknown,
        description: f.description || null,
        box_count: kind === 'incoming' && f.box_count ? Number(f.box_count) : null,
        owner_organisation_id: f.owner_unknown ? null : f.owner_organisation_id,
        owner_person_id: f.owner_unknown ? null : f.owner_person_id,
        client_name_text: f.owner_unknown ? null : (f.client_name_text || null),
        hh_job_number: f.hh_job_number ? Number(f.hh_job_number) : null,
        found_in: kind === 'lost_property' ? f.found_in : null,
        found_location_text: kind === 'lost_property' ? (f.found_location_text || null) : null,
        storage_location_id: givenStraight ? null : (f.storage_location_id || null),
        storage_location_text: somewhereElse ? (f.storage_location_text || null) : null,
        status: givenStraight ? 'given_to_client' : undefined,
        notes: f.notes || null,
        photos,
      });
      // Lost property (not given straight back) → offer to notify the client now.
      if (kind === 'lost_property' && !givenStraight && r.data) { setSavedItem(r.data); setSaving(false); return; }
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed'); } finally { setSaving(false); }
  }

  if (savedItem) {
    return (
      <NotifyClientModal item={savedItem}
        onClose={onSaved}
        onSent={() => onSaved()} />
    );
  }

  return (
    <Sheet title={kind === 'incoming' ? '📦 Package arrived' : '🔍 Lost property'} onClose={onClose}>
      <div className="space-y-4 max-w-md mx-auto">
        <div><label className="block text-sm text-slate-500 mb-1">What is it?</label>
          <input autoFocus className={inputCls} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })}
            placeholder={kind === 'incoming' ? 'e.g. 3 merch boxes' : 'e.g. black rucksack'} /></div>

        {kind === 'incoming' && (
          <div><label className="block text-sm text-slate-500 mb-1">How many boxes/items?</label>
            <input className={inputCls} type="number" inputMode="numeric" value={f.box_count} onChange={(e) => setF({ ...f, box_count: e.target.value })} /></div>
        )}

        {kind === 'lost_property' && (
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-sm text-slate-500 mb-1">Found in</label>
              <select className={inputCls} value={f.found_in} onChange={(e) => setF({ ...f, found_in: e.target.value })}>
                <option value="van">Van</option><option value="rehearsal">Rehearsal room</option><option value="backline">Backline</option><option value="elsewhere">Somewhere else</option>
              </select></div>
            {f.found_in === 'van' && <div><label className="block text-sm text-slate-500 mb-1">Van reg</label>
              <input className={inputCls} value={f.found_location_text} onChange={(e) => setF({ ...f, found_location_text: e.target.value.toUpperCase() })} placeholder="RX22SXL" /></div>}
          </div>
        )}

        {/* Owner — HireHop job # first; we derive the client from it */}
        <div className="border border-slate-200 rounded-xl p-3 space-y-3">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" className="w-5 h-5" checked={f.owner_unknown} onChange={(e) => setF({ ...f, owner_unknown: e.target.checked })} />
            Don't know whose it is (link later)
          </label>
          {!f.owner_unknown && (
            <>
              <div><label className="block text-sm text-slate-500 mb-1">HireHop job #</label>
                <input className={inputCls} type="number" inputMode="numeric" value={f.hh_job_number} onChange={(e) => setF({ ...f, hh_job_number: e.target.value })} placeholder="e.g. 15816" />
                <p className="text-[11px] text-slate-400 mt-1">Enter the job # and we link the job &amp; client for you. Only fill the boxes below if there's no job.</p>
              </div>
              <EntitySearch kind="organisations" label="Client / band" value={f.org_name} compact onPick={(id, name) => setF({ ...f, owner_organisation_id: id, org_name: name })} />
              <EntitySearch kind="people" label="Or a person" value={f.person_name} compact onPick={(id, name) => setF({ ...f, owner_person_id: id, person_name: name })} />
              <input className={inputCls} value={f.client_name_text} onChange={(e) => setF({ ...f, client_name_text: e.target.value })} placeholder="…or just a name (free text)" />
            </>
          )}
        </div>

        <div><label className="block text-sm text-slate-500 mb-1">Where are you putting it?</label>
          <select className={inputCls} value={f.storage_location_id} onChange={(e) => setF({ ...f, storage_location_id: e.target.value })}>
            <option value="">—</option>
            <option value={GIVEN}>✋ Given straight to client</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          {somewhereElse && <input className={`${inputCls} mt-2`} value={f.storage_location_text} onChange={(e) => setF({ ...f, storage_location_text: e.target.value })} placeholder="Where exactly?" />}
        </div>

        <div>
          <label className="block text-sm text-slate-500 mb-1">Photo</label>
          <div className="flex flex-wrap gap-2 mb-2">
            {photos.map((p, idx) => (
              <span key={idx} className="inline-flex items-center gap-1 text-xs bg-slate-100 rounded px-2 py-1">📷 {p.name}
                <button type="button" onClick={() => setPhotos((c) => c.filter((_, j) => j !== idx))} className="text-red-500">×</button></span>
            ))}
          </div>
          <label className="block w-full border-2 border-dashed border-slate-300 rounded-xl py-4 text-center text-slate-500 text-sm">
            📸 Take a photo
            <input type="file" accept="image/*" capture="environment" multiple className="hidden"
              onChange={(e) => uploadPhotos(e.target.files, (a) => setPhotos((p) => [...p, ...a]), setErr, setUploading)} />
          </label>
          {uploading && <p className="text-xs text-slate-400 mt-1">Uploading…</p>}
        </div>

        {err && <p className="text-red-600 text-sm">{err}</p>}
        <button onClick={save} disabled={saving || uploading} style={{ backgroundColor: PURPLE }}
          className="w-full text-white rounded-xl py-4 text-lg font-semibold disabled:opacity-50">{saving ? 'Saving…' : 'Log it'}</button>
      </div>
    </Sheet>
  );
}

// ── Handover / collected ────────────────────────────────────────────────────
function HandoverSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<HeldItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<HeldItem | null>(null);
  const [who, setWho] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams();
        if (q.trim()) qs.set('search', q.trim());
        const r = await api.get<{ data: HeldItem[] }>(`/holding?${qs.toString()}`);
        setItems(r.data);
      } finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  async function confirm() {
    if (!picked) return;
    setSaving(true);
    try { await api.post(`/holding/${picked.id}/collected`, { collected_by: who || null }); onSaved(); }
    finally { setSaving(false); }
  }

  if (picked) {
    return (
      <Sheet title="✅ Confirm handover" onClose={() => setPicked(null)}>
        <div className="space-y-4 max-w-md mx-auto">
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="font-semibold text-slate-800">{picked.description || 'Item'}</p>
            <p className="text-sm text-slate-500">{picked.owner_person_name || picked.owner_organisation_name || picked.client_name_text || 'Unknown owner'}
              {picked.storage_location_name ? ` · ${picked.storage_location_name}` : ''}</p>
          </div>
          <div><label className="block text-sm text-slate-500 mb-1">Collected / received by (optional)</label>
            <input autoFocus className={inputCls} value={who} onChange={(e) => setWho(e.target.value)} placeholder="Name" /></div>
          <button onClick={confirm} disabled={saving} className="w-full bg-green-600 text-white rounded-xl py-4 text-lg font-semibold disabled:opacity-50">
            {saving ? 'Saving…' : picked.kind === 'incoming' ? 'Given to client' : 'Mark collected'}</button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="✅ Handover / collected" onClose={onClose}>
      <div className="max-w-md mx-auto">
        <input autoFocus className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by description / client…" />
        <div className="mt-3 space-y-2">
          {loading && <p className="text-slate-400 text-sm text-center py-4">Loading…</p>}
          {!loading && items.length === 0 && <p className="text-slate-400 text-sm text-center py-4">Nothing open to hand over.</p>}
          {items.map((h) => (
            <button key={h.id} onClick={() => setPicked(h)}
              className="w-full text-left border border-slate-200 rounded-xl px-4 py-3 active:bg-slate-50">
              <p className="font-medium text-slate-800">{h.description || 'Item'}</p>
              <p className="text-xs text-slate-500">
                {h.owner_person_name || h.owner_organisation_name || h.client_name_text || (h.owner_unknown ? '❓ Unknown' : '—')}
                {h.storage_location_name ? ` · ${h.storage_location_name}` : ''}
                {h.hh_job_number ? ` · #${h.hh_job_number}` : ''}
              </p>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
