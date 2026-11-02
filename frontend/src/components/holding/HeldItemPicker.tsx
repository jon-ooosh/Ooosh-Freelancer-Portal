/**
 * Shared "find an existing held item" picker + handover flow.
 *
 * The two things that physically happen in the warehouse — receiving a
 * delivery and handing one over — used to live ONLY on the mobile /quick page.
 * The desktop /holding page could create records and edit them, but had no way
 * to say "this is here now" or "this has gone", which is why backfilling a
 * missed delivery meant a detour via /quick.
 *
 * Both surfaces now render these components, so they can't drift (same
 * convention as HeldItemForm).
 */
import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { locationLabel } from './format';
import { describeHeldCounts } from './counts';
import type { HeldItem, HeldItemKind } from '../../../../shared/types';

const TERMINAL = ['collected', 'given_to_client', 'shipped_back', 'disposed', 'cancelled'];

/** Search + tap-to-pick list of open held items. */
export function HeldItemPicker({ kinds, placeholder, emptyHint, compact, onPick }: {
  kinds?: HeldItemKind[];          // restrict (e.g. deliveries only)
  placeholder?: string;
  emptyHint?: string;
  compact?: boolean;               // desktop modal sizing (default is big-touch)
  onPick: (item: HeldItem) => void;
}) {
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
        setItems(r.data.filter((i) => (!kinds || kinds.includes(i.kind)) && !TERMINAL.includes(i.status)));
      } finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, kinds?.join(',')]);

  const inputCls = compact
    ? 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm'
    : 'w-full border border-slate-300 rounded-xl px-4 py-3 text-base';

  return (
    <>
      <input autoFocus className={inputCls} value={q} onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder || 'Search by job #, client or description…'} />
      <div className="mt-3 space-y-2 max-h-[50vh] overflow-y-auto">
        {loading && <p className="text-slate-400 text-sm text-center py-3">Loading…</p>}
        {!loading && items.length === 0 && (
          <p className="text-slate-400 text-sm text-center py-3">{emptyHint || 'Nothing matching.'}</p>
        )}
        {items.map((h) => {
          const counts = describeHeldCounts(h);
          return (
            <button key={h.id} type="button" onClick={() => onPick(h)}
              className={`w-full text-left border border-slate-200 rounded-xl ${compact ? 'px-3 py-2' : 'px-4 py-3'} hover:bg-slate-50 active:bg-slate-100`}>
              <p className="font-medium text-slate-800 text-sm">
                {h.description || 'Item'}
                <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded capitalize ${h.status === 'expected' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-700'}`}>
                  {h.status.replace(/_/g, ' ')}
                </span>
              </p>
              <p className="text-xs text-slate-500">
                {h.owner_person_name || h.owner_organisation_name || h.client_name_text || (h.owner_unknown ? '❓ Unknown' : '—')}
                {h.hh_job_number ? ` · #${h.hh_job_number}` : ''}
                {counts ? ` · ${counts.text}` : ''}
                {locationLabel(h) ? ` · ${locationLabel(h)}` : ''}
              </p>
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * Pick an item → confirm who took it → POST /holding/:id/collected.
 * `incoming` reads as "Given to client", everything else as "Collected".
 */
export function HandoverFlow({ compact, onDone }: { compact?: boolean; onDone: (msg: string) => void }) {
  const [picked, setPicked] = useState<HeldItem | null>(null);
  const [who, setWho] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const inputCls = compact
    ? 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm'
    : 'w-full border border-slate-300 rounded-xl px-4 py-3 text-base';

  async function confirm() {
    if (!picked) return;
    setSaving(true); setErr('');
    try {
      await api.post(`/holding/${picked.id}/collected`, { collected_by: who || null });
      onDone(picked.kind === 'incoming' ? '✓ Given to client' : '✓ Marked collected');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
      setSaving(false);
    }
  }

  if (!picked) {
    return <HeldItemPicker compact={compact} onPick={setPicked}
      placeholder="Search by description / client / job #…" emptyHint="Nothing open to hand over." />;
  }

  const counts = describeHeldCounts(picked);
  return (
    <div className={compact ? 'space-y-3' : 'space-y-4 max-w-md mx-auto'}>
      <div className="bg-slate-50 rounded-xl p-4">
        <p className="font-semibold text-slate-800">{picked.description || 'Item'}</p>
        <p className="text-sm text-slate-500">
          {picked.owner_person_name || picked.owner_organisation_name || picked.client_name_text || 'Unknown owner'}
          {counts ? ` · ${counts.text}` : ''}{locationLabel(picked) ? ` · ${locationLabel(picked)}` : ''}
        </p>
        {counts && counts.outstanding > 0 && (
          <p className="text-xs text-amber-700 mt-1">
            {counts.outstanding} still outstanding — handing over closes this record.
          </p>
        )}
      </div>
      <div>
        <label className="block text-sm text-slate-500 mb-1">Collected / received by (optional)</label>
        <input autoFocus className={inputCls} value={who} onChange={(e) => setWho(e.target.value)} placeholder="Name" />
      </div>
      {err && <p className="text-red-600 text-sm">{err}</p>}
      <div className="flex gap-2">
        <button onClick={() => setPicked(null)} className="px-4 py-2 text-sm text-slate-600">← Back</button>
        <button onClick={confirm} disabled={saving}
          className={`flex-1 bg-green-600 text-white rounded-xl ${compact ? 'py-2 text-sm' : 'py-4 text-lg'} font-semibold disabled:opacity-50`}>
          {saving ? 'Saving…' : picked.kind === 'incoming' ? 'Given to client' : 'Mark collected'}
        </button>
      </div>
    </div>
  );
}
