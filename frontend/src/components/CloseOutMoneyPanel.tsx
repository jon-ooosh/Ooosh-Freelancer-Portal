/**
 * CloseOutMoneyPanel — the hire close-out on the Money tab (HIRE-CLOSE-OUT-SPEC.md §3,
 * redesign Oct 2026). It moved here from the Overview's Invoice card, which is now a
 * signpost (CloseOutSignpost.tsx) pointing at this panel.
 *
 * One status pill, five steps (Returned · Invoiced · Payments allocated · Sent to
 * client · Paid in full), one next-action bar with ONE line — the explanation sits
 * behind "Why?" — and, once there is an invoice, a short ledger. The balance itself
 * is shown once, in the Financial Summary above, never here (jon, 12 Oct 2026).
 *
 * Everything is worked out by closeOutView() from the shared plan read, so this
 * panel, the Overview card and the Money tab's dot can never disagree. Raising and
 * allocating stay manager-tier (the route enforces it); "Mark as sent" is anyone's,
 * as the requirement's status always was. No Xero links: only jon and the
 * bookkeeper use Xero, and they find invoices there themselves.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import {
  CloseOutPlan, CloseOutResult, loadCloseOutPlan, publishCloseOutPlan, subscribeCloseOutPlan,
  closeOutView, shortLine, STEP_NAMES, TONE, money, fmtDay, apiError,
} from '../lib/closeOutPlan';

const PENNY = 0.005;

/**
 * The reply never came back, but the work may well have gone through: nginx gives up on
 * a request after a while and hands back its own error page (not JSON — so api.ts can
 * only say "Request failed"), while the server carries on. An EU invoice split can take
 * over a minute (job 15745, 13 Oct 2026). Never treat that as "it failed".
 */
const lostReply = (e: unknown) => {
  const status = (e as any)?.status;
  return status === 502 || status === 503 || status === 504 || e instanceof TypeError
    || (e as any)?.message === 'Request failed';
};
/** Enough of a plan to tell that HireHop has moved on. */
const fingerprint = (p: CloseOutPlan) => JSON.stringify([
  p.invoices.map(i => [i.invoiceId, i.owing]), p.invoice.draft?.invoiceId ?? null,
  p.allocations.length, p.payments.map(x => x.available),
]);
const POLL_MS = 10_000;
const POLL_TRIES = 18;   // three minutes

interface Props {
  jobId: string;
  /** The client's payment portal link (the Money tab already has it). */
  portalUrl?: string | null;
  /** Opens the existing Record Payment form. */
  onRecordPayment?: () => void;
  /** Opens the page's status modal set to Completed (Problems check and all). */
  onRequestComplete?: () => void;
  /** Something changed money-wise — the Money tab reloads its own figures. */
  onChanged?: () => void;
}

type Act = { label: string; onClick: () => void; kind: 'primary' | 'secondary' | 'link' | 'amber' };

