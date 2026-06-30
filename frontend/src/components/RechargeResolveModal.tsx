/**
 * RechargeResolveModal — the single "resolve this recharge" surface, used from
 * both the Costs hub (Recharges tab) and the Job View Money tab (Extra costs).
 *
 * One cost, three terminal outcomes:
 *   - Push to HireHop      → adds a billable hire line on the job (HH adds VAT)
 *   - Recharged externally → billed another way (closed HH job → direct invoice)
 *   - Absorb / write off   → not billed (reason required, auditable)
 *
 * Everything is ex VAT. The figure billed = the cost net + a markup (default:
 * greater of 20% or a £10 floor); HireHop's 20%-rated stock items add the VAT.
 * See docs/COST-CAPTURE-RECHARGE-SPEC.md — "Phase D".
 */
import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';

type MarkupType = 'greater_of' | 'percent' | 'fixed' | 'none';
type Mode = 'push' | 'external' | 'absorb';

export interface RechargeCost {
  id: string;
  supplier_name?: string | null;
  description?: string | null;
  category?: string | null;
  amount_gross: number | null;
  amount_net?: number | null;
  recharge_mode: 'none' | 'full' | 'partial';
  recharge_amount?: number | null;
  hh_job_number?: number | null;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function computeMarkup(base: number, type: MarkupType, value: number, floor: number): number {
  const b = Math.max(0, base || 0);
  const v = value || 0;
  switch (type) {
    case 'percent': return round2(b * v / 100);
    case 'fixed': return round2(v);
    case 'greater_of': return round2(Math.max(b * v / 100, floor || 0));
    case 'none': default: return 0;
  }
}

export default function RechargeResolveModal({ cost, onClose, onResolved }: {
  cost: RechargeCost;
  onClose: () => void;
  onResolved: () => void;
}) {
  // Net base (ex VAT) — prefer the cost's net, fall back to gross. If a partial
  // recharge amount was already set, treat that as the base to start from.
  const baseStart = round2(Number(cost.recharge_amount ?? cost.amount_net ?? cost.amount_gross ?? 0));

  const [mode, setMode] = useState<Mode>('push');
  const [base, setBase] = useState<string>(String(baseStart || ''));
  const [markupType, setMarkupType] = useState<MarkupType>('greater_of');
  const [percent, setPercent] = useState<number>(20);
  const [floor, setFloor] = useState<number>(10);
  const [fixed, setFixed] = useState<number>(0);
  const [finalOverride, setFinalOverride] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Pull the configured default markup so the suggestion matches Settings.
  useEffect(() => {
    api.get<{ data: { type: MarkupType; percent: number; floor: number } }>('/costs/recharge-defaults')
      .then((r) => {
        if (!r.data) return;
        setMarkupType(r.data.type || 'greater_of');
        setPercent(Number(r.data.percent ?? 20));
        setFloor(Number(r.data.floor ?? 10));
      })
      .catch(() => { /* keep the built-in defaults */ });
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const baseNum = Math.max(0, Number(base) || 0);
  const markupValue = markupType === 'fixed' ? fixed : percent;
  const markup = computeMarkup(baseNum, markupType, markupValue, floor);
  const computedFinal = round2(baseNum + markup);
  const finalNum = finalOverride != null ? Math.max(0, Number(finalOverride) || 0) : computedFinal;
  const incVat = round2(finalNum * 1.2);

  const figuresPayload = useCallback(() => ({
    recharge_mode: 'full' as const,
    recharge_amount: finalNum,
    recharge_base_amount: baseNum,
    recharge_markup_type: markupType,
    recharge_markup_value: markupType === 'none' ? null : markupValue,
  }), [finalNum, baseNum, markupType, markupValue]);

  async function submit() {
    setError(null); setInfo(null);
    if (mode === 'absorb' && !note.trim()) { setError('A reason is required to absorb / write off this cost.'); return; }
    if (mode !== 'absorb' && !(finalNum > 0)) { setError('The recharge amount must be greater than zero.'); return; }
    setBusy(true);
    try {
      if (mode === 'push') {
        const r = await api.post<{ result: { pushed?: boolean; error?: string; skipped?: string; manualActionRequired?: boolean; amount?: number; stockLabel?: string } }>(
          `/costs/${cost.id}/push-recharge`, figuresPayload(),
        );
        const res = r.result || {};
        if (res.pushed) { onResolved(); onClose(); return; }
        if (res.manualActionRequired) {
          setInfo(`${res.error || 'That HireHop job is closed.'} Switch to “Recharged externally” to record it as billed another way.`);
          setMode('external');
        } else {
          setError(res.error || res.skipped || 'HireHop push did not complete.');
        }
        return;
      }
      // external / absorb → resolve-recharge
      await api.post(`/costs/${cost.id}/resolve-recharge`, {
        resolution: mode === 'external' ? 'recharged_external' : 'absorbed',
        note: note.trim() || null,
        ...(mode === 'external' ? figuresPayload() : {}),
      });
      onResolved(); onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resolve the recharge.');
    } finally {
      setBusy(false);
    }
  }

  const title = cost.supplier_name || cost.description || cost.category || 'Cost';
  const modeBtn = (m: Mode, label: string) => (
    <button type="button" onClick={() => { setMode(m); setError(null); setInfo(null); }}
      className={`flex-1 px-3 py-2 text-sm font-medium rounded-md border ${
        mode === m ? 'border-purple-600 bg-purple-50 text-purple-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
      }`}>
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900">Resolve recharge</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-sm">
            <div className="font-medium text-gray-900 truncate">{title}</div>
            <div className="text-gray-500">
              Cost {`£${Number(cost.amount_gross ?? 0).toFixed(2)}`} inc VAT
              {cost.hh_job_number ? ` · HireHop job #${cost.hh_job_number}` : ''}
            </div>
          </div>

          {/* Mode selector */}
          <div className="flex gap-2">
            {modeBtn('push', 'Push to HireHop')}
            {modeBtn('external', 'Billed externally')}
            {modeBtn('absorb', 'Absorb')}
          </div>

          {/* Markup block (push + external) */}
          {mode !== 'absorb' && (
            <div className="rounded-md border border-gray-200 p-3 space-y-3">
              <p className="text-xs text-gray-500">All figures ex VAT — HireHop adds 20% on the pushed line.</p>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm">
                  <span className="block text-xs text-gray-500 mb-1">Base (net)</span>
                  <div className="flex items-center">
                    <span className="px-2 text-gray-400">£</span>
                    <input type="number" step="0.01" value={base} onChange={(e) => { setBase(e.target.value); setFinalOverride(null); }}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                  </div>
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-gray-500 mb-1">Markup</span>
                  <select value={markupType} onChange={(e) => { setMarkupType(e.target.value as MarkupType); setFinalOverride(null); }}
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm">
                    <option value="greater_of">Greater of % or £</option>
                    <option value="percent">Percent</option>
                    <option value="fixed">Fixed £</option>
                    <option value="none">No markup</option>
                  </select>
                </label>
              </div>

              {(markupType === 'greater_of' || markupType === 'percent') && (
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-sm">
                    <span className="block text-xs text-gray-500 mb-1">Percent</span>
                    <input type="number" step="1" value={percent} onChange={(e) => { setPercent(Number(e.target.value)); setFinalOverride(null); }}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                  </label>
                  {markupType === 'greater_of' && (
                    <label className="text-sm">
                      <span className="block text-xs text-gray-500 mb-1">Min £ floor</span>
                      <input type="number" step="0.01" value={floor} onChange={(e) => { setFloor(Number(e.target.value)); setFinalOverride(null); }}
                        className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                    </label>
                  )}
                </div>
              )}
              {markupType === 'fixed' && (
                <label className="text-sm block">
                  <span className="block text-xs text-gray-500 mb-1">Fixed markup £</span>
                  <input type="number" step="0.01" value={fixed} onChange={(e) => { setFixed(Number(e.target.value)); setFinalOverride(null); }}
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                </label>
              )}

              <div className="flex items-center justify-between text-sm pt-1 border-t border-gray-100">
                <span className="text-gray-500">Markup</span>
                <span className="text-gray-700">£{markup.toFixed(2)}</span>
              </div>
              <label className="flex items-center justify-between text-sm gap-3">
                <span className="font-medium text-gray-700">Recharge (net)</span>
                <span className="flex items-center">
                  <span className="px-1 text-gray-400">£</span>
                  <input type="number" step="0.01" value={finalOverride ?? String(computedFinal)}
                    onChange={(e) => setFinalOverride(e.target.value)}
                    className="w-28 border border-gray-300 rounded px-2 py-1 text-sm text-right font-semibold" />
                </span>
              </label>
              <p className="text-xs text-gray-400 text-right">Client billed £{incVat.toFixed(2)} inc VAT</p>
            </div>
          )}

          {/* Note: required for absorb, optional reference for external */}
          {mode !== 'push' && (
            <label className="block text-sm">
              <span className="block text-xs text-gray-500 mb-1">
                {mode === 'absorb' ? 'Reason (required) — why we’re not billing this' : 'Reference (optional) — e.g. Xero invoice number'}
              </span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                placeholder={mode === 'absorb' ? 'e.g. small underfuelling, absorbed as goodwill' : 'e.g. invoiced directly on Xero INV-1234'} />
            </label>
          )}

          {info && <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">{info}</div>}
          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200">
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
          <button onClick={submit} disabled={busy}
            className="px-4 py-2 text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-md disabled:opacity-50">
            {busy ? 'Working…'
              : mode === 'push' ? `Push £${finalNum.toFixed(2)} + VAT to HireHop`
              : mode === 'external' ? 'Mark billed externally'
              : 'Absorb / write off'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Shared terminal-status pill so the hub + Money tab render recharges the same.
export function RechargeStatusPill({ status, mode }: { status?: string | null; mode?: string }) {
  if (!mode || mode === 'none') return null;
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: 'recharge pending', cls: 'bg-amber-50 text-amber-700' },
    recharged_hh: { label: 'recharged ✓', cls: 'bg-green-50 text-green-700' },
    recharged_external: { label: 'billed externally ✓', cls: 'bg-green-50 text-green-700' },
    absorbed: { label: 'absorbed', cls: 'bg-gray-100 text-gray-600' },
  };
  const s = map[status || 'pending'] || map.pending;
  return <span className={`px-2 py-0.5 text-xs rounded-full ${s.cls}`}>{s.label}</span>;
}
