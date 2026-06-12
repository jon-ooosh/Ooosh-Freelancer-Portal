/**
 * Human-gated lost-property chase queue (spec §7B). Lists items due a chase and
 * lets staff Send / Snooze / Skip each one - nothing is sent to clients
 * automatically; the daily scan only assembles this list + nudges staff here.
 *
 * Send → fires the gradient client email for the current tier + bumps the level.
 * Snooze → sets an expected collection date (pauses chases until it passes).
 * Skip → hides the row for this session (reappears tomorrow).
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../services/api';
import { locationLabel } from './format';
import type { HeldItem } from '../../../../shared/types';

const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB') : '—');
const tierLabel = (lvl: number) => (lvl <= 0 ? '1st chase' : lvl === 1 ? '2nd chase' : 'Final notice');

export function ChaseReviewPanel({ defaultOpen, onChanged }: { defaultOpen?: boolean; onChanged?: () => void }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [items, setItems] = useState<HeldItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [snoozeId, setSnoozeId] = useState<string | null>(null);
  const [snoozeDate, setSnoozeDate] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ data: HeldItem[] }>('/holding/chases/review');
      setItems(r.data);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const visible = items.filter((h) => !skipped.has(h.id));

  async function send(h: HeldItem) {
    setBusy(h.id); setMsg('');
    try {
      const r = await api.post<{ tier: number; notified_to: string }>(`/holding/${h.id}/chase`, {});
      setMsg(`Chase ${r.tier} sent to ${r.notified_to}.`);
      await load(); onChanged?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not send chase');
    } finally { setBusy(''); }
  }

  async function snooze(h: HeldItem) {
    if (!snoozeDate) return;
    setBusy(h.id); setMsg('');
    try {
      await api.put(`/holding/${h.id}`, { expected_collection_date: snoozeDate });
      setSnoozeId(null); setSnoozeDate('');
      await load(); onChanged?.();
    } finally { setBusy(''); }
  }

  // Hide entirely when there's nothing due (and not loading)
  if (!loading && items.length === 0) return null;

  return (
    <div className="mb-4 border border-amber-200 bg-amber-50/40 rounded-xl">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <span className="font-semibold text-amber-800">📨 Chases ready to review {visible.length > 0 && <span className="ml-1 text-xs bg-amber-200 text-amber-900 rounded-full px-2 py-0.5">{visible.length}</span>}</span>
        <span className="text-amber-700 text-sm">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          <p className="text-xs text-amber-700/80 mb-3">Nothing is sent to clients automatically - send each chase here when you're happy. Snooze if a client's already in touch with a collection date.</p>
          {msg && <p className="text-xs text-slate-700 bg-white border border-slate-200 rounded px-3 py-2 mb-2">{msg}</p>}
          {loading && <p className="text-sm text-slate-400">Loading…</p>}
          {!loading && visible.length === 0 && <p className="text-sm text-slate-500">All caught up — nothing left to chase.</p>}
          <div className="space-y-2">
            {visible.map((h) => {
              const client = h.owner_person_name || h.owner_organisation_name || h.client_name_text || 'Unknown';
              return (
                <div key={h.id} className="bg-white border border-slate-200 rounded-lg p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-800 text-sm">{h.description || 'Lost property'}
                        <span className="ml-2 text-[10px] bg-amber-100 text-amber-800 rounded px-1.5 py-0.5">{tierLabel(h.escalation_level)}</span></p>
                      <p className="text-xs text-slate-500">{client}{h.hh_job_number ? ` · #${h.hh_job_number}` : ''} · found {fmt(h.found_date)}
                        {locationLabel(h) ? ` · ${locationLabel(h)}` : ''}
                        {h.last_chased_at ? ` · last chased ${fmt(h.last_chased_at)}` : ' · not chased yet'}</p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button disabled={!!busy} onClick={() => send(h)} className="text-xs bg-amber-600 text-white px-3 py-1.5 rounded-lg disabled:opacity-50">Send chase →</button>
                      <button disabled={!!busy} onClick={() => { setSnoozeId(snoozeId === h.id ? null : h.id); setSnoozeDate(''); }} className="text-xs bg-white border border-slate-300 text-slate-600 px-2.5 py-1.5 rounded-lg">Snooze</button>
                      <button disabled={!!busy} onClick={() => setSkipped((s) => new Set(s).add(h.id))} className="text-xs text-slate-400 px-1.5 py-1.5">Skip</button>
                    </div>
                  </div>
                  {snoozeId === h.id && (
                    <div className="mt-2 flex items-center gap-2 border-t pt-2">
                      <label className="text-xs text-slate-500">Expected collection:</label>
                      <input type="date" className="border border-slate-300 rounded px-2 py-1 text-xs" value={snoozeDate} onChange={(e) => setSnoozeDate(e.target.value)} />
                      <button disabled={!snoozeDate || !!busy} onClick={() => snooze(h)} className="text-xs bg-[#7B5EA7] text-white px-3 py-1 rounded disabled:opacity-40">Pause chases until then</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
