import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { displayFullName } from '../lib/displayName';
import CostCaptureModal from '../components/CostCaptureModal';
import type { Cost } from '../../../shared/types';

// ---------------------------------------------------------------------------
// ONE-OFF: link the freelancer invoices captured before Costs asked "Whose
// invoice?" (docs/FREELANCER-PORTAL-SPEC.md §5, jon, Oct 2026). Used once,
// then DELETED with its backend (routes/freelancer-invoice-backlog.ts), its
// route in App.tsx and the button on the Costs page.
//
// 1. Whose are these? Invoices since 6 April 2026 with no freelancer, grouped
//    by letterhead, each with a suggestion. One click links a whole group;
//    the choice is remembered for that letterhead's next invoice.
// 2. Unpaid: tick their work. Linked invoices not yet paid with no work
//    ticked, opened in the normal edit form.
// ---------------------------------------------------------------------------

interface BacklogInvoice { id: string; supplier_name: string | null; invoice_number: string | null; cost_date: string | null; amount_gross: string | number | null; payment_status: string }
interface BacklogGroup {
  key: string;
  names: string[];
  invoices: BacklogInvoice[];
  total: number;
  suggestion: { person: { id: string; name: string; email: string | null } | null; source: string };
}
interface ToTick extends BacklogInvoice { person_id: string; first_name: string; last_name: string; preferred_name: string | null }

const SOURCE: Record<string, string> = {
  remembered: 'same letterhead as an invoice already linked',
  remittance: 'a remittance for this letterhead went to them',
  name: 'matched by name',
};

const gbp = (n: number) => `£${n.toFixed(2)}`;
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return Number.isNaN(dt.getTime()) ? iso : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function PersonSearch({ onPick }: { onPick: (p: { id: string; name: string }) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ data: Array<{ id: string; first_name: string; last_name: string; preferred_name?: string | null }> }>(
          `/people?search=${encodeURIComponent(s)}&is_freelancer=true&limit=8`);
        if (!cancelled) setResults(r.data.map((p) => ({ id: p.id, name: displayFullName(p) })));
      } catch { if (!cancelled) setResults([]); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);
  return (
    <div className="relative w-64">
      <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder="Someone else? Search freelancers"
        className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500" />
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg">
          {results.map((p) => (
            <button key={p.id} type="button" onMouseDown={(e) => { e.preventDefault(); onPick(p); setQ(''); setResults([]); }}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-purple-50">{p.name}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LinkFreelancerInvoicesPage() {
  const [groups, setGroups] = useState<BacklogGroup[]>([]);
  const [toTick, setToTick] = useState<ToTick[]>([]);
  const [from, setFrom] = useState('2026-04-06');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, { id: string; name: string }>>({});
  const [editing, setEditing] = useState<Cost | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ data: { from: string; groups: BacklogGroup[]; toTick: ToTick[] } }>('/freelancer-invoice-backlog');
      setGroups(r.data.groups); setToTick(r.data.toTick); setFrom(r.data.from); setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the invoices');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function link(g: BacklogGroup, person: { id: string; name: string }) {
    setBusy(g.key); setError('');
    try {
      await api.post('/freelancer-invoice-backlog/link', { cost_ids: g.invoices.map((i) => i.id), person_id: person.id });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not link them');
    } finally { setBusy(null); }
  }

  async function openForTicking(id: string) {
    setBusy(id);
    try {
      const r = await api.get<{ data: Cost }>(`/costs/${id}`);
      setEditing(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the invoice');
    } finally { setBusy(null); }
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="mb-1 text-sm"><Link to="/money/costs" className="text-purple-700 hover:underline">Costs</Link></div>
      <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Link past freelancer invoices</h1>
      <p className="mt-1 text-sm text-gray-600 max-w-3xl">
        A one-off tidy-up for freelancer invoices captured since {fmtDate(from)}, before Costs asked whose they are.
        Link each letterhead to its freelancer once: their portal&apos;s Earnings page then shows those invoices as paid
        or waiting. New invoices are linked as they&apos;re uploaded, and this page goes once it&apos;s done.
      </p>

      {error && <div className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {loading && <p className="mt-6 text-sm text-gray-500">Loading…</p>}

      {!loading && (
        <>
          <h2 className="mt-6 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Whose are these? {groups.length > 0 && <span className="text-gray-400">({groups.length} letterhead{groups.length === 1 ? '' : 's'})</span>}
          </h2>
          {groups.length === 0 ? (
            <p className="mt-2 text-sm text-emerald-700">Every freelancer invoice since {fmtDate(from)} is linked to its freelancer.</p>
          ) : (
            <div className="mt-2 space-y-3">
              {groups.map((g) => {
                const choice = picked[g.key] || g.suggestion.person;
                return (
                  <div key={g.key} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900">{g.names.join(' / ') || '(no supplier name)'}</div>
                        <div className="text-xs text-gray-500">
                          {g.invoices.length} invoice{g.invoices.length === 1 ? '' : 's'} · {gbp(g.total)} ·{' '}
                          {g.invoices.map((i) => i.invoice_number ? `#${i.invoice_number}` : fmtDate(i.cost_date)).join(', ')}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {choice && (
                          <button onClick={() => void link(g, choice)} disabled={busy === g.key}
                            className="rounded-md bg-purple-600 px-3 py-1.5 text-sm text-white hover:bg-purple-700 disabled:opacity-50">
                            {busy === g.key ? 'Linking…' : `Link to ${choice.name}`}
                          </button>
                        )}
                        <PersonSearch onPick={(p) => setPicked((m) => ({ ...m, [g.key]: p }))} />
                      </div>
                    </div>
                    {choice && !picked[g.key] && g.suggestion.source !== 'none' && (
                      <p className="mt-1 text-xs text-gray-500">Suggested: {SOURCE[g.suggestion.source] || g.suggestion.source}. Check it&apos;s right.</p>
                    )}
                    {!choice && (
                      <p className="mt-1 text-xs text-gray-500">No match. Search for them, or leave it if it isn&apos;t a freelancer in OP.</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-gray-500">Unpaid: tick their work</h2>
          <p className="mt-1 text-sm text-gray-600">Linked and not paid yet, with none of their work ticked. Open each one and tick what it covers.</p>
          {toTick.length === 0 ? (
            <p className="mt-2 text-sm text-emerald-700">Nothing waiting.</p>
          ) : (
            <div className="mt-2 overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-100">
                  {toTick.map((c) => (
                    <tr key={c.id}>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmtDate(c.cost_date)}</td>
                      <td className="px-3 py-2">{displayFullName(c)}</td>
                      <td className="px-3 py-2 text-gray-600">{c.supplier_name}{c.invoice_number ? ` · #${c.invoice_number}` : ''}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{gbp(Number(c.amount_gross || 0))}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => void openForTicking(c.id)} disabled={busy === c.id}
                          className="rounded border border-purple-300 px-2.5 py-1 text-xs text-purple-700 hover:bg-purple-50 disabled:opacity-50">
                          {busy === c.id ? 'Opening…' : 'Tick their work'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {editing && (
        <CostCaptureModal existing={editing} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }} />
      )}
    </div>
  );
}
