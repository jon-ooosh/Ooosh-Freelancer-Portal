/**
 * Planned items — the ONE place for anything Xero doesn't schedule
 * (docs/CASHFLOW-FORECAST-SPEC.md §5.4): rent and direct debits, payroll, VAT,
 * tax, one-offs, and Xero bills being paid off in instalments.
 *
 * An item is either a repeating rule (£X every month from …) or a schedule — a
 * list of dated payments written out by the editor and then changed by hand,
 * checked against what Xero says the bill still owes.
 */
import { useEffect, useMemo, useState } from 'react';
import ModalShell from '../ModalShell';
import { api } from '../../services/api';
import { ukToday } from '../../lib/ukDate';
import type { Frequency, PlannedCategory, PlannedItem, RecurringSuggestion, XeroBillRow } from '../../lib/cashflow';
import { CATEGORY_LABELS, FREQUENCY_LABELS, gbp, ordinal, shortDate, writeOutSchedule } from '../../lib/cashflow';

interface Props {
  notes: Array<{ id: string; label: string; message: string }>;
  onClose: () => void;
  onChanged: () => void;
  /** Open straight into a new instalment plan for this bill (from the bills list). */
  startWithBill?: XeroBillRow | null;
}

interface Draft {
  id: string | null;
  label: string;
  category: PlannedCategory;
  kind: 'rule' | 'schedule';
  amount: string;
  frequency: Frequency;
  startDate: string;
  endDate: string;
  rows: Array<{ date: string; amount: string }>;
  expectedTotal: string;
  xeroContactId: string | null;
  xeroContactName: string | null;
  xeroBillId: string | null;
  xeroBillLabel: string | null;
  notes: string;
}

const blank = (): Draft => ({
  id: null, label: '', category: 'overheads', kind: 'rule', amount: '', frequency: 'monthly', startDate: '', endDate: '',
  rows: [], expectedTotal: '', xeroContactId: null, xeroContactName: null, xeroBillId: null, xeroBillLabel: null, notes: '',
});

const fromItem = (p: PlannedItem): Draft => ({
  id: p.id, label: p.label, category: p.category, kind: p.kind,
  amount: p.amount !== null ? String(p.amount) : '', frequency: p.frequency || 'monthly',
  startDate: p.startDate || '', endDate: p.endDate || '',
  rows: p.dates.map((d) => ({ date: d.date, amount: String(d.amount) })),
  expectedTotal: p.expectedTotal !== null ? String(p.expectedTotal) : '',
  xeroContactId: p.xeroContactId, xeroContactName: p.xeroContactName,
  xeroBillId: p.xeroBillId, xeroBillLabel: p.xeroBillLabel, notes: p.notes || '',
});

