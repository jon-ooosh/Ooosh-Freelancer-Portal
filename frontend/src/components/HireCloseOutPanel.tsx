/**
 * HireCloseOutPanel — the hire close-out, on the Invoice card of the Post-Hire
 * tab (docs/HIRE-CLOSE-OUT-SPEC.md §3). The card itself stays small: one line
 * of state, one line for the first thing in the way (if any), and the buttons.
 * Everything else — the invoices, the payments, the plan in sentences, every
 * blocker and warning, the log — is behind "Details" (jon, 9 Oct 2026: the
 * card had become cluttered).
 *
 * One main button: raise the invoice if there is anything left to bill, then
 * allocate every hire deposit in HireHop and apply the credits in Xero. A run
 * that stops says where, and the same button reads "Carry on". Completing a
 * job is the status change at the top of the page, not a button here.
 * "Mark as sent to client" only appears once nothing is left to allocate, so
 * the client's invoice already shows their payments.
 *
 * Staff-facing wording is about HireHop; the Xero lines in the log are shown
 * to admins only. Raising and allocating are manager-tier.
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

/** The first clause of a long blocker / warning, for the card's one line. */
const short = (s: string) => s.split(' — ')[0].split('. ')[0].replace(/[.:]$/, '');

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
  const [busy, setBusy] = useState<'plan' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

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

  if (!plan && busy === 'plan') return <div className="mt-1 text-xs text-gray-400">Reading HireHop…</div>;
  if (!plan) {
    return (
      <div className="mt-1 text-xs text-red-700">
        {error || 'Could not read the job\'s money.'}{' '}
        <button onClick={() => load()} className="underline hover:text-red-900">Try again</button>
      </div>
    );
  }

  const inv = plan.invoice;
  const completed = plan.fromLog || plan.hhStatus === HH_COMPLETED;
  const needsInvoice = !plan.fromLog && (inv.netToInvoice >= PENNY || inv.draft != null);
  const onlyNotReturned = inv.blockers.length === 1 && inv.notReturned;
  const invoiceOk = inv.ready || (onlyNotReturned && isManager);
  const needsAlloc = plan.ready;
  const stopped = result != null && !result.done;
  // The invoice-first blocker is this panel's own job to clear, not something to shout about.
  const blockers = plan.blockers.filter(b => !b.startsWith('Raise the invoice first'))
    .concat(onlyNotReturned && isManager ? [] : inv.blockers);
  const canRun = isManager && !completed && blockers.length === 0
    && ((needsInvoice && invoiceOk) || (!needsInvoice && needsAlloc));
  const runLabel = stopped ? 'Carry on'
    : needsInvoice && plan.payments.length > 0 ? 'Raise invoice & allocate payments'
    : needsInvoice ? 'Raise invoice'
    : 'Allocate payments';
  const settled = plan.invoices.length > 0 && !needsInvoice && !needsAlloc && blockers.length === 0;
  const surplusTotal = plan.surplus.reduce((s, x) => s + x.amount, 0);

  // ── The card's one line of state ──
  let state: string;
  if (plan.fromLog) state = plan.sentences[0];
  else if (plan.invoices.length > 0) {
    const i = plan.invoices[plan.invoices.length - 1];
    const more = plan.invoices.length > 1 ? ` (+${plan.invoices.length - 1} earlier)` : '';
    state = `${i.number} · ${money(i.gross)} · ${i.owing >= PENNY ? `${money(i.owing)} owing` : 'paid'}${more}`;
    if (needsInvoice) state += ` · ${money(inv.netToInvoice)} ex VAT still to invoice`;
  } else if (inv.draft) state = `Draft invoice on the job, ${money(inv.draft.gross)} inc VAT, not yet approved`;
  else if (inv.netToInvoice >= PENNY) {
    const held = plan.payments.reduce((s, p) => s + p.available, 0);
    state = `${money(inv.netToInvoice)} ex VAT to invoice` + (held >= PENNY ? ` · ${money(held)} received` : '');
  } else state = 'Nothing to invoice yet';
  if (!plan.fromLog && surplusTotal >= PENNY && !needsAlloc) state += ` · ${money(surplusTotal)} unallocated`;

  // ── The card's one line for what is in the way ──
  const attention: { text: string; tone: 'red' | 'amber' } | null =
    blockers.length ? { text: short(blockers[0]) + (blockers.length > 1 ? ` (+${blockers.length - 1} more)` : ''), tone: 'red' }
    : plan.warnings.length ? { text: short(plan.warnings[0]) + (plan.warnings.length > 1 ? ` (+${plan.warnings.length - 1} more)` : ''), tone: 'amber' }
    : null;

  const post = async (path: string, body: unknown, fallback: string) => {
    setBusy('run');
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
  const run = () => {
    if (!window.confirm(
      (needsInvoice ? `Raise the invoice for ${money(inv.netToInvoice)} ex VAT (dated today, approved, sent to Xero)` : 'Allocate the payments')
      + (plan.allocations.length ? `, then:\n${plan.sentences.filter(s => s.startsWith('Allocate')).join('\n')}` : '')
      + (onlyNotReturned ? '\n\nHireHop still shows this job as out.' : '')
      + '\n\nCarry on?',
    )) return;
    void post(`/close-out/${jobId}/run`, { allow_not_returned: onlyNotReturned }, 'That did not finish.');
  };

  const btn = 'rounded px-2 py-1 text-[11px] font-semibold disabled:opacity-50';
  const log = isAdmin ? plan.log : plan.log.filter(e => e.step !== 'xero' && e.step !== 'allocate_xero');

  return (
    <div className="mt-1 space-y-1 text-xs">
      <div className={completed ? 'text-green-700' : 'text-gray-700'}>{state}</div>
      {attention && (
        <div className={attention.tone === 'red' ? 'text-red-700' : 'text-amber-700'}>{attention.text}</div>
      )}
      {result && <div className={result.done ? 'text-green-800' : 'text-red-800'}>{result.message}</div>}
      {error && <div className="text-red-700">{error}</div>}

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {canRun && (
          <button onClick={run} disabled={busy != null}
            className={`${btn} ${onlyNotReturned && needsInvoice ? 'border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100' : 'bg-green-700 text-white hover:bg-green-800'}`}>
            {busy === 'run' ? 'Working…' : onlyNotReturned && needsInvoice ? `${runLabel} anyway (job still out)` : runLabel}
          </button>
        )}
        {settled && onMarkSent && (
          <button onClick={onMarkSent} disabled={busy != null} className={`${btn} border border-green-200 bg-green-50 text-green-700 hover:bg-green-100`}>
            Mark as sent to client
          </button>
        )}
        <button onClick={() => setShowDetails(true)} className="text-[11px] font-medium text-purple-600 hover:text-purple-800">
          Details…
        </button>
        {!isManager && !completed && (needsInvoice || needsAlloc) && blockers.length === 0 && (
          <span className="text-gray-400">A manager can run this from here.</span>
        )}
      </div>

      {showDetails && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowDetails(false)}>
          <div className="bg-white rounded-xl shadow-xl p-5 w-[560px] max-w-[95vw] max-h-[85vh] overflow-y-auto text-xs space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-base font-semibold text-gray-900">Invoice &amp; payments · HireHop job {plan.hhJobNumber}</h3>
              <button onClick={() => load()} disabled={busy != null} className="rounded border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                {busy === 'plan' ? 'Reading HireHop…' : 'Check HireHop again'}
              </button>
            </div>

            {plan.fromLog && <p className="text-green-700">{plan.sentences[0]} Nothing has been read from HireHop; press Check HireHop again if something has changed.</p>}

            {!plan.fromLog && (
              <>
                <section>
                  <h4 className="font-semibold text-gray-800 mb-1">Invoices</h4>
                  {plan.invoices.length === 0 && !inv.draft && <p className="text-gray-500">None approved yet.</p>}
                  {plan.invoices.map(i => (
                    <div key={i.invoiceId} className="flex justify-between gap-3">
                      <span className="text-gray-700">{i.number} · {fmtDay(i.date)} · {money(i.gross)}{!i.inXero && <span className="ml-1 text-amber-700">(not in Xero)</span>}</span>
                      <span className={i.owing >= PENNY ? 'text-amber-700 font-medium' : 'text-green-700'}>{i.owing >= PENNY ? `${money(i.owing)} owing` : 'paid'}</span>
                    </div>
                  ))}
                  {inv.draft && <div className="text-gray-700">Draft {inv.draft.invoiceId} · {money(inv.draft.gross)} inc VAT · not yet approved</div>}
                  {inv.netToInvoice >= PENNY && !inv.draft && (
                    <div className="text-gray-700">{money(inv.netToInvoice)} ex VAT not yet invoiced{inv.invoicedNet >= PENNY && <span className="text-gray-500"> ({money(inv.invoicedNet)} of a {money(inv.accruedNet)} job already invoiced)</span>}</div>
                  )}
                </section>

                <section>
                  <h4 className="font-semibold text-gray-800 mb-1">Payments holding money</h4>
                  {plan.payments.length === 0 && <p className="text-gray-500">None — every hire payment is allocated. Excess is never shown here.</p>}
                  {plan.payments.map(p => (
                    <div key={p.depositId} className="flex justify-between gap-3 text-gray-700">
                      <span>Payment {p.depositId} · {fmtDay(p.date)} · {p.bankName ?? '?'} · {money(p.credit)} received</span>
                      <span>{money(p.available)} unallocated</span>
                    </div>
                  ))}
                </section>

                {blockers.length > 0 && (
                  <section>
                    <h4 className="font-semibold text-red-800 mb-1">In the way</h4>
                    <ul className="list-disc space-y-0.5 pl-4 text-red-800">{blockers.map(b => <li key={b}>{b}</li>)}</ul>
                  </section>
                )}
                {plan.warnings.length > 0 && (
                  <section>
                    <h4 className="font-semibold text-amber-800 mb-1">Worth knowing</h4>
                    <ul className="list-disc space-y-0.5 pl-4 text-amber-700">{plan.warnings.map(w => <li key={w}>{w}</li>)}</ul>
                  </section>
                )}

                {blockers.length === 0 && plan.sentences.length > 0 && (
                  <section>
                    <h4 className="font-semibold text-gray-800 mb-1">{canRun ? 'What the button will do' : 'Where it stands'}</h4>
                    <ul className="space-y-0.5 text-gray-700">{plan.sentences.map(s => <li key={s}>{s}</li>)}</ul>
                    {plan.surplus.length > 0 && (
                      <p className="mt-1 text-gray-600">
                        Refund and &ldquo;Apply to another job&rdquo; are on the payment&rsquo;s row in the{' '}
                        <Link to={`/jobs/${jobId}?tab=money`} className="text-purple-600 hover:text-purple-800 font-medium">Money tab</Link>.
                      </p>
                    )}
                  </section>
                )}
              </>
            )}

            {log.length > 0 && (
              <section>
                <h4 className="font-semibold text-gray-800 mb-1">What happened</h4>
                <ul className="space-y-0.5 text-[11px]">
                  {log.map(e => (
                    <li key={e.id} className={e.ok ? 'text-gray-600' : 'text-red-700'}>
                      <span className="text-gray-400">{fmtWhen(e.created_at)}</span>
                      {e.user_name ? <span className="text-gray-400"> · {e.user_name}</span> : null} · {e.step.replace(/_/g, ' ')}: {e.detail}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="flex justify-end">
              <button onClick={() => setShowDetails(false)} className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
