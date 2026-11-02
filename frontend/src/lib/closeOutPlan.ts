/**
 * closeOutPlan — one read of the hire close-out plan per job, shared by the
 * Money tab's close-out panel, the Overview's Invoice card and the Money tab's
 * dot (HIRE-CLOSE-OUT-SPEC.md §3).
 *
 * The plan is a live read of HireHop (two calls), so three places fetching it
 * independently would triple the load on every job view. This keeps the
 * in-flight promise and the last result per job for a short while, and lets
 * one place tell the others when an action changed things.
 *
 * `closeOutView()` turns a plan into the one stage / pill / step list all
 * three draw, so they can never disagree.
 */
import { api } from '../services/api';

export interface CloseOutInvoice {
  invoiceId: number; number: string; status: number; date: string; gross: number; owing: number; inXero: boolean;
  /** Raised after completion from custom lines (spec §4.6) — not in the hire total. */
  chargeOnly?: boolean;
}
export interface CloseOutPayment { depositId: number; bankName: string | null; description: string; date: string; credit: number; available: number }
export interface CloseOutLogEntry { id: string; step: string; ok: boolean; detail: string; user_name: string | null; created_at: string }
export interface InvoicePlan {
  accruedNet: number;
  invoicedNet: number;
  netToInvoice: number;
  draft: CloseOutInvoice | null;
  euTrigger: boolean;
  notReturned: boolean;
  blockers: string[];
  ready: boolean;
}
export interface CloseOutPlan {
  hhJobNumber: number;
  /** OP's own record of a Completed job — no HireHop read. "Check again" forces one. */
  fromLog?: boolean;
  hhStatus: number | null;
  invoice: InvoicePlan;
  invoices: CloseOutInvoice[];
  payments: CloseOutPayment[];
  allocations: Array<{ depositId: number; amount: number; invoiceNumber: string }>;
  surplus: Array<{ depositId: number; amount: number }>;
  shortfall: number;
  excessHeld: number;
  blockers: string[];
  warnings: string[];
  sentences: string[];
  ready: boolean;
  readyToComplete: boolean;
  log: CloseOutLogEntry[];
  /** OP's Invoice requirement — "Mark as sent" ticks it Done. */
  invoiceRequirementId: string | null;
  invoiceSent: boolean;
  openProblems: number;
  /** Several invoices owing: the one a manager chose for the hire payments; null = not chosen (or nothing to choose). */
  paymentTarget: { invoiceId: number; number: string } | null;
  /** A cancelled job (CANCELLATION-SPEC.md, the money end): the invoice is the fee; null otherwise. */
  cancellation?: CancellationPlan | null;
}
export interface CancellationPlan {
  /** The retained fee ex VAT (transport and crew included) and inc VAT. */
  feeNet: number;
  feeGross: number;
  cancelledAt: string | null;
  /** The fee is on an approved invoice (or there is no fee). */
  invoiced: boolean;
  /** OP's pending refund reminders — what the Money tab's Process button acts on. */
  refundReminders: Array<{ id: string; amount: number }>;
  /** Fee invoiced and paid, nothing left on a hire payment. */
  settled: boolean;
}
export interface CloseOutResult { done: boolean; message: string; plan: CloseOutPlan }

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; promise: Promise<CloseOutPlan> }>();
const listeners = new Map<string, Set<(plan: CloseOutPlan) => void>>();

/** Read the plan — from the last fetch if it is under 30 s old, unless `force`. */
export function loadCloseOutPlan(jobId: string, force = false): Promise<CloseOutPlan> {
  const hit = cache.get(jobId);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = api.get<{ data: CloseOutPlan }>(`/close-out/${jobId}/plan${force ? '?fresh=1' : ''}`).then(r => {
    publish(jobId, r.data);
    return r.data;
  });
  promise.catch(() => cache.delete(jobId));
  cache.set(jobId, { at: Date.now(), promise });
  return promise;
}

/** An action returned a fresh plan — hand it to every card on the job. */
export function publishCloseOutPlan(jobId: string, plan: CloseOutPlan): void {
  cache.set(jobId, { at: Date.now(), promise: Promise.resolve(plan) });
  publish(jobId, plan);
}

