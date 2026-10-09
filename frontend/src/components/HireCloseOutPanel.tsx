/**
 * HireCloseOutPanel — the money steps behind the Payment Reconciliation card
 * on the Post-Hire tab (docs/HIRE-CLOSE-OUT-SPEC.md §3, §4.3, §4.4).
 *
 * Same shape as the shop's ShopWeekClose, on purpose: the card shows what
 * Allocate WOULD do (read from HireHop, nothing written), or what is stopping
 * it, and only then a button. A run that stops part-way says why, and the
 * same button carries on. Staff-facing wording is about HireHop; the Xero
 * lines in the log are shown to admins only (jon, 9 Oct 2026 — only jon and
 * the bookkeeper act on Xero, and the sweep is automatic).
 *
 * Allocate and Complete are manager-tier (MANAGER_ROLES on the routes);
 * everyone sees the plan.
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

interface Props {
  jobId: string;
  /** Reload the job's requirements once something changed (the card's status re-derives). */
  onChanged?: () => void;
}

export default function HireCloseOutPanel({ jobId, onChanged }: Props) {
  const user = useAuthStore(s => s.user);
  const isManager = hasManagerRole(user?.role);
  const isAdmin = user?.role === 'admin';

  const [plan, setPlan] = useState<CloseOutPlan | null>(null);
  const [result, setResult] = useState<CloseOutResult | null>(null);
  const [busy, setBusy] = useState<'plan' | 'allocate' | 'complete' | null>(null);
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

  const allocate = async () => {
    if (!plan) return;
    const lines = plan.sentences.filter(s => s.startsWith('Allocate')).join('\n');
    if (!window.confirm(`${lines}\n\nThis allocates in HireHop and applies the credit in Xero. Carry on?`)) return;
    setBusy('allocate');
    setError(null);
    try {
      const r = await api.post<{ data: CloseOutResult }>(`/close-out/${jobId}/allocate`, {});
      setResult(r.data);
      publishCloseOutPlan(jobId, r.data.plan);
      onChanged?.();
    } catch (e) {
      setError(apiError(e, 'The allocation failed.'));
    } finally {
      setBusy(null);
    }
  };

  const complete = async (allowExcessHeld: boolean) => {
    const what = allowExcessHeld
      ? `${money(plan?.excessHeld ?? 0)} excess is still held on this job. Complete it in HireHop anyway?`
      : 'Set this job to Completed in HireHop?';
    if (!window.confirm(what)) return;
    setBusy('complete');
    setError(null);
    try {
      const r = await api.post<{ data: CloseOutResult }>(`/close-out/${jobId}/complete`, { allow_excess_held: allowExcessHeld });
      setResult(r.data);
      publishCloseOutPlan(jobId, r.data.plan);
      onChanged?.();
    } catch (e) {
      setError(apiError(e, 'Could not complete the job.'));
    } finally {
      setBusy(null);
    }
  };

  if (!plan && busy === 'plan') {
    return <div className="mt-1.5 text-xs text-gray-400">Reading HireHop…</div>;
  }
  if (!plan) {
    return (
      <div className="mt-1.5 text-xs text-red-700">
        {error || 'Could not read the job\'s money.'}{' '}
        <button onClick={() => load()} className="underline hover:text-red-900">Try again</button>
      </div>
    );
  }

  const completed = plan.hhStatus === HH_COMPLETED;
  const open = plan.invoices.filter(i => i.owing >= 0.005);
  const canCompleteAnyway = isManager && !completed && plan.blockers.length === 0 && open.length === 0
    && plan.surplus.length === 0 && plan.payments.length === 0 && plan.excessHeld >= 0.005;
  const log = isAdmin ? plan.log : plan.log.filter(e => e.step !== 'xero' && e.step !== 'allocate_xero');

  return (
    <div className="mt-1.5 space-y-1.5 text-xs">
      {/* Invoices and payments — the facts, as HireHop has them */}
      {plan.invoices.length > 0 && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
          {plan.invoices.map(inv => (
            <div key={inv.invoiceId} className="contents">
              <dt className="text-gray-600">
                {inv.number} · {fmtDay(inv.date)} · {money(inv.gross)}
                {!inv.inXero && <span className="ml-1 text-amber-700">(not in Xero)</span>}
              </dt>
              <dd className={`text-right tabular-nums ${inv.owing >= 0.005 ? 'text-amber-700 font-medium' : 'text-green-700'}`}>
                {inv.owing >= 0.005 ? `${money(inv.owing)} owing` : 'paid'}
              </dd>
            </div>
          ))}
          {plan.payments.map(p => (
            <div key={p.depositId} className="contents">
              <dt className="text-gray-500">Payment {p.depositId} · {fmtDay(p.date)} · {p.bankName ?? 'bank ?'}</dt>
              <dd className="text-right tabular-nums text-gray-500">{money(p.available)} unallocated</dd>
            </div>
          ))}
        </dl>
      )}

      {/* What is stopping it */}
      {plan.blockers.length > 0 && (
        <ul className="list-disc space-y-0.5 rounded border border-red-200 bg-red-50 px-2 py-1 pl-6 text-red-800">
          {plan.blockers.map(b => <li key={b}>{b}</li>)}
        </ul>
      )}
      {plan.warnings.map(w => (
        <div key={w} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700">{w}</div>
      ))}

      {/* The plan, in sentences */}
      {plan.blockers.length === 0 && plan.sentences.length > 0 && (
        <ul className="space-y-0.5 text-gray-700">
          {plan.sentences.map(s => <li key={s}>{s}</li>)}
        </ul>
      )}
      {plan.surplus.length > 0 && plan.blockers.length === 0 && (
        <div className="text-gray-500">
          Refund and &ldquo;Apply to another job&rdquo; are on the payment&rsquo;s row in the{' '}
          <Link to={`/jobs/${jobId}?tab=money`} className="text-purple-600 hover:text-purple-800 font-medium">Money tab</Link>.
        </div>
      )}

      {result && (
        <p className={result.done ? 'text-green-800' : 'text-red-800'}>{result.message}</p>
      )}
      {error && <p className="text-red-700">{error}</p>}

      {/* Buttons */}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <button
          onClick={() => load()}
          disabled={busy != null}
          className="rounded border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {busy === 'plan' ? 'Reading HireHop…' : 'Check again'}
        </button>
        {isManager && plan.ready && (
          <button
            onClick={allocate}
            disabled={busy != null}
            className="rounded bg-green-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-green-800 disabled:opacity-50"
          >
            {busy === 'allocate' ? 'Allocating…' : 'Allocate payments'}
          </button>
        )}
        {isManager && !completed && plan.readyToComplete && (
          <button
            onClick={() => complete(false)}
            disabled={busy != null}
            className="rounded bg-green-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-green-800 disabled:opacity-50"
          >
            {busy === 'complete' ? 'Completing…' : 'Complete job'}
          </button>
        )}
        {canCompleteAnyway && !plan.readyToComplete && (
          <button
            onClick={() => complete(true)}
            disabled={busy != null}
            className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            {busy === 'complete' ? 'Completing…' : 'Complete anyway (excess held)'}
          </button>
        )}
        {completed && <span className="text-green-700">Job is Completed in HireHop.</span>}
        {!isManager && (plan.ready || plan.readyToComplete) && (
          <span className="text-gray-400">A manager can allocate / complete from here.</span>
        )}
      </div>

      {log.length > 0 && (
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
      )}
    </div>
  );
}
