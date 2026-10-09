/**
 * HireInvoicePanel — Raise invoice, on the Invoice card of the Post-Hire tab
 * (HIRE-CLOSE-OUT-SPEC.md §4.1). Shows what is left to bill and raises it:
 * draft from the uninvoiced lines, penny check, approve dated today, Xero.
 * Manager-tier; everyone sees the figures. The card's own status still comes
 * from the derivation engine (it flips to "Generated" once the invoice exists).
 */
import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import {
  CloseOutPlan, CloseOutResult, loadCloseOutPlan, publishCloseOutPlan, subscribeCloseOutPlan, money, fmtDay, apiError,
} from '../lib/closeOutPlan';

interface Props {
  jobId: string;
  onChanged?: () => void;
}

export default function HireInvoicePanel({ jobId, onChanged }: Props) {
  const user = useAuthStore(s => s.user);
  const isManager = hasManagerRole(user?.role);

  const [plan, setPlan] = useState<CloseOutPlan | null>(null);
  const [result, setResult] = useState<CloseOutResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const unsub = subscribeCloseOutPlan(jobId, p => { if (alive) setPlan(p); });
    // A cached plan resolves without publishing, so take the result directly too.
    loadCloseOutPlan(jobId)
      .then(p => { if (alive) setPlan(p); })
      .catch(e => { if (alive) setError(apiError(e, 'Could not read the job\'s invoices from HireHop.')); });
    return () => { alive = false; unsub(); };
  }, [jobId]);

  const raise = async (allowNotReturned: boolean) => {
    if (!plan) return;
    const inv = plan.invoice;
    const what = inv.draft
      ? `Approve the draft invoice already on the job (${money(inv.draft.gross)} inc VAT), dated today, and send it to Xero?`
      : `Raise an invoice for the ${money(inv.netToInvoice)} ex VAT not yet invoiced, dated today, approve it and send it to Xero?`;
    if (!window.confirm(what + (allowNotReturned ? '\n\nHireHop still shows this job as out.' : ''))) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ data: CloseOutResult }>(`/close-out/${jobId}/raise-invoice`, { allow_not_returned: allowNotReturned });
      setResult(r.data);
      publishCloseOutPlan(jobId, r.data.plan);
      onChanged?.();
    } catch (e) {
      setError(apiError(e, 'Could not raise the invoice.'));
    } finally {
      setBusy(false);
    }
  };

  if (!plan) {
    return <div className="mt-1.5 text-xs text-gray-400">{error ?? 'Reading HireHop…'}</div>;
  }

  if (plan.fromLog) return null;   // Completed — the Payment card says so; nothing to raise.

  const inv = plan.invoice;
  const nothingLeft = inv.netToInvoice < 0.005 && !inv.draft;
  const onlyNotReturned = inv.blockers.length === 1 && inv.notReturned;
  const canRaise = isManager && (inv.ready || (onlyNotReturned && (inv.netToInvoice >= 0.005 || inv.draft)));

  return (
    <div className="mt-1.5 space-y-1.5 text-xs">
      {plan.invoices.length > 0 && (
        <div className="text-gray-600">
          Invoiced: {plan.invoices.map(i => `${i.number} (${money(i.gross)}, ${fmtDay(i.date)})`).join(', ')}
        </div>
      )}
      {nothingLeft ? (
        <div className="text-gray-500">Nothing left to invoice — every line is on an invoice.</div>
      ) : inv.draft ? (
        <div className="text-gray-700">Draft invoice {inv.draft.invoiceId} on the job: {money(inv.draft.gross)} inc VAT, not yet approved.</div>
      ) : (
        <div className="text-gray-700">
          {money(inv.netToInvoice)} ex VAT not yet invoiced
          {inv.invoicedNet >= 0.005 && <span className="text-gray-500"> (of a {money(inv.accruedNet)} job, {money(inv.invoicedNet)} already invoiced)</span>}.
        </div>
      )}

      {(onlyNotReturned && isManager ? [] : inv.blockers).map(b => (
        <div key={b} className={`rounded border px-2 py-1 ${inv.notReturned && b.includes("hasn't returned") ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-red-200 bg-red-50 text-red-800'}`}>{b}</div>
      ))}

      {result && <p className={result.done ? 'text-green-800' : 'text-red-800'}>{result.message}</p>}
      {error && <p className="text-red-700">{error}</p>}

      {!nothingLeft && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {canRaise && inv.ready && (
            <button
              onClick={() => raise(false)}
              disabled={busy}
              className="rounded bg-green-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-green-800 disabled:opacity-50"
            >
              {busy ? 'Raising…' : inv.draft ? 'Approve draft invoice' : 'Raise invoice'}
            </button>
          )}
          {canRaise && !inv.ready && onlyNotReturned && (
            <button
              onClick={() => raise(true)}
              disabled={busy}
              className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            >
              {busy ? 'Raising…' : 'Raise invoice anyway (job still out)'}
            </button>
          )}
          {!isManager && inv.ready && <span className="text-gray-400">A manager can raise the invoice from here.</span>}
        </div>
      )}
    </div>
  );
}