export function subscribeCloseOutPlan(jobId: string, cb: (plan: CloseOutPlan) => void): () => void {
  if (!listeners.has(jobId)) listeners.set(jobId, new Set());
  listeners.get(jobId)!.add(cb);
  return () => { listeners.get(jobId)?.delete(cb); };
}

function publish(jobId: string, plan: CloseOutPlan) {
  listeners.get(jobId)?.forEach(cb => cb(plan));
}

export const money = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtDay = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
export const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
};
export const apiError = (e: unknown, fallback: string) =>
  (e as any)?.body?.error || (e as any)?.message || fallback;

/** The steps of raising an invoice (a hire's, or a cancellation fee's) that can stop with a draft still in HireHop. */
const DRAFT_STEPS = new Set(['invoice_draft', 'invoice_penny', 'vat_split', 'invoice_approve', 'cancel_fee']);

/**
 * The last press that stopped part-way through raising the invoice, while a draft is still
 * in HireHop — null once a later press got past that point, or the draft has gone. The plan
 * is rebuilt from HireHop on every read, so without this a stop's reason vanished as soon as
 * the page was left: the next person saw "Ready to invoice" beside a draft nobody explained
 * (job 16724, 20 Oct 2026). `plan.log` is newest first.
 */
export function lastInvoiceStop(plan: CloseOutPlan): CloseOutLogEntry | null {
  if (!plan.invoice.draft) return null;
  const last = (plan.log ?? []).find(l => DRAFT_STEPS.has(l.step));
  return last && !last.ok ? last : null;
}

// ── One view of a plan, for the panel, the Overview card and the tab dot ──

const PENNY = 0.005;
const HH_RETURNED_INCOMPLETE = 6;
const HH_COMPLETED = 11;

/**
 * One colour scale for the steps: grey still to come · blue the one in hand ·
 * amber in hand but worth a look (money still owed on a Completed job) · red only
 * when OP refuses to go on · green done.
 */
export type StepState = 'done' | 'current' | 'warn' | 'todo' | 'error';
export type CloseOutStage =
  | 'pre'          // not back yet, nothing invoiced — the panel is not shown
  | 'blocked'      // OP refuses until something is sorted
  | 'to_invoice' | 'choose' | 'to_allocate' | 'credit' | 'to_send' | 'awaiting' | 'paid' | 'complete'
  // A cancelled job only: money to go back to the client · the money is done.
  | 'refund' | 'settled';
export type CloseOutTone = 'grey' | 'amber' | 'blue' | 'green' | 'red';

export interface CloseOutView {
  stage: CloseOutStage;
  tone: CloseOutTone;
  pill: string;
  /** Returned · Invoiced · Payments allocated · Sent to client · Paid in full. */
  steps: StepState[];
  stepsDone: number;
  /** What every refusal says, in full ("Why?"), and the short line for the bar. */
  blockers: string[];
  /** Still owed across the job's approved invoices. */
  owing: number;
  /** Hire money held beyond what the invoices need. */
  credit: number;
  /** Paid so far across the approved invoices. */
  paid: number;
  /** Of `owing`, what sits on charge invoices raised after completion (not in the Financial Summary). */
  chargeOwing: number;
  /** HireHop still shows the job out — a manager may invoice anyway. */
  stillOut: boolean;
  /** Invoices owing, oldest first — more than one means the hire payments need a target. */
  open: CloseOutInvoice[];
  /** The five steps' names — a cancelled job's differ (CANCEL_STEP_NAMES). */
  stepNames: readonly string[];
}

export const STEP_NAMES = ['Returned', 'Invoiced', 'Payments allocated', 'Sent to client', 'Paid in full'] as const;
export const CANCEL_STEP_NAMES = ['Cancelled', 'Fee invoiced', 'Payments allocated', 'Refunded / paid', 'Sent to client'] as const;

/** The first clause of one of OP's refusal sentences — the bar's one line; the rest sits behind "Why?". */
export const shortLine = (s: string) => s.split(' — ')[0].split('. ')[0].replace(/[.:]$/, '');

