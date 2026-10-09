/**
 * HireCloseOutPanel — the hire close-out, on the Invoice card of the Post-Hire
 * tab (docs/HIRE-CLOSE-OUT-SPEC.md §3). One card, one panel, one main button:
 * raise the invoice if there is anything left to bill, then allocate every hire
 * deposit in HireHop and apply the credits in Xero. A run that stops says
 * where, and the same button carries on. Complete is its own button, because
 * jobs are deliberately left open while damage quotes or missing items are
 * pending. "Mark as sent to client" only appears once there is nothing left to
 * allocate, so the client's invoice already shows their payments.
 *
 * Staff-facing wording is about HireHop; the Xero lines in the log are shown
 * to admins only. Raising, allocating and completing are manager-tier.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import {
  CloseOutPlan, CloseOutResult, loadCloseOutPlan, publishCloseOutPlan, subscribeCloseOutPlan, money, fmtDay, fmtWhen, apiError,
} from '../lib/closeOutPlan';

const HH_COMPLETED = 11;
const PENNY = 0.005;

interface Props {
  jobId: string;
  /** Reload the job's requirements once something changed (the card statuses re-derive). */
  onChanged?: () => void;
  /** Offered once the money is settled: marks the Invoice requirement "Sent". */
  onMarkSent?: () => void;
}

