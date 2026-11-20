/**
 * Link a record to the contractor's bill in Money › Costs (spec §1.12, §15).
 * Costs are never retyped: this only points at a bill that is already there.
 * With nothing typed it offers the contractor's recent bills (by the supplier
 * name on the cost); typing searches supplier, description, invoice number or
 * the amount.
 */
import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { LinkedCost, fmtDate, fmtMoney } from './premisesCopy';

interface Candidate extends LinkedCost { description: string | null }

export default function LinkCostModal({ checkId, recordId, contractorName, onClose, onLinked }: {
  checkId: string;
  recordId: string;
  contractorName: string | null;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.get<{ data: Candidate[] }>(`/premises/checks/${checkId}/linkable-costs?search=${encodeURIComponent(q.trim())}`)
        .then(res => { if (live) { setRows(res.data); setError(null); } })
        .catch(err => { if (live) setError(err instanceof Error ? err.message : 'Could not search Costs'); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [checkId, q]);

  async function pick(costId: string) {
    setSaving(true); setError(null);
    try { await api.post(`/premises/records/${recordId}/cost`, { cost_id: costId }); onLinked(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not link it'); setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (!saving) onClose(); }} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 max-h-[90vh] flex flex-col">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Link the bill</h3>
        <p className="text-sm text-gray-500 mb-3">A bill or receipt that's already in Money › Costs.</p>
        <input value={q} onChange={e => setQ(e.target.value)} autoFocus aria-label="Search Costs"
          placeholder="Supplier, invoice number or amount" className="w-full px-3 py-2 border border-gray-300 rounded text-sm mb-3" />
        {!q.trim() && contractorName && <p className="text-xs text-gray-500 mb-2">Recent bills from {contractorName}:</p>}
        <div className="overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded min-h-[80px]">
          {rows === null ? (
            <p className="text-sm text-gray-500 p-3">Searching…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-gray-500 p-3">
              {q.trim() ? 'Nothing in Costs matches that.' : 'Type to search Costs.'}
            </p>
          ) : rows.map(c => (
            <button key={c.id} type="button" disabled={saving} onClick={() => void pick(c.id)}
              className="w-full text-left px-3 py-2 hover:bg-ooosh-50 disabled:opacity-50">
              <div className="flex justify-between gap-2 text-sm">
                <span className="font-medium text-gray-900 truncate">{c.supplier_name ?? 'No supplier'}</span>
                <span className="tabular-nums whitespace-nowrap">{fmtMoney(c.amount_net)} + VAT</span>
              </div>
              <div className="text-xs text-gray-500 truncate">
                {[fmtDate(c.cost_date), c.invoice_number, c.description].filter(Boolean).join(' · ')}
              </div>
            </button>
          ))}
        </div>
        {error && <p className="text-sm text-red-700 mt-3">{error}</p>}
        <div className="flex justify-end mt-4">
          <button type="button" onClick={onClose} disabled={saving}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40">Cancel</button>
        </div>
      </div>
    </div>
  );
}
