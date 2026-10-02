/**
 * Record a refund — money coming BACK from a supplier.
 *
 * We bought the wrong screws, took them back, Screwfix refunded the card. The
 * purchase is never edited: this writes a SECOND row, negative and linked, so
 * the receipt still says what it said and the job/vehicle total nets to what we
 * actually spent. See migration 229 + services/cost-credit.ts.
 *
 * Two ways in, one modal:
 *   - from a cost row ("Record refund") — the purchase is known, and every
 *     facet (job, vehicle, category, card) is inherited server-side;
 *   - from Capture cost, when someone photographs a refund slip out of habit —
 *     the purchase is picked here first.
 *
 * Amounts are typed POSITIVE here, as staff see them on the slip. The server
 * stores them negative (applyCreditSign) — the sign is never a thing a client
 * gets to decide.
 */
import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { COST_CATEGORIES } from './CostCaptureModal';
import { PAID_NOW_METHODS } from '../lib/costOptions';
import type { Cost } from '../../../shared/types';

interface ParentCost {
  id: string;
  supplier_name?: string | null;
  invoice_number?: string | null;
  description?: string | null;
  cost_date?: string | null;
  amount_gross?: number | null;
  amount_vat?: number | null;
  is_credit?: boolean;
}

interface Refundable { gross: number; refunded: number; remaining: number }

const gbp = (n: number | null | undefined) => `£${Number(n || 0).toFixed(2)}`;
const today = () => new Date().toISOString().slice(0, 10);