export default function HireCloseOutPanel({ jobId, onChanged, onMarkSent }: Props) {
  const user = useAuthStore(s => s.user);
  const isManager = hasManagerRole(user?.role);
  const isAdmin = user?.role === 'admin';

  const [plan, setPlan] = useState<CloseOutPlan | null>(null);
  const [result, setResult] = useState<CloseOutResult | null>(null);
  const [busy, setBusy] = useState<'plan' | 'run' | 'complete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = true) => {
    setBusy('plan');
    setError(null);
    try {
      setPlan(await loadCloseOutPlan(jobId, force));
    } catch (e) {
      setError(apiError(e, 'Could not read the job\'s money from HireHop.'));
    } finally {
      setBusy(null);
    }
  }, [jobId]);

  useEffect(() => {
    const unsub = subscribeCloseOutPlan(jobId, setPlan);
    void load(false);
    return unsub;
  }, [jobId, load]);

  const post = async (path: string, body: unknown, kind: 'run' | 'complete', fallback: string) => {
    setBusy(kind);
    setError(null);
    try {
      const r = await api.post<{ data: CloseOutResult }>(path, body);
      setResult(r.data);
      publishCloseOutPlan(jobId, r.data.plan);
      onChanged?.();
    } catch (e) {
      setError(apiError(e, fallback));
    } finally {
      setBusy(null);
    }
  };

  if (!plan && busy === 'plan') return <div className="mt-1.5 text-xs text-gray-400">Reading HireHop…</div>;
  if (!plan) {
    return (
      <div className="mt-1.5 text-xs text-red-700">
        {error || 'Could not read the job\'s money.'}{' '}
        <button onClick={() => load()} className="underline hover:text-red-900">Try again</button>
      </div>
    );
  }

  const log = isAdmin ? plan.log : plan.log.filter(e => e.step !== 'xero' && e.step !== 'allocate_xero');
  const logBlock = log.length > 0 && (
    <details>
      <summary className="cursor-pointer text-[11px] text-gray-500">What happened ({log.length})</summary>
      <ul className="mt-1 space-y-0.5 text-[11px]">
        {log.map(e => (
          <li key={e.id} className={e.ok ? 'text-gray-600' : 'text-red-700'}>
            <span className="text-gray-400">{fmtWhen(e.created_at)}</span>
            {e.user_name ? <span className="text-gray-400"> · {e.user_name}</span> : null} · {e.step.replace(/_/g, ' ')}: {e.detail}
          </li>
        ))}
      </ul>
    </details>
  );

  // OP's own record of a Completed job — nothing read from HireHop.
  if (plan.fromLog) {
    return (
      <div className="mt-1.5 space-y-1.5 text-xs">
        <p className="text-green-700">{plan.sentences[0]}</p>
        <button onClick={() => load()} disabled={busy != null} className="rounded border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          {busy === 'plan' ? 'Reading HireHop…' : 'Check HireHop again'}
        </button>
        {logBlock}
      </div>
    );
  }

  const inv = plan.invoice;
  const completed = plan.hhStatus === HH_COMPLETED;
  const open = plan.invoices.filter(i => i.owing >= PENNY);
  const needsInvoice = inv.netToInvoice >= PENNY || inv.draft != null;
  const onlyNotReturned = inv.blockers.length === 1 && inv.notReturned;
  const invoiceOk = inv.ready || (onlyNotReturned && isManager);
  const needsAlloc = plan.ready;
  const stopped = result != null && !result.done;
  const canRun = isManager && !completed && plan.blockers.filter(b => !b.startsWith('Raise the invoice first')).length === 0
    && ((needsInvoice && invoiceOk) || (!needsInvoice && needsAlloc));
  const runLabel = stopped ? 'Carry on'
    : needsInvoice && (plan.payments.length > 0) ? 'Raise invoice & allocate payments'
    : needsInvoice ? 'Raise invoice'
    : 'Allocate payments';
  const settled = plan.invoices.length > 0 && !needsInvoice && !needsAlloc;
  const canCompleteAnyway = isManager && !completed && plan.blockers.length === 0 && open.length === 0
    && plan.surplus.length === 0 && plan.payments.length === 0 && plan.excessHeld >= PENNY;
  // The invoice-first blocker is the panel's own job to clear, not something to shout about.
  const blockers = plan.blockers.filter(b => !b.startsWith('Raise the invoice first'))
    .concat(onlyNotReturned && isManager ? [] : inv.blockers);

  const run = () => {
    if (!window.confirm(
      (needsInvoice ? `Raise the invoice for ${money(inv.netToInvoice)} ex VAT (dated today, approved, sent to Xero)` : 'Allocate the payments')
      + (plan.allocations.length ? `, then:\n${plan.sentences.filter(s => s.startsWith('Allocate')).join('\n')}` : '')
      + (onlyNotReturned ? '\n\nHireHop still shows this job as out.' : '')
      + '\n\nCarry on?',
    )) return;
    void post(`/close-out/${jobId}/run`, { allow_not_returned: onlyNotReturned }, 'run', 'That did not finish.');
  };
  const complete = (allowExcessHeld: boolean) => {
    const what = allowExcessHeld
      ? `${money(plan.excessHeld)} excess is still held on this job. Complete it in HireHop anyway?`
      : 'Set this job to Completed in HireHop?';
    if (!window.confirm(what)) return;
    void post(`/close-out/${jobId}/complete`, { allow_excess_held: allowExcessHeld }, 'complete', 'Could not complete the job.');
  };

  const btn = 'rounded px-2 py-1 text-[11px] font-semibold disabled:opacity-50';

  return (
    <div className="mt-1.5 space-y-1.5 text-xs">
      {/* State: the invoice(s), or what is left to bill */}
      {plan.invoices.map(i => (
        <div key={i.invoiceId} className="flex justify-between gap-3">
          <span className="text-gray-700">{i.number} · {fmtDay(i.date)} · {money(i.gross)}{!i.inXero && <span className="ml-1 text-amber-700">(not in Xero)</span>}</span>
          <span className={i.owing >= PENNY ? 'text-amber-700 font-medium' : 'text-green-700'}>{i.owing >= PENNY ? `${money(i.owing)} owing` : 'paid'}</span>
        </div>
      ))}
      {inv.draft && <div className="text-gray-700">Draft invoice {inv.draft.invoiceId} on the job, {money(inv.draft.gross)} inc VAT, not yet approved.</div>}
      {!inv.draft && inv.netToInvoice >= PENNY && (
        <div className="text-gray-700">
          {money(inv.netToInvoice)} ex VAT not yet invoiced
          {inv.invoicedNet >= PENNY && <span className="text-gray-500"> ({money(inv.invoicedNet)} of a {money(inv.accruedNet)} job already invoiced)</span>}.
        </div>
      )}
      {/* Payments holding money — only while there is something to do with them */}
      {(needsAlloc || plan.surplus.length > 0) && plan.payments.map(p => (
        <div key={p.depositId} className="flex justify-between gap-3 text-gray-500">
          <span>Payment {p.depositId} · {fmtDay(p.date)} · {p.bankName ?? '?'}</span>
          <span>{money(p.available)} unallocated</span>
        </div>
      ))}

      {blockers.length > 0 && (
        <ul className="list-disc space-y-0.5 rounded border border-red-200 bg-red-50 px-2 py-1 pl-6 text-red-800">
          {blockers.map(b => <li key={b}>{b}</li>)}
        </ul>
      )}
      {plan.warnings.map(w => <div key={w} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700">{w}</div>)}

      {plan.surplus.length > 0 && blockers.length === 0 && (
        <div className="text-gray-600">
          {plan.sentences.filter(s => s.startsWith('Leave')).join(' ')}{' '}
          Refund and &ldquo;Apply to another job&rdquo; are on the payment&rsquo;s row in the{' '}
          <Link to={`/jobs/${jobId}?tab=money`} className="text-purple-600 hover:text-purple-800 font-medium">Money tab</Link>.
        </div>
      )}
      {plan.shortfall >= PENNY && !needsAlloc && blockers.length === 0 && (
        <div className="text-gray-600">The client still owes {money(plan.shortfall)}.</div>
      )}

      {result && <p className={result.done ? 'text-green-800' : 'text-red-800'}>{result.message}</p>}
      {error && <p className="text-red-700">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {canRun && (
          <button onClick={run} disabled={busy != null}
            className={`${btn} ${onlyNotReturned && needsInvoice ? 'border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100' : 'bg-green-700 text-white hover:bg-green-800'}`}>
            {busy === 'run' ? 'Working…' : onlyNotReturned && needsInvoice ? `${runLabel} anyway (job still out)` : runLabel}
          </button>
        )}
        {isManager && !completed && plan.readyToComplete && (
          <button onClick={() => complete(false)} disabled={busy != null} className={`${btn} bg-green-700 text-white hover:bg-green-800`}>
            {busy === 'complete' ? 'Completing…' : 'Complete job'}
          </button>
        )}
        {canCompleteAnyway && !plan.readyToComplete && (
          <button onClick={() => complete(true)} disabled={busy != null} className={`${btn} border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100`}>
            {busy === 'complete' ? 'Completing…' : 'Complete anyway (excess held)'}
          </button>
        )}
        {settled && onMarkSent && (
          <button onClick={onMarkSent} disabled={busy != null} className={`${btn} border border-green-200 bg-green-50 text-green-700 hover:bg-green-100`}>
            Mark as sent to client
          </button>
        )}
        <button onClick={() => load()} disabled={busy != null} className="rounded border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          {busy === 'plan' ? 'Reading HireHop…' : 'Check again'}
        </button>
        {completed && <span className="text-green-700">Job is Completed in HireHop.</span>}
        {!isManager && (needsInvoice || needsAlloc) && blockers.length === 0 && <span className="text-gray-400">A manager can run this from here.</span>}
      </div>

      {logBlock}
    </div>
  );
}