export function closeOutView(plan: CloseOutPlan, opts: { isManager: boolean }): CloseOutView {
  if (plan.cancellation) return cancellationView(plan, plan.cancellation);
  const inv = plan.invoice;
  const completed = !!plan.fromLog || plan.hhStatus === HH_COMPLETED;
  const returned = completed || (plan.hhStatus != null && plan.hhStatus >= HH_RETURNED_INCOMPLETE);
  const hasInv = plan.invoices.length > 0;
  const needsInvoice = !plan.fromLog && (inv.netToInvoice >= PENNY || inv.draft != null);
  const owing = plan.invoices.reduce((s, i) => s + i.owing, 0);
  const credit = plan.surplus.reduce((s, x) => s + x.amount, 0);
  const onlyNotReturned = inv.blockers.length === 1 && inv.notReturned;
  const stillOut = onlyNotReturned && opts.isManager && needsInvoice;
  const open = plan.invoices.filter(i => i.owing >= PENNY);
  // Several owing and nobody has said which takes the hire payments: a choice, not a refusal.
  const needsTarget = open.length > 1 && !plan.paymentTarget;
  // "Raise the invoice first" is this panel's own job to clear, not a refusal.
  const blockers = plan.blockers.filter(b => !b.startsWith('Raise the invoice first') && !b.includes('choose which one the hire payments go to'))
    .concat(stillOut ? [] : inv.blockers);

  let steps: StepState[] = completed && plan.fromLog
    ? ['done', 'done', 'done', 'done', 'done']
    : [
        returned ? 'done' : 'todo',
        hasInv && !needsInvoice ? 'done' : 'todo',
        hasInv && !needsInvoice && !needsTarget && plan.allocations.length === 0 ? 'done' : 'todo',
        plan.invoiceSent ? 'done' : 'todo',
        hasInv && !needsInvoice && owing < PENNY ? 'done' : 'todo',
      ];
  let stage: CloseOutStage;
  // A Completed job can still owe: a charge invoice raised after completion (spec §4.6).
  if (completed) stage = owing >= PENNY ? 'awaiting' : credit >= PENNY ? 'credit' : 'complete';
  // Before the hire is back nothing is due unless someone has already started an invoice.
  else if (!returned && !hasInv && inv.draft == null) stage = 'pre';
  else if (blockers.length) stage = 'blocked';
  else if (needsInvoice) stage = 'to_invoice';
  else if (needsTarget) stage = 'choose';
  else if (plan.ready) stage = 'to_allocate';
  else if (credit >= PENNY) stage = 'credit';
  else if (!plan.invoiceSent) stage = 'to_send';
  else if (owing >= PENNY) stage = 'awaiting';
  else stage = 'paid';

  // The first step not done is the one in hand. Red only when OP refuses to go on —
  // money still owed on a Completed job is worth a look, not an error.
  const first = steps.findIndex(s => s !== 'done');
  const hand: StepState = stage === 'blocked' ? 'error' : completed && owing >= PENNY ? 'warn' : 'current';
  if (first >= 0) steps = steps.map((s, i) => (i === first ? hand : s));
  const paid = plan.invoices.reduce((s, i) => s + (i.gross - i.owing), 0);
  const chargeOwing = plan.invoices.filter(i => i.chargeOnly).reduce((s, i) => s + i.owing, 0);

  const look: Record<CloseOutStage, [CloseOutTone, string]> = {
    pre: ['grey', 'Not back yet'],
    blocked: ['red', 'Needs sorting'],
    to_invoice: ['amber', 'Ready to invoice'],
    choose: ['amber', 'Choose an invoice'],
    to_allocate: ['amber', 'Payments to allocate'],
    credit: ['amber', 'Money to sort'],
    to_send: ['amber', 'Not sent yet'],
    awaiting: [completed ? 'amber' : 'blue', 'Awaiting payment'],
    paid: ['green', 'Paid'],
    complete: ['green', 'Completed'],
    refund: ['amber', 'Refund due'],      // a cancelled job's — never reached here
    settled: ['green', 'Settled'],
  };
  return {
    stage, tone: look[stage][0], pill: look[stage][1], steps,
    stepsDone: steps.filter(s => s === 'done').length,
    blockers, owing, credit, paid, chargeOwing, stillOut, open, stepNames: STEP_NAMES,
  };
}