export default function RecordRefundModal({ cost, initialFile, onClose, onSaved }: {
  /** The purchase being refunded. Null = came from capture; pick it here. */
  cost: ParentCost | null;
  /** A refund slip already chosen in the capture modal, handed over. */
  initialFile?: File | null;
  onClose: () => void;
  onSaved: (warnings: string[]) => void;
}) {
  const [parent, setParent] = useState<ParentCost | null>(cost);
  // Set explicitly, never inferred from "no parent yet" — otherwise the picker's
  // own empty state would look like a deliberate choice to skip the link.
  const [unlinked, setUnlinked] = useState(false);

  const [balance, setBalance] = useState<Refundable | null>(null);
  const [amount, setAmount] = useState('');
  const [vat, setVat] = useState('');
  const [refundDate, setRefundDate] = useState(today);
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  // Only asked for when there's no purchase to inherit from.
  const [supplier, setSupplier] = useState('');
  const [categoryCode, setCategoryCode] = useState('');
  const [payMethod, setPayMethod] = useState('cot_card');

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ParentCost[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // What's left to refund, asked fresh each time the purchase is known. Two
  // people refunding the same purchase on the same afternoon otherwise both
  // look fine right up until the totals go negative.
  const loadBalance = useCallback(async (parentId: string) => {
    try {
      const res = await api.get<{ data: Refundable }>(`/costs/${parentId}/refundable`);
      setBalance(res.data);
      setAmount(res.data.remaining > 0 ? res.data.remaining.toFixed(2) : '');
    } catch {
      setBalance(null);   // the server re-checks on save; this is just the hint
    }
  }, []);

  useEffect(() => {
    if (!parent) return;
    void loadBalance(parent.id);
    setDescription((d) => d || `Refund — ${parent.description || parent.supplier_name || 'purchase'}`.slice(0, 200));
  }, [parent, loadBalance]);

  // VAT follows the amount at the purchase's own rate, so a partial refund of a
  // VATable purchase reclaims the right amount without anyone doing the sum.
  // Overridable — the slip is what's true if they disagree.
  useEffect(() => {
    if (!parent) return;
    const gross = Math.abs(Number(parent.amount_gross) || 0);
    const parentVat = Math.abs(Number(parent.amount_vat) || 0);
    const amt = Number(amount) || 0;
    if (!gross || !parentVat || !amt) return;
    setVat((Math.round((parentVat * (amt / gross)) * 100) / 100).toFixed(2));
  }, [amount, parent]);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setResults([]); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: (Cost & ParentCost)[] }>(`/costs?search=${encodeURIComponent(q)}&limit=25`);
        if (cancelled) return;
        // A credit can't refund a credit, and a £0 row has nothing to give back.
        setResults((res.data || []).filter((c) => !c.is_credit && Number(c.amount_gross) > 0).slice(0, 12));
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search]);

  const amt = Number(amount) || 0;
  const overRemaining = Boolean(balance && amt > balance.remaining + 0.001);
  const canSave = amt > 0 && !overRemaining && Boolean(refundDate)
    && (parent ? true : unlinked && supplier.trim().length > 1 && Boolean(categoryCode));

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      let receiptKey: string | null = null;
      let receiptName: string | null = null;
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('attachment_only', 'true');
        const up = await api.upload<{ r2_key: string; filename: string }>('/files/upload', fd);
        receiptKey = up.r2_key;
        receiptName = up.filename;
      }

      const body: Record<string, unknown> = {
        is_credit: true,
        refund_of_cost_id: parent?.id ?? null,
        // Positive here; the server stores it negative. Everything else about
        // the row — job, vehicle, card, category — is inherited from the
        // purchase server-side, so a refund can't drift onto another account.
        amount_gross: Math.abs(amt),
        amount_vat: vat === '' ? null : Math.abs(Number(vat) || 0),
        cost_date: refundDate,
        description: description.trim() || null,
        receipt_r2_key: receiptKey,
        receipt_filename: receiptName,
      };
      if (!parent) {
        const cat = COST_CATEGORIES.find((c) => c.xeroCode === categoryCode);
        body.supplier_name = supplier.trim();
        body.xero_account_code = categoryCode;
        body.category = cat?.label ?? null;
        body.cost_type = cat?.costType ?? 'overhead';
        body.payment_method = payMethod;
      }

      const res = await api.post<{ data: Cost; warnings?: string[] }>('/costs', body);
      onSaved(res.warnings || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record the refund');
    } finally {
      setSaving(false);
    }
  }

  const groups = Array.from(new Set(COST_CATEGORIES.map((c) => c.group)));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Record a refund</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Which purchase came back. Known already when this opened from a row. */}
          {parent ? (
            <div className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
              Refund of <strong className="text-gray-900">{parent.supplier_name || 'purchase'}</strong>
              {parent.invoice_number ? <> #{parent.invoice_number}</> : null}
              {' '}· {gbp(Math.abs(Number(parent.amount_gross) || 0))}
              {balance && (
                <div className="text-xs text-gray-500 mt-0.5">
                  {balance.refunded > 0
                    ? `${gbp(balance.refunded)} already refunded — ${gbp(balance.remaining)} left`
                    : `${gbp(balance.remaining)} available to refund`}
                </div>
              )}
              {!cost && (
                <button onClick={() => { setParent(null); setBalance(null); }}
                  className="text-xs text-purple-700 hover:underline mt-1">change</button>
              )}
            </div>
          ) : !unlinked ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Which purchase came back?</label>
              <input value={search} onChange={(e) => setSearch(e.target.value)} autoFocus
                placeholder="🔍 Search by supplier or description"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500" />
              {searching && <p className="text-xs text-gray-400 mt-1">Searching…</p>}
              {results.length > 0 && (
                <div className="mt-1 border border-gray-200 rounded-md max-h-56 overflow-auto divide-y divide-gray-100">
                  {results.map((r) => (
                    <button key={r.id} type="button" onClick={() => setParent(r)}
                      className="w-full text-left px-3 py-2 hover:bg-purple-50">
                      <span className="text-sm text-gray-800">{r.supplier_name || 'Unknown supplier'}</span>
                      <span className="float-right text-sm text-gray-700">{gbp(r.amount_gross)}</span>
                      <span className="block text-xs text-gray-400 truncate">
                        {(r.cost_date || '').slice(0, 10)}{r.description ? ` · ${r.description}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <button onClick={() => setUnlinked(true)} className="text-xs text-purple-700 hover:underline mt-2">
                Can't find it? Record the refund on its own
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
                No purchase linked, so nothing can be inherited — the refund lands wherever you code it here.
                It also won't show against the original spend anywhere.
              </p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Who refunded us?</label>
                <input value={supplier} onChange={(e) => setSupplier(e.target.value)}
                  placeholder="e.g. Screwfix"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">What was it for?</label>
                <select value={categoryCode} onChange={(e) => setCategoryCode(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500">
                  <option value="">Pick a category…</option>
                  {groups.map((group) => (
                    <optgroup key={group} label={group}>
                      {COST_CATEGORIES.filter((c) => c.group === group).map((c) => (
                        <option key={c.xeroCode} value={c.xeroCode}>{c.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Back onto</label>
                <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500">
                  {PAID_NOW_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
                <p className="text-xs text-gray-400 mt-1">The account the money came back to — it posts to that feed in Xero.</p>
              </div>
              <button onClick={() => { setUnlinked(false); setSearch(''); }}
                className="text-xs text-purple-700 hover:underline">Link a purchase after all</button>
            </div>
          )}

          {(parent || unlinked) && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount back</label>
                  <input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500" />
                  {overRemaining && balance && (
                    <p className="text-xs text-red-600 mt-1">
                      More than the {gbp(balance.remaining)} left on this purchase.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    VAT <span className="text-gray-400 font-normal">included</span>
                  </label>
                  <input type="number" step="0.01" min="0" value={vat} onChange={(e) => setVat(e.target.value)}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500" />
                  {parent && <p className="text-xs text-gray-400 mt-1">At the purchase's rate.</p>}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Date the money came back</label>
                <input type="date" value={refundDate} onChange={(e) => setRefundDate(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">What came back, and why</label>
                <input value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. returned 4x wrong-length screws"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Refund slip <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <label className="inline-block px-3 py-1.5 text-sm border border-gray-300 rounded-md cursor-pointer hover:bg-gray-50">
                  {file ? 'Choose a different file' : 'Choose a file'}
                  <input type="file" accept="image/*,application/pdf" className="hidden"
                    onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
                </label>
                {file && (
                  <span className="ml-2 text-xs text-gray-600">
                    {file.name}
                    <button onClick={() => setFile(null)} className="ml-1 text-red-500 hover:text-red-700">×</button>
                  </span>
                )}
              </div>

              <p className="text-xs text-gray-500 border-t border-gray-100 pt-3">
                The original purchase isn't changed. This is recorded as money coming back, and
                {parent ? ' inherits its job, vehicle and category' : ' is coded as above'} — so the totals net out.
              </p>
            </>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md">Cancel</button>
          <button onClick={save} disabled={!canSave || saving}
            className="px-4 py-2 text-sm text-white bg-purple-600 hover:bg-purple-700 rounded-md disabled:opacity-50">
            {saving ? 'Saving…' : amt > 0 ? `Record ${gbp(amt)} back` : 'Record refund'}
          </button>
        </div>
      </div>
    </div>
  );
}