const billLabel = (b: XeroBillRow) => `${b.contactName}${b.number ? ` · ${b.number}` : ''} · ${gbp(b.amountDue, true)} owed`;
const money = (s: string) => {
  const n = Number(s.replace(/[£,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const inputCls = 'rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500';

function describe(p: PlannedItem): string {
  if (p.kind === 'rule') {
    const freq = p.frequency ? FREQUENCY_LABELS[p.frequency].toLowerCase() : '';
    return `${gbp(p.amount, true)} ${freq}${p.frequency === 'once' ? ` on ${shortDate(p.startDate)}` : ` from ${shortDate(p.startDate)}`}${p.endDate ? ` until ${shortDate(p.endDate)}` : ''}`;
  }
  const today = ukToday();
  const left = p.dates.filter((d) => d.date >= today);
  return `${p.dates.length} payments · ${left.length} still to come (${gbp(left.reduce((s, d) => s + d.amount, 0), true)})`;
}

export default function PlannedItemsModal({ notes, onClose, onChanged, startWithBill }: Props) {
  const [items, setItems] = useState<PlannedItem[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [changed, setChanged] = useState(false);
  const [bills, setBills] = useState<XeroBillRow[] | null>(null);
  const [billsError, setBillsError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[]>([]);
  const [contactSearch, setContactSearch] = useState('');
  const [contactResults, setContactResults] = useState<Array<{ id: string; name: string }>>([]);
  const [gen, setGen] = useState({ every: 'month' as 'week' | 'month', first: '', count: '10', amount: '' });

  const load = () => api.get<{ data: PlannedItem[] }>('/cashflow/planned')
    .then((r) => setItems(r.data))
    .catch((e: Error) => setError(e.message || 'Could not load planned items.'));

  useEffect(() => { load(); }, []);

  // Regular payments Xero has seen in the last 12 months (spec §13.3) — offered, never counted until added.
  const [suggestions, setSuggestions] = useState<RecurringSuggestion[] | null>(null);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [showAllSuggestions, setShowAllSuggestions] = useState(false);
  const loadSuggestions = () => api.get<{ data: { ok: boolean; reason?: string; suggestions: RecurringSuggestion[] } }>('/cashflow/xero/recurring')
    .then((r) => { setSuggestions(r.data.suggestions); setSuggestNote(r.data.ok ? null : r.data.reason || 'Xero could not be read.'); })
    .catch((e: Error) => { setSuggestions([]); setSuggestNote(e.message || 'Xero could not be read.'); });
  useEffect(() => { loadSuggestions(); }, []);

  const fromSuggestion = (sug: RecurringSuggestion) => {
    setDraft({
      ...blank(), label: sug.contactName, kind: 'rule', amount: String(sug.amount), frequency: sug.frequency,
      startDate: sug.nextDate, xeroContactId: sug.contactId, xeroContactName: sug.contactId ? sug.contactName : null,
      notes: `Suggested from Xero: paid ${sug.count} times in the last 12 months${sug.steady ? '' : ` (£${sug.range.min}–£${sug.range.max})`}.`,
    });
    setError(null);
  };

  const dismissSuggestion = async (sug: RecurringSuggestion) => {
    if (!sug.contactId) { setSuggestions((list) => (list || []).filter((x) => x.key !== sug.key)); return; }
    try {
      await api.post('/cashflow/xero/recurring/dismiss', { contactId: sug.contactId, contactName: sug.contactName });
      setSuggestions((list) => (list || []).filter((x) => x.key !== sug.key));
    } catch (e) {
      setError((e as Error).message || 'Could not save.');
    }
  };

  // Open straight into an instalment plan for a bill picked on the bills list.
  useEffect(() => {
    if (!startWithBill) return;
    setDraft({
      ...blank(), label: `${startWithBill.contactName} instalments`, category: 'instalments', kind: 'schedule',
      xeroBillId: startWithBill.id, xeroBillLabel: billLabel(startWithBill),
    });
  }, [startWithBill]);

  // Xero bills, for linking a schedule to the bill it pays off.
  useEffect(() => {
    if (!draft || draft.kind !== 'schedule' || bills !== null) return;
    api.get<{ data: { ok: boolean; reason?: string; bills: XeroBillRow[] } }>('/cashflow/xero/bills')
      .then((r) => { setBills(r.data.bills); if (!r.data.ok) setBillsError(r.data.reason || 'Xero could not be read.'); })
      .catch((e: Error) => { setBills([]); setBillsError(e.message); });
  }, [draft, bills]);

  // The next three dates of a repeating payment, so a mistyped day shows at once.
  const ruleKey = draft && draft.kind === 'rule' ? `${draft.frequency}|${draft.startDate}|${draft.endDate}` : '';
  useEffect(() => {
    if (!draft || draft.kind !== 'rule' || !/^\d{4}-\d{2}-\d{2}$/.test(draft.startDate)) { setPreview([]); return; }
    const t = setTimeout(() => {
      api.post<{ data: { dates: string[] } }>('/cashflow/planned/preview', {
        frequency: draft.frequency, startDate: draft.startDate, endDate: draft.endDate || null,
      }).then((r) => setPreview(r.data.dates)).catch(() => setPreview([]));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleKey]);

  // Supplier search, for "matches bills from".
  useEffect(() => {
    const q = contactSearch.trim();
    if (q.length < 2) { setContactResults([]); return; }
    const t = setTimeout(() => {
      api.get<{ data: Array<{ id: string; name: string }> }>(`/cashflow/xero/contacts?search=${encodeURIComponent(q)}`)
        .then((r) => setContactResults(r.data)).catch(() => setContactResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [contactSearch]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  const linkedBill = draft?.xeroBillId ? bills?.find((b) => b.id === draft.xeroBillId) || null : null;
  const check = useMemo(() => {
    if (!draft || draft.kind !== 'schedule') return null;
    const today = ukToday();
    const rows = draft.rows.map((r) => ({ date: r.date, amount: money(r.amount) }));
    const bad = rows.some((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !(r.amount > 0));
    const total = rows.reduce((s, r) => s + (r.amount > 0 ? r.amount : 0), 0);
    const toCome = rows.filter((r) => r.date >= today).reduce((s, r) => s + (r.amount > 0 ? r.amount : 0), 0);
    let against: { label: string; figure: number; compared: number } | null = null;
    if (linkedBill) against = { label: 'Xero says still owed', figure: linkedBill.amountDue, compared: toCome };
    else if (draft.expectedTotal && money(draft.expectedTotal) > 0) against = { label: 'expected', figure: money(draft.expectedTotal), compared: total };
    return { count: rows.length, total, toCome, bad, against };
  }, [draft, linkedBill]);

  const save = async () => {
    if (!draft) return;
    setError(null);
    if (!draft.label.trim()) { setError('Give it a name.'); return; }
    const body: Record<string, unknown> = {
      label: draft.label.trim(), category: draft.category, kind: draft.kind,
      xeroContactId: draft.xeroContactId, xeroContactName: draft.xeroContactName, notes: draft.notes.trim() || null,
    };
    if (draft.kind === 'rule') {
      const amount = money(draft.amount);
      if (!(amount > 0)) { setError('Type the amount.'); return; }
      if (!draft.startDate) { setError('Pick the first date.'); return; }
      Object.assign(body, { amount, frequency: draft.frequency, startDate: draft.startDate, endDate: draft.endDate || null });
    } else {
      const dates = draft.rows.map((r) => ({ date: r.date, amount: money(r.amount) }));
      if (dates.length === 0) { setError('Write out at least one payment.'); return; }
      if (dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !(d.amount > 0))) { setError('Every payment needs a date and an amount.'); return; }
      const expected = draft.expectedTotal ? money(draft.expectedTotal) : null;
      Object.assign(body, {
        dates: dates.sort((a, b) => a.date.localeCompare(b.date)),
        expectedTotal: expected && expected > 0 ? expected : null,
        xeroBillId: draft.xeroBillId, xeroBillLabel: draft.xeroBillLabel,
      });
    }
    setSaving(true);
    try {
      if (draft.id) await api.put(`/cashflow/planned/${draft.id}`, body);
      else await api.post('/cashflow/planned', body);
      setChanged(true);
      setDraft(null);
      await load();
      loadSuggestions();
    } catch (e) {
      setError((e as Error).message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.id || !window.confirm(`Delete "${draft.label}"? It comes out of the forecast.`)) return;
    setSaving(true);
    try {
      await api.delete(`/cashflow/planned/${draft.id}`);
      setChanged(true);
      setDraft(null);
      await load();
    } catch (e) {
      setError((e as Error).message || 'Could not delete.');
    } finally {
      setSaving(false);
    }
  };

  const close = () => { if (changed) onChanged(); onClose(); };

  // ── The list ─────────────────────────────────────────────────────────────
  if (!draft) {
    const grouped = (items || []).reduce<Record<string, PlannedItem[]>>((acc, p) => {
      (acc[p.category] ||= []).push(p);
      return acc;
    }, {});
    return (
      <ModalShell title="Planned items" subtitle="Payments Xero doesn't schedule — set once, counted every time." onClose={close} width="max-w-2xl">
        <div className="space-y-4">
          <div className="flex justify-end">
            <button type="button" onClick={() => { setDraft(blank()); setError(null); }}
              className="px-3 py-1.5 text-sm rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700">+ Add</button>
          </div>
          {(suggestNote || (suggestions && suggestions.length > 0)) && (
            <div className="rounded-lg border border-ooosh-200 bg-ooosh-50/40 p-3">
              <p className="text-sm font-semibold text-gray-900">Regular payments Xero has seen</p>
              <p className="text-xs text-gray-600 mb-2">Paid on a pattern over the last 12 months and not a planned item yet. Nothing here counts until you add it.</p>
              {suggestNote && <p className="text-xs text-amber-700">{suggestNote}</p>}
              <div className="divide-y divide-ooosh-100">
                {(suggestions || []).slice(0, showAllSuggestions ? undefined : 6).map((sug) => (
                  <div key={sug.key} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm text-gray-900">{sug.contactName}</p>
                      <p className="text-xs text-gray-600">
                        {sug.steady ? gbp(sug.amount, true) : `about ${gbp(sug.amount)} (varies ${gbp(sug.range.min)}–${gbp(sug.range.max)})`}
                        {sug.frequency === 'monthly' ? ` a month, around the ${ordinal(sug.day)}` : ' every 3 months'}
                        {` · paid ${sug.count}× · last ${shortDate(sug.lastDate)}`}
                      </p>
                      {sug.countedAs && (
                        <p className="text-[11px] text-gray-500">{sug.countedAs === 'card' ? 'Looks like a card repayment — already counted from the card settings.' : 'Looks like van HP — already counted from Fleet › Finance.'}</p>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {!sug.countedAs && <button type="button" onClick={() => fromSuggestion(sug)} className="text-xs px-2 py-1 rounded border border-ooosh-300 bg-white text-ooosh-700 hover:bg-ooosh-50">Add…</button>}
                      <button type="button" onClick={() => dismissSuggestion(sug)} className="text-xs px-2 py-1 rounded text-gray-500 hover:bg-gray-100">Not this one</button>
                    </div>
                  </div>
                ))}
              </div>
              {suggestions && suggestions.length > 6 && (
                <button type="button" onClick={() => setShowAllSuggestions((v) => !v)} className="text-xs text-ooosh-700 hover:underline mt-1">
                  {showAllSuggestions ? 'Show fewer' : `Show all ${suggestions.length}`}
                </button>
              )}
            </div>
          )}
          {items === null && !error && <p className="text-sm text-gray-500">Loading…</p>}
          {items && items.length === 0 && (
            <p className="text-sm text-gray-500">Nothing yet. Start with rent, payroll, PAYE and the next VAT bill.</p>
          )}
          {Object.entries(grouped).map(([cat, list]) => (
            <div key={cat}>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">{CATEGORY_LABELS[cat as PlannedCategory]}</p>
              <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                {list.map((p) => {
                  const note = notes.find((n) => n.id === p.id);
                  return (
                    <button key={p.id} type="button" onClick={() => { setDraft(fromItem(p)); setError(null); }}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-medium text-gray-900">{p.label}</span>
                        {p.xeroBillLabel && <span className="text-[11px] text-gray-500 truncate">pays off {p.xeroBillLabel}</span>}
                        {!p.xeroBillLabel && p.xeroContactName && <span className="text-[11px] text-gray-500 truncate">matches bills from {p.xeroContactName}</span>}
                      </div>
                      <p className="text-xs text-gray-600">{describe(p)}</p>
                      {note && <p className="text-xs text-amber-700 mt-0.5">⚠ {note.message}</p>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </ModalShell>
    );
  }

  // ── The editor ───────────────────────────────────────────────────────────
  return (
    <ModalShell title={draft.id ? 'Edit planned item' : 'New planned item'} onClose={() => setDraft(null)} width="max-w-2xl">
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Name</span>
            <input value={draft.label} onChange={(e) => set('label', e.target.value)} className={`${inputCls} w-full`} placeholder="e.g. Rent" />
          </label>
          <label className="text-sm">
            <span className="block text-gray-700 mb-1">What it is</span>
            <select value={draft.category} onChange={(e) => set('category', e.target.value as PlannedCategory)} className={`${inputCls} w-full`}>
              {(Object.keys(CATEGORY_LABELS) as PlannedCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
          </label>
        </div>

        <div className="inline-flex rounded-lg border border-gray-300 p-0.5 text-sm">
          {(['rule', 'schedule'] as const).map((k) => (
            <button key={k} type="button" onClick={() => set('kind', k)}
              className={`px-3 py-1.5 rounded-md ${draft.kind === k ? 'bg-ooosh-600 text-white' : 'text-gray-700 hover:bg-gray-50'}`}>
              {k === 'rule' ? 'Same amount, repeating' : 'A schedule of payments'}
            </button>
          ))}
        </div>

        {draft.kind === 'rule' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <label className="text-sm">
                <span className="block text-gray-700 mb-1">Amount (£)</span>
                <input inputMode="decimal" value={draft.amount} onChange={(e) => set('amount', e.target.value)} className={`${inputCls} w-full text-right`} />
              </label>
              <label className="text-sm">
                <span className="block text-gray-700 mb-1">How often</span>
                <select value={draft.frequency} onChange={(e) => set('frequency', e.target.value as Frequency)} className={`${inputCls} w-full`}>
                  {(Object.keys(FREQUENCY_LABELS) as Frequency[]).map((f) => <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>)}
                </select>
              </label>
              <label className="text-sm">
                <span className="block text-gray-700 mb-1">{draft.frequency === 'once' ? 'Date' : 'First payment'}</span>
                <input type="date" value={draft.startDate} onChange={(e) => set('startDate', e.target.value)} className={`${inputCls} w-full`} />
              </label>
              {draft.frequency !== 'once' && (
                <label className="text-sm">
                  <span className="block text-gray-700 mb-1">Last (optional)</span>
                  <input type="date" value={draft.endDate} onChange={(e) => set('endDate', e.target.value)} className={`${inputCls} w-full`} />
                </label>
              )}
            </div>
            {preview.length > 0 && (
              <p className="text-xs text-gray-600">Next: {preview.map((d) => shortDate(d, true)).join(' · ')}</p>
            )}
            {draft.frequency === 'monthly' && <p className="text-[11px] text-gray-500">The first payment's day of the month is the payment day — the 31st falls on the last day of a short month.</p>}
          </div>
        )}

        {draft.kind === 'schedule' && (
          <div className="space-y-3">
            <div className="rounded-lg bg-gray-50 border border-gray-200 p-3">
              <p className="text-xs font-semibold text-gray-700 mb-2">Write the payments out</p>
              <div className="flex flex-wrap items-end gap-2 text-sm">
                <select value={gen.every} onChange={(e) => setGen((g) => ({ ...g, every: e.target.value as 'week' | 'month' }))} className={inputCls}>
                  <option value="month">Monthly</option>
                  <option value="week">Weekly</option>
                </select>
                <label>
                  <span className="block text-[11px] text-gray-500">first payment</span>
                  <input type="date" value={gen.first} onChange={(e) => setGen((g) => ({ ...g, first: e.target.value }))} className={inputCls} />
                </label>
                <label>
                  <span className="block text-[11px] text-gray-500">how many</span>
                  <input inputMode="numeric" value={gen.count} onChange={(e) => setGen((g) => ({ ...g, count: e.target.value }))} className={`${inputCls} w-16 text-right`} />
                </label>
                <label>
                  <span className="block text-[11px] text-gray-500">each (£)</span>
                  <input inputMode="decimal" value={gen.amount} onChange={(e) => setGen((g) => ({ ...g, amount: e.target.value }))} className={`${inputCls} w-28 text-right`} />
                </label>
                <button type="button"
                  onClick={() => {
                    const rows = writeOutSchedule(gen.first, gen.every, parseInt(gen.count, 10) || 0, money(gen.amount) || 0);
                    if (!rows.length) { setError('Pick the first date and how many payments.'); return; }
                    if (draft.rows.length && !window.confirm('Replace the payments already written out?')) return;
                    setError(null);
                    set('rows', rows.map((r) => ({ date: r.date, amount: r.amount ? String(r.amount) : '' })));
                  }}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50">Write out</button>
              </div>
            </div>

            {draft.rows.length > 0 && (
              <div className="rounded-lg border border-gray-200 max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-100">
                    {draft.rows.map((r, i) => (
                      <tr key={i}>
                        <td className="px-2 py-1 text-xs text-gray-400 w-8">{i + 1}</td>
                        <td className="px-2 py-1">
                          <input type="date" value={r.date} onChange={(e) => set('rows', draft.rows.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} className={inputCls} />
                        </td>
                        <td className="px-2 py-1 text-right">
                          <input inputMode="decimal" value={r.amount} onChange={(e) => set('rows', draft.rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} className={`${inputCls} w-28 text-right`} />
                        </td>
                        <td className="px-2 py-1 text-right">
                          <button type="button" onClick={() => set('rows', draft.rows.filter((_, j) => j !== i))} className="text-xs text-gray-500 hover:text-red-600">Remove</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <button type="button" onClick={() => set('rows', [...draft.rows, { date: draft.rows[draft.rows.length - 1]?.date || '', amount: draft.rows[draft.rows.length - 1]?.amount || '' }])}
              className="text-sm text-ooosh-700 hover:underline">+ Add a payment</button>

            {check && check.count > 0 && (
              <div className={`rounded-lg px-3 py-2 text-sm ${check.against && Math.abs(check.against.figure - check.against.compared) > 0.5 ? 'bg-amber-50 text-amber-900 border border-amber-200' : 'bg-green-50 text-green-900 border border-green-200'}`}>
                {check.count} payment{check.count === 1 ? '' : 's'} · {gbp(check.total, true)}
                {linkedBill && <> · {gbp(check.toCome, true)} still to come</>}
                {check.against && (Math.abs(check.against.figure - check.against.compared) <= 0.5
                  ? <> · {check.against.label} {gbp(check.against.figure, true)} ✓</>
                  : <> · {check.against.label} {gbp(check.against.figure, true)} — {gbp(Math.abs(check.against.figure - check.against.compared), true)} {check.against.figure > check.against.compared ? 'short' : 'over'}</>)}
                {check.bad && <span className="block text-xs text-red-700 mt-0.5">Some payments are missing a date or an amount.</span>}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-sm">
                <span className="block text-gray-700 mb-1">Pays off this Xero bill (optional)</span>
                <select value={draft.xeroBillId || ''} onChange={(e) => {
                  const b = bills?.find((x) => x.id === e.target.value) || null;
                  setDraft((d) => (d ? { ...d, xeroBillId: b?.id || null, xeroBillLabel: b ? billLabel(b) : null } : d));
                }} className={`${inputCls} w-full`}>
                  <option value="">— none —</option>
                  {draft.xeroBillId && !bills?.some((b) => b.id === draft.xeroBillId) && (
                    <option value={draft.xeroBillId}>{draft.xeroBillLabel || 'A bill no longer unpaid in Xero'}</option>
                  )}
                  {(bills || []).map((b) => <option key={b.id} value={b.id}>{billLabel(b)}</option>)}
                </select>
                {bills === null && <span className="text-[11px] text-gray-500">Loading Xero bills…</span>}
                {billsError && <span className="text-[11px] text-amber-700">{billsError}</span>}
                {draft.xeroBillId && <span className="block text-[11px] text-gray-500 mt-0.5">The bill leaves the bills line; these payments stand in for it.</span>}
              </label>
              {!draft.xeroBillId && (
                <label className="text-sm">
                  <span className="block text-gray-700 mb-1">Expected total (optional, £)</span>
                  <input inputMode="decimal" value={draft.expectedTotal} onChange={(e) => set('expectedTotal', e.target.value)} className={`${inputCls} w-full text-right`} />
                </label>
              )}
            </div>
          </div>
        )}

        {!draft.xeroBillId && (
          <div className="text-sm">
            <span className="block text-gray-700 mb-1">Matches bills from (optional)</span>
            {draft.xeroContactId ? (
              <p className="text-sm text-gray-800">
                {draft.xeroContactName}
                <button type="button" onClick={() => setDraft((d) => (d ? { ...d, xeroContactId: null, xeroContactName: null } : d))} className="ml-2 text-xs text-gray-500 hover:text-red-600">Remove</button>
              </p>
            ) : (
              <div className="relative">
                <input value={contactSearch} onChange={(e) => setContactSearch(e.target.value)} placeholder="Search Xero suppliers" className={`${inputCls} w-full`} />
                {contactResults.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg max-h-48 overflow-y-auto">
                    {contactResults.map((c) => (
                      <button key={c.id} type="button" onClick={() => { setDraft((d) => (d ? { ...d, xeroContactId: c.id, xeroContactName: c.name } : d)); setContactSearch(''); setContactResults([]); }}
                        className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50">{c.name}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <span className="block text-[11px] text-gray-500 mt-0.5">If the bookkeeper raises a bill for it in Xero, the bill counts instead and this payment steps aside — never both.</span>
          </div>
        )}

        <label className="block text-sm">
          <span className="block text-gray-700 mb-1">Notes (optional)</span>
          <textarea value={draft.notes} onChange={(e) => set('notes', e.target.value)} rows={2} className={`${inputCls} w-full`} />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex items-center justify-between gap-2 pt-1">
          <div>
            {draft.id && <button type="button" onClick={remove} disabled={saving} className="px-3 py-2 text-sm rounded-lg text-red-700 hover:bg-red-50">Delete</button>}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setDraft(null)} className="px-3 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">Back</button>
            <button type="button" onClick={save} disabled={saving} className="px-3 py-2 text-sm rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