export default function CloseOutMoneyPanel({ jobId, portalUrl, onRecordPayment, onRequestComplete, onChanged }: Props) {
  const user = useAuthStore(s => s.user);
  const isManager = hasManagerRole(user?.role);

  const [plan, setPlan] = useState<CloseOutPlan | null>(null);
  const [result, setResult] = useState<CloseOutResult | null>(null);
  const [busy, setBusy] = useState<'plan' | 'run' | 'sent' | 'target' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showWhy, setShowWhy] = useState(false);
  const [copied, setCopied] = useState(false);
  // "Add a charge" — Completed jobs only, managers only (spec §4.6).
  const [charge, setCharge] = useState<{ description: string; amount: string; reason: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

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

  /** The reply was lost — keep reading the plan until HireHop has visibly moved on. */
  const waitForHireHop = async (before: CloseOutPlan) => {
    setBusy('run');
    setResult(null);
    setError(null);
    setNotice('HireHop is still working on this — checking again every 10 seconds. No need to press anything.');
    for (let i = 0; i < POLL_TRIES && alive.current; i++) {
      await new Promise(r => setTimeout(r, POLL_MS));
      if (!alive.current) return;
      try {
        const p = await loadCloseOutPlan(jobId, true);
        if (fingerprint(p) !== fingerprint(before)) {
          setNotice('HireHop has finished — this is where it got to.');
          setCharge(null);   // a charge that went through must not be one click from a second invoice
          setBusy(null);
          onChanged?.();
          return;
        }
      } catch { /* a read can fail mid-write; try again next time round */ }
    }
    if (!alive.current) return;
    setNotice(null);
    setError('Still no change after three minutes. Look at the job in HireHop before pressing again.');
    setBusy(null);
  };

  if (!plan) {
    if (busy === 'plan') return null;   // the Financial Summary above is already on screen; no spinner of our own
    return error ? <div className="bg-white rounded-xl border border-gray-200 p-4 text-sm text-red-700">{error} <button onClick={() => load()} className="underline">Try again</button></div> : null;
  }

  const view = closeOutView(plan, { isManager });
  if (view.stage === 'pre') return null;
  const tone = TONE[view.tone];
  const inv = plan.invoice;
  const hasInv = plan.invoices.length > 0;
  const completed = !!plan.fromLog || plan.hhStatus === 11;

  const chargeNet = Math.round((parseFloat(charge?.amount || '') || 0) * 100) / 100;
  const raiseCharge = async () => {
    if (!charge) return;
    if (!charge.description.trim() || !charge.reason.trim() || !(chargeNet >= 0.01)) {
      setError('Give the charge a description, an amount and a reason.');
      return;
    }
    const gross = Math.round((chargeNet + Math.round(chargeNet * 20) / 100) * 100) / 100;
    if (!window.confirm(`Raise a charge invoice for ${money(gross)} inc VAT ("${charge.description.trim()}"), approve it and send it to Xero?`)) return;
    setBusy('run');
    setError(null);
    setNotice(null);
    try {
      const r = await api.post<{ data: CloseOutResult }>(`/close-out/${jobId}/charge`, {
        reason: charge.reason.trim(), lines: [{ type: 'misc', description: charge.description.trim(), amount: chargeNet }],
      });
      setResult(r.data);
      publishCloseOutPlan(jobId, r.data.plan);
      if (r.data.done) setCharge(null);
      onChanged?.();
    } catch (e) {
      if (lostReply(e)) { void waitForHireHop(plan); return; }
      setError(apiError(e, 'The charge was not raised.'));
      setBusy(null);
      return;
    }
    setBusy(null);
  };
  const addCharge: Act | null = completed && isManager && !charge
    ? { label: 'Add a charge', onClick: () => setCharge({ description: '', amount: '', reason: '' }), kind: 'secondary' }
    : null;

  const run = async () => {
    const what = view.stage === 'to_invoice'
      ? `Create the invoice for ${money(inv.netToInvoice)} ex VAT (dated today, approved, sent to Xero) and allocate the payments`
      : 'Allocate the payments to the invoice in HireHop and Xero';
    if (!window.confirm(`${what}${view.stillOut ? '\n\nHireHop still shows this job as out.' : ''}\n\nCarry on?`)) return;
    setBusy('run');
    setError(null);
    setNotice(null);
    try {
      const r = await api.post<{ data: CloseOutResult }>(`/close-out/${jobId}/run`, { allow_not_returned: view.stillOut });
      setResult(r.data);
      publishCloseOutPlan(jobId, r.data.plan);
      onChanged?.();
    } catch (e) {
      if (lostReply(e)) { void waitForHireHop(plan); return; }
      setError(apiError(e, 'That did not finish.'));
    }
    setBusy(null);
  };

  const setSent = async (sent: boolean) => {
    if (!plan.invoiceRequirementId) return;
    setBusy('sent');
    setError(null);
    try {
      await api.patch(`/requirements/${plan.invoiceRequirementId}`, { status: sent ? 'done' : 'in_progress' });
      await load(true);
    } catch (e) {
      setError(apiError(e, sent ? 'Could not mark it as sent.' : 'Could not undo.'));
      setBusy(null);
    }
  };

  // Several invoices owing: which one takes the hire payments. Only OP's own note — nothing
  // moves in HireHop or Xero until Allocate — so it saves as soon as it is picked.
  const saveTarget = async (invoiceId: number) => {
    if (!invoiceId || invoiceId === plan.paymentTarget?.invoiceId) return;
    setBusy('target');
    setError(null);
    try {
      const r = await api.post<{ data: CloseOutPlan }>(`/close-out/${jobId}/payment-target`, { invoice_id: invoiceId });
      publishCloseOutPlan(jobId, r.data);
    } catch (e) {
      setError(apiError(e, 'Could not save the choice.'));
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async () => {
    if (!portalUrl) return;
    try {
      await navigator.clipboard.writeText(portalUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy the payment link:', portalUrl);
    }
  };

  const checkAgain: Act = { label: busy === 'plan' ? 'Checking…' : 'Check again', onClick: () => void load(true), kind: 'link' };
  const copy: Act | null = portalUrl ? { label: copied ? 'Copied' : 'Copy payment link', onClick: () => void copyLink(), kind: 'link' } : null;

  // ── The bar: one line, the reason behind Why?, the buttons ──
  let title = '';
  let why = '';
  let sub = '';
  let acts: Act[] = [];
  const chips: Array<[ok: boolean, text: string]> = [];
  switch (view.stage) {
    case 'blocked':
      title = shortLine(view.blockers[0]) + (view.blockers.length > 1 ? ` (+${view.blockers.length - 1} more)` : '');
      why = view.blockers.join(' ');
      acts = [{ ...checkAgain, kind: 'primary' }];
      break;
    case 'to_invoice':
      title = hasInv ? `Invoice the ${money(inv.netToInvoice)} ex VAT added since` : 'Create the final invoice';
      why = 'Raises it in HireHop, sends it to Xero, and allocates the payments already received in both.'
        + (inv.euTrigger ? ' EU hire: the VAT is split by UK / non-UK days.' : '');
      acts = [checkAgain];
      if (isManager) acts.push({ label: view.stillOut ? 'Create invoice anyway (job still out)' : 'Create invoice', onClick: () => void run(), kind: view.stillOut ? 'amber' : 'primary' });
      chips.push(plan.hhStatus != null && plan.hhStatus >= 7 ? [true, 'All back'] : [false, plan.hhStatus === 6 ? 'Returned incomplete' : 'Still out in HireHop']);
      chips.push(plan.excessHeld < PENNY ? [true, 'No excess held'] : [false, `${money(plan.excessHeld)} excess held`]);
      if (plan.openProblems > 0) chips.push([false, `${plan.openProblems} open Problem${plan.openProblems === 1 ? '' : 's'}`]);
      break;
    case 'choose':
      title = `${view.open.length} invoices owing — which takes the hire payments?`;
      why = 'The hire payments are allocated to the invoice you choose, and only to it. The other (a separate damage invoice, say) is settled with an excess claim or Record payment, so the two stay apart.';
      acts = [];
      break;
    case 'to_allocate':
      title = 'Allocate the payments to the invoice';
      why = plan.sentences.join(' ');
      acts = [];
      if (isManager) acts.push({ label: 'Allocate', onClick: () => void run(), kind: 'primary' });
      break;
    case 'credit':
      title = `${money(view.credit)} overpaid — refund it or move it to another job`;
      why = 'The client has paid more than the invoices need. Use Refund or Apply to another job on that payment in Payment History below. OP never decides this for you.';
      acts = [];
      break;
    case 'to_send':
      title = 'Send the invoice to the client';
      sub = 'Email the invoice and payment link from your inbox, then tick it off.';
      acts = [...(copy ? [copy] : []), { label: busy === 'sent' ? 'Saving…' : '✓ Mark as sent', onClick: () => void setSent(true), kind: 'primary' }];
      break;
    case 'awaiting':
      title = completed ? `${money(view.owing)} owing` : 'Waiting on the client';
      why = 'A portal payment, a Wise transfer or Record payment is allocated to the invoice automatically, and this moves to Paid.';
      acts = [{ label: 'Undo sent', onClick: () => void setSent(false), kind: 'link' }, ...(copy ? [{ ...copy, kind: 'secondary' as const }] : [])];
      if (onRecordPayment) acts.push({ label: 'Record payment', onClick: onRecordPayment, kind: 'primary' });
      if (completed) acts = acts.filter(a => a.label !== 'Undo sent');
      break;
    case 'paid':
      title = 'Paid and reconciled';
      why = 'The money is done in HireHop and Xero. The job itself is not Completed yet: complete it once the hire\'s other loose ends are tied up.';
      acts = onRequestComplete ? [{ label: 'Complete the job', onClick: onRequestComplete, kind: 'secondary' }] : [];
      break;
    case 'complete':
      title = 'Hire complete';
      acts = plan.fromLog ? [{ ...checkAgain, label: busy === 'plan' ? 'Checking…' : 'Check HireHop again' }] : [];
      break;
  }
  if (addCharge) acts.unshift(addCharge);

  const btn = (a: Act) => {
    const base = 'text-sm font-semibold rounded-lg px-3.5 py-1.5 disabled:opacity-50';
    const cls = a.kind === 'primary' ? `${base} bg-ooosh-600 text-white hover:bg-ooosh-700`
      : a.kind === 'amber' ? `${base} border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100`
      : a.kind === 'secondary' ? `${base} border border-gray-300 bg-white text-gray-800 hover:bg-gray-50`
      : 'text-sm font-semibold text-ooosh-600 hover:text-ooosh-800 disabled:opacity-50';
    return <button key={a.label} onClick={a.onClick} disabled={busy != null} className={cls}>{busy === 'run' && (a.kind === 'primary' || a.kind === 'amber') ? 'Working…' : a.label}</button>;
  };

  const paidSoFar = plan.invoices.reduce((s, i) => s + (i.gross - i.owing), 0);
  const allInXero = plan.invoices.every(i => i.inXero);
  const stepDetail = (i: number): string => {
    if (i === 1 && hasInv) return plan.invoices.length === 1 ? plan.invoices[0].number : `${plan.invoices.length} invoices`;
    if (i === 2 && view.steps[2] === 'done') return allInXero ? 'HireHop ✓ Xero ✓' : 'HireHop ✓';
    if (i === 4 && hasInv && view.owing >= PENNY) return view.paid >= PENNY ? `${money(view.paid)} paid · ${money(view.owing)} owing` : 'Nothing paid yet';
    return '';
  };

  return (
    <div className={`bg-white rounded-xl shadow-sm border ${view.stage === 'blocked' ? 'border-red-200' : 'border-gray-200'}`}>
      {/* Header: title + one pill. The balance lives in the Financial Summary above. */}
      <div className="px-5 pt-4 pb-1 flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold text-gray-900">
          {plan.invoices.length === 1 ? `Invoice ${plan.invoices[0].number}` : plan.invoices.length > 1 ? 'Invoices' : 'Invoice'}
        </h3>
        <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${tone.pill}`}>{view.pill}</span>
      </div>

      {/* Five steps */}
      <div className="px-5 pt-3 pb-4 grid grid-cols-5 gap-0 overflow-x-auto">
        {view.steps.map((st, i) => (
          <div key={STEP_NAMES[i]} className="min-w-[96px]">
            <div className="flex items-center">
              <span className={`w-6 h-6 flex-none rounded-full grid place-items-center text-xs font-bold border-2 ${
                st === 'done' ? 'bg-green-600 border-green-600 text-white'
                : st === 'error' ? 'bg-red-600 border-red-600 text-white'
                : st === 'warn' ? 'border-amber-500 text-amber-700 bg-amber-50'
                : st === 'current' ? 'border-ooosh-600 text-ooosh-600 bg-white'
                : 'border-gray-300 text-gray-400 bg-white'}`}>
                {st === 'done' ? '✓' : st === 'error' ? '!' : i + 1}
              </span>
              {i < 4 && <span className={`h-0.5 flex-1 mx-1.5 ${st === 'done' ? 'bg-green-600' : 'bg-gray-200'}`} />}
            </div>
            <div className={`mt-2 pr-2 text-[13px] font-semibold ${st === 'todo' ? 'text-gray-400' : st === 'current' ? 'text-ooosh-600' : st === 'warn' ? 'text-amber-700' : st === 'error' ? 'text-red-700' : 'text-gray-900'}`}>{STEP_NAMES[i]}</div>
            {stepDetail(i) && <div className="pr-2 text-xs text-gray-500 mt-0.5">{stepDetail(i)}</div>}
          </div>
        ))}
      </div>

      {/* The next action — one line */}
      <div className={`border-t px-5 py-3 space-y-2 ${tone.bar}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-gray-900">
              {title}
              {why && (
                <button onClick={() => setShowWhy(v => !v)} className="ml-2 text-xs font-semibold text-ooosh-600 hover:text-ooosh-800" aria-expanded={showWhy}>
                  {showWhy ? 'Hide' : 'Why?'}
                </button>
              )}
            </div>
            {sub && <div className="text-sm text-gray-600 mt-0.5">{sub}</div>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {acts.map(btn)}
            {!isManager && (view.stage === 'to_invoice' || view.stage === 'to_allocate') && (
              <span className="text-xs text-gray-500">A manager creates the invoice</span>
            )}
            {!isManager && view.stage === 'choose' && <span className="text-xs text-gray-500">A manager chooses</span>}
          </div>
        </div>
        {why && showWhy && <p className="text-sm text-gray-600">{why}</p>}
        {view.open.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-700">Hire payments go to</span>
            {isManager ? (
              <select
                value={plan.paymentTarget?.invoiceId ?? ''}
                onChange={e => void saveTarget(Number(e.target.value))}
                disabled={busy != null}
                className={`rounded border px-2 py-1 text-sm ${plan.paymentTarget ? 'border-gray-300' : 'border-amber-400 bg-amber-50'}`}
              >
                {!plan.paymentTarget && <option value="">Choose an invoice…</option>}
                {view.open.map(i => <option key={i.invoiceId} value={i.invoiceId}>{i.number} · {money(i.owing)} owing</option>)}
              </select>
            ) : (
              <span className="font-semibold text-gray-900">{plan.paymentTarget?.number ?? 'not chosen yet'}</span>
            )}
            {busy === 'target' && <span className="text-xs text-gray-500">Saving…</span>}
            {plan.paymentTarget && <span className="text-xs text-gray-500">{view.open.length > 2 ? 'the others are' : 'the other is'} settled with an excess claim or Record payment</span>}
          </div>
        )}
        {charge && (
          <div className="rounded-lg border border-gray-200 bg-white p-3 grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <label className="text-xs text-gray-600 grid gap-1">On the invoice (the client reads this)
              <input id="charge-desc" value={charge.description} maxLength={200} onChange={e => setCharge({ ...charge, description: e.target.value })}
                className="rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900" placeholder="e.g. Replacement DI box" />
            </label>
            <label className="text-xs text-gray-600 grid gap-1">Amount ex VAT (£)
              <input id="charge-amount" value={charge.amount} inputMode="decimal" onChange={e => setCharge({ ...charge, amount: e.target.value })}
                className="rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900 tabular-nums" placeholder="0.00" />
            </label>
            <label className="text-xs text-gray-600 grid gap-1 sm:col-span-2">Reason (for us — goes on the job's timeline)
              <input id="charge-reason" value={charge.reason} maxLength={500} onChange={e => setCharge({ ...charge, reason: e.target.value })}
                className="rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900" placeholder="Why is this being charged?" />
            </label>
            <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-gray-500">Misc income · 20% VAT{chargeNet >= 0.01 ? ` · ${money(Math.round((chargeNet + Math.round(chargeNet * 20) / 100) * 100) / 100)} inc VAT` : ''} · its own invoice, approved and sent to Xero</span>
              <span className="flex items-center gap-3">
                <button onClick={() => setCharge(null)} disabled={busy != null} className="text-sm font-semibold text-gray-600 hover:text-gray-800">Cancel</button>
                <button onClick={() => void raiseCharge()} disabled={busy != null} className="text-sm font-semibold rounded-lg px-3.5 py-1.5 bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
                  {busy === 'run' ? 'Working…' : 'Raise charge invoice'}
                </button>
              </span>
            </div>
          </div>
        )}
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map(([ok, text]) => (
              <span key={text} className={`text-xs px-2.5 py-0.5 rounded-full border bg-white ${ok ? 'border-gray-200 text-gray-700' : 'border-amber-300 text-amber-800'}`}>
                <b className={`mr-1 ${ok ? 'text-green-600' : 'text-amber-600'}`}>{ok ? '✓' : '!'}</b>{text}
              </span>
            ))}
          </div>
        )}
        {notice && <p className="text-sm text-gray-700">{notice}</p>}
        {result && <p className={`text-sm ${result.done ? 'text-green-800' : 'text-red-800'}`}>{result.message}</p>}
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>

      {/* How the invoice total was reached */}
      {hasInv && (
        <div className="border-t border-gray-200 px-5 py-2 text-sm">
          {plan.invoices.map(i => (
            <div key={i.invoiceId} className="flex justify-between gap-3 py-1.5 border-b border-gray-100">
              <span className="text-gray-800">{i.number} <span className="text-xs text-gray-500">{fmtDay(i.date)}</span>
                {i.chargeOnly && <span className="ml-2 text-xs text-gray-500">charge after completion</span>}</span>
              <span className="tabular-nums">
                {plan.invoices.length > 1 && <span className={`mr-2 text-xs ${i.owing >= PENNY ? 'text-amber-700' : 'text-green-700'}`}>{i.owing >= PENNY ? `${money(i.owing)} owing` : 'paid'}</span>}
                <span className="font-semibold">{money(i.gross)}</span>
              </span>
            </div>
          ))}
          {paidSoFar >= PENNY && (
            <div className="flex justify-between gap-3 py-1.5 border-b border-gray-100">
              <span className="text-gray-800">Payments allocated <span className="text-xs font-semibold text-green-700 ml-1">{allInXero ? 'HireHop ✓ Xero ✓' : 'HireHop ✓'}</span></span>
              <span className="tabular-nums">−{money(paidSoFar)}</span>
            </div>
          )}
          <div className="pt-2 text-xs">
            <button onClick={() => void load(true)} disabled={busy != null} className="font-semibold text-ooosh-600 hover:text-ooosh-800 disabled:opacity-50">
              {busy === 'plan' ? 'Checking…' : 'Check again'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
