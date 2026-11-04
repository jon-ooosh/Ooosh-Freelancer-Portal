/**
 * Xero bills — what the forecast reads as "to be paid", and what jon has said
 * about each (docs/CASHFLOW-FORECAST-SPEC.md §5.2). Overdue bills stay out of
 * the line until checked: paid but Xero is behind, paid by card, being paid in
 * instalments, or genuinely due. Nothing here is ever written to Xero.
 */
import { useEffect, useState } from 'react';
import ModalShell from '../ModalShell';
import { api } from '../../services/api';
import type { XeroBillRow } from '../../lib/cashflow';
import { gbp, shortDate } from '../../lib/cashflow';

interface BillsData {
  ok: boolean;
  reason?: string;
  today?: string;
  bills: XeroBillRow[];
  excludedContacts?: Array<{ id: string; name: string }>;
}

const FLAG_LABELS: Record<NonNullable<XeroBillRow['flag']>, string> = {
  paid_xero_behind: 'Paid — Xero is behind',
  paid_by_card: 'Paid by card',
  ignore: 'Not a real bill',
};

interface Props {
  countOverdue: boolean;
  onClose: () => void;
  onChanged: () => void;
  onInstalments: (bill: XeroBillRow) => void;
}

export default function BillsModal({ countOverdue, onClose, onChanged, onInstalments }: Props) {
  const [data, setData] = useState<BillsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [count, setCount] = useState(countOverdue);
  const [show, setShow] = useState<'overdue' | 'all'>('overdue');

  const load = (fresh = false) => api.get<{ data: BillsData }>(`/cashflow/xero/bills${fresh ? '?fresh=1' : ''}`)
    .then((r) => setData(r.data))
    .catch((e: Error) => setError(e.message || 'Could not read the bills.'));

  useEffect(() => { load(); }, []);

  const flag = async (b: XeroBillRow, value: XeroBillRow['flag']) => {
    setBusy(b.id);
    try {
      await api.put(`/cashflow/bill-flags/${encodeURIComponent(b.id)}`, { flag: value, billLabel: `${b.contactName} ${b.number}`.trim() });
      setData((d) => (d ? { ...d, bills: d.bills.map((x) => (x.id === b.id ? { ...x, flag: value } : x)) } : d));
      setChanged(true);
    } catch (e) {
      setError((e as Error).message || 'Could not save.');
    } finally {
      setBusy(null);
    }
  };

  const exclude = async (b: XeroBillRow, excluded: boolean) => {
    if (!b.contactId) return;
    if (excluded && !window.confirm(`Leave out EVERY bill from ${b.contactName}? Use this for a supplier whose payments are counted elsewhere (e.g. a van HP lender — those come from Fleet › Finance).`)) return;
    setBusy(b.id);
    try {
      await api.put(`/cashflow/excluded-contacts/${encodeURIComponent(b.contactId)}`, { excluded, contactName: b.contactName });
      setData((d) => (d ? { ...d, bills: d.bills.map((x) => (x.contactId === b.contactId ? { ...x, contactExcluded: excluded } : x)) } : d));
      setChanged(true);
    } catch (e) {
      setError((e as Error).message || 'Could not save.');
    } finally {
      setBusy(null);
    }
  };

  const toggleCount = async (v: boolean) => {
    setCount(v);
    try {
      await api.put('/cashflow/settings', { countOverdueBills: v });
      setChanged(true);
    } catch (e) {
      setCount(!v);
      setError((e as Error).message || 'Could not save.');
    }
  };

  const close = () => { if (changed) onChanged(); onClose(); };
  const today = data?.today || '';
  const overdue = (data?.bills || []).filter((b) => (b.due || b.date || '') < today);
  const list = show === 'overdue' ? overdue : data?.bills || [];
  const openOverdue = overdue.filter((b) => !b.flag && !b.contactExcluded && !b.plannedItemId);

  return (
    <ModalShell title="Xero bills" subtitle="Approved bills Xero says are unpaid. Nothing here changes Xero." onClose={close} width="max-w-4xl">
      {!data && !error && <p className="text-sm text-gray-500">Reading Xero…</p>}
      {data && !data.ok && <p className="text-sm text-amber-700">{data.reason}</p>}
      {data && data.ok && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-lg border border-gray-300 p-0.5 text-sm">
              <button type="button" onClick={() => setShow('overdue')} className={`px-3 py-1 rounded-md ${show === 'overdue' ? 'bg-ooosh-600 text-white' : 'text-gray-700'}`}>Overdue ({overdue.length})</button>
              <button type="button" onClick={() => setShow('all')} className={`px-3 py-1 rounded-md ${show === 'all' ? 'bg-ooosh-600 text-white' : 'text-gray-700'}`}>All unpaid ({data.bills.length})</button>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={count} onChange={(e) => toggleCount(e.target.checked)} />
                Count the unchecked overdue bills ({gbp(openOverdue.reduce((s, b) => s + b.amountDue, 0))}) from next week
              </label>
              <button type="button" onClick={() => { setData(null); load(true); }} className="text-sm text-ooosh-700 hover:underline">Re-read Xero</button>
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Supplier</th>
                  <th className="px-3 py-2 text-left font-semibold">Bill</th>
                  <th className="px-3 py-2 text-left font-semibold">Due</th>
                  <th className="px-3 py-2 text-right font-semibold">Owed</th>
                  <th className="px-3 py-2 text-left font-semibold">What's true</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-500">Nothing here.</td></tr>}
                {list.map((b) => {
                  const isOverdue = (b.due || b.date || '') < today;
                  return (
                    <tr key={b.id} className={b.flag || b.contactExcluded ? 'text-gray-400' : ''}>
                      <td className="px-3 py-2">{b.contactName}</td>
                      <td className="px-3 py-2 text-xs">{b.number || b.reference || '—'}</td>
                      <td className={`px-3 py-2 whitespace-nowrap ${isOverdue && !b.flag ? 'text-amber-700 font-medium' : ''}`}>{shortDate(b.due || b.date)}</td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                        {gbp(b.amountDue, true)}
                        {b.amountDue < b.total - 0.01 && <span className="block text-[11px] text-gray-400">of {gbp(b.total, true)}</span>}
                      </td>
                      <td className="px-3 py-2">
                        {b.plannedItemId ? (
                          <span className="text-xs text-ooosh-700">Paid in instalments (Planned items)</span>
                        ) : b.contactExcluded ? (
                          <span className="text-xs">Supplier left out · <button type="button" disabled={busy === b.id} onClick={() => exclude(b, false)} className="underline">count again</button></span>
                        ) : b.flag ? (
                          <span className="text-xs">{FLAG_LABELS[b.flag]} · <button type="button" disabled={busy === b.id} onClick={() => flag(b, null)} className="underline">undo</button></span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            <button type="button" disabled={busy === b.id} onClick={() => flag(b, 'paid_xero_behind')} className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50">Paid — Xero is behind</button>
                            <button type="button" disabled={busy === b.id} onClick={() => flag(b, 'paid_by_card')} className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50">Paid by card</button>
                            <button type="button" disabled={busy === b.id} onClick={() => onInstalments(b)} className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50">Instalments…</button>
                            <button type="button" disabled={busy === b.id} onClick={() => flag(b, 'ignore')} className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50" title="A duplicate or a mistake in Xero">Not real</button>
                            {b.contactId && <button type="button" disabled={busy === b.id} onClick={() => exclude(b, true)} className="text-xs px-2 py-1 rounded text-gray-500 hover:bg-gray-50">Leave out supplier</button>}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-500">
            "Paid — Xero is behind" drops out of the forecast and is harmless once the bookkeeper reconciles it. "Paid by card" is cash out when the card is paid (the card's own line), so it isn't counted twice.
          </p>
        </div>
      )}
      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
    </ModalShell>
  );
}
