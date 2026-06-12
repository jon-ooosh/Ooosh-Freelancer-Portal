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
import { HeldItemForm } from '../components/holding/HeldItemForm';
import { locationLabel } from '../components/holding/format';
import type { HeldItem, HeldItemLocation } from '../../../shared/types';

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
    { id: 'receipt', emoji: '🧾', label: 'Upload receipt', onClick: () => navigate('/money/costs?capture=1'), tone: 'bg-slate-700' },
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
// Thin wrapper around the shared HeldItemForm (the desktop HoldingPage uses the
// same component) so the two capture flows stay in lockstep — same fields, same
// notify-at-create step.
function QuickLogSheet({ kind, locations, onClose, onSaved }: { kind: 'incoming' | 'lost_property'; locations: HeldItemLocation[]; onClose: () => void; onSaved: () => void }) {
  return (
    <Sheet title={kind === 'incoming' ? '📦 Package arrived' : '🔍 Lost property'} onClose={onClose}>
      <HeldItemForm variant="mobile" kinds={[kind]} locations={locations} onDone={onSaved} onCancel={onClose} />
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
              {locationLabel(picked) ? ` · ${locationLabel(picked)}` : ''}</p>
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
                {locationLabel(h) ? ` · ${locationLabel(h)}` : ''}
                {h.hh_job_number ? ` · #${h.hh_job_number}` : ''}
              </p>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