/**
 * A cancelled job: Cancelled · Fee invoiced · Payments allocated · Refunded / paid · Sent.
 * The fee invoice is raised and allocated by the same button as a hire's; what is left
 * on the hire payments afterwards is a refund (`credit`), pressed through the Money tab's
 * existing refund flow; the job is never completed.
 */
function cancellationView(plan: CloseOutPlan, c: CancellationPlan): CloseOutView {
  const inv = plan.invoice;
  const owing = plan.invoices.reduce((s, i) => s + i.owing, 0);
  const credit = plan.surplus.reduce((s, x) => s + x.amount, 0);
  const open = plan.invoices.filter(i => i.owing >= PENNY);
  const needsInvoice = inv.netToInvoice >= PENNY;
  const noFee = c.feeNet < PENNY;
  const blockers = plan.blockers.filter(b => !b.startsWith('Raise the invoice first') && !b.includes('choose which one the hire payments go to'))
    .concat(inv.blockers.filter(b => !plan.blockers.includes(b)));

  let steps: StepState[] = [
    'done',
    c.invoiced ? 'done' : 'todo',
    c.invoiced && plan.allocations.length === 0 ? 'done' : 'todo',
    c.invoiced && plan.allocations.length === 0 && credit < PENNY && owing < PENNY ? 'done' : 'todo',
    noFee || plan.invoiceSent ? 'done' : 'todo',
  ];
  let stage: CloseOutStage;
  if (blockers.length) stage = 'blocked';
  else if (needsInvoice) stage = 'to_invoice';
  else if (open.length > 1 && !plan.paymentTarget) stage = 'choose';
  else if (plan.ready) stage = 'to_allocate';
  else if (credit >= PENNY) stage = 'refund';
  else if (owing >= PENNY) stage = 'awaiting';
  else if (!noFee && !plan.invoiceSent) stage = 'to_send';
  else stage = 'settled';

  const first = steps.findIndex(s => s !== 'done');
  if (first >= 0) steps = steps.map((s, i) => (i === first ? (stage === 'blocked' ? 'error' : 'current') : s));
  const look: Partial<Record<CloseOutStage, [CloseOutTone, string]>> = {
    blocked: ['red', 'Needs sorting'],
    to_invoice: ['amber', 'Fee to invoice'],
    choose: ['amber', 'Choose an invoice'],
    to_allocate: ['amber', 'Payments to allocate'],
    refund: ['amber', 'Refund due'],
    awaiting: ['blue', 'Fee owing'],
    to_send: ['amber', 'Not sent yet'],
    settled: ['green', 'Settled'],
  };
  const [tone, pill] = look[stage]!;
  return {
    stage, tone, pill, steps,
    stepsDone: steps.filter(s => s === 'done').length,
    blockers, owing, credit,
    paid: plan.invoices.reduce((s, i) => s + (i.gross - i.owing), 0),
    chargeOwing: 0, stillOut: false, open, stepNames: CANCEL_STEP_NAMES,
  };
}

/** Tailwind classes per tone — one place, so the pill, bar and dot match. */
export const TONE = {
  grey:  { pill: 'bg-gray-100 text-gray-600',   bar: 'bg-gray-50 border-gray-200',   dot: 'bg-gray-400',  border: 'border-gray-200' },
  amber: { pill: 'bg-amber-100 text-amber-800', bar: 'bg-amber-50 border-amber-200', dot: 'bg-amber-500', border: 'border-amber-300' },
  blue:  { pill: 'bg-blue-100 text-blue-800',   bar: 'bg-blue-50 border-blue-200',   dot: 'bg-blue-500',  border: 'border-blue-300' },
  green: { pill: 'bg-green-100 text-green-700', bar: 'bg-green-50 border-green-200', dot: 'bg-green-500', border: 'border-green-300' },
  red:   { pill: 'bg-red-100 text-red-700',     bar: 'bg-red-50 border-red-200',     dot: 'bg-red-500',   border: 'border-red-300' },
} as const;
