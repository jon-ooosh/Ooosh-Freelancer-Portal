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

export interface CloseOutInvoice { invoiceId: number; number: string; status: number; date: string; gross: number; owing: number; inXero: boolean }
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

// ── One view of a plan, for the panel, the Overview card and the tab dot ──

const PENNY = 0.005;
const HH_RETURNED_INCOMPLETE = 6;
const HH_COMPLETED = 11;

export type StepState = 'done' | 'current' | 'todo' | 'error';
export type CloseOutStage =
  | 'pre'          // not back yet, nothing invoiced — the panel is not shown
  | 'blocked'      // OP refuses until something is sorted
  | 'to_invoice' | 'to_allocate' | 'credit' | 'to_send' | 'awaiting' | 'paid' | 'complete';
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
  /** HireHop still shows the job out — a manager may invoice anyway. */
  stillOut: boolean;
}

export const STEP_NAMES = ['Returned', 'Invoiced', 'Payments allocated', 'Sent to client', 'Paid in full'] as const;

/** The first clause of one of OP's refusal sentences — the bar's one line; the rest sits behind "Why?". */
export const shortLine = (s: string) => s.split(' — ')[0].split('. ')[0].replace(/[.:]$/, '');

export function closeOutView(plan: CloseOutPlan, opts: { isManager: boolean }): CloseOutView {
  const inv = plan.invoice;
  const completed = !!plan.fromLog || plan.hhStatus === HH_COMPLETED;
  const returned = completed || (plan.hhStatus != null && plan.hhStatus >= HH_RETURNED_INCOMPLETE);
  const hasInv = plan.invoices.length > 0;
  const needsInvoice = !plan.fromLog && (inv.netToInvoice >= PENNY || inv.draft != null);
  const owing = plan.invoices.reduce((s, i) => s + i.owing, 0);
  const credit = plan.surplus.reduce((s, x) => s + x.amount, 0);
  const onlyNotReturned = inv.blockers.length === 1 && inv.notReturned;
  const stillOut = onlyNotReturned && opts.isManager && needsInvoice;
  // "Raise the invoice first" is this panel's own job to clear, not a refusal.
  const blockers = plan.blockers.filter(b => !b.startsWith('Raise the invoice first'))
    .concat(stillOut ? [] : inv.blockers);

  let steps: StepState[] = completed && plan.fromLog
    ? ['done', 'done', 'done', 'done', 'done']
    : [
        returned ? 'done' : 'todo',
        hasInv && !needsInvoice ? 'done' : 'todo',
        hasInv && !needsInvoice && plan.allocations.length === 0 ? 'done' : 'todo',
        plan.invoiceSent ? 'done' : 'todo',
        hasInv && !needsInvoice && owing < PENNY ? 'done' : 'todo',
      ];
  const first = steps.findIndex(s => s !== 'done');
  if (first >= 0) steps = steps.map((s, i) => (i === first ? (blockers.length ? 'error' : 'current') : s));

  let stage: CloseOutStage;
  if (completed) stage = 'complete';
  // Before the hire is back nothing is due unless someone has already started an invoice.
  else if (!returned && !hasInv && inv.draft == null) stage = 'pre';
  else if (blockers.length) stage = 'blocked';
  else if (needsInvoice) stage = 'to_invoice';
  else if (plan.ready) stage = 'to_allocate';
  else if (credit >= PENNY) stage = 'credit';
  else if (!plan.invoiceSent) stage = 'to_send';
  else if (owing >= PENNY) stage = 'awaiting';
  else stage = 'paid';

  const look: Record<CloseOutStage, [CloseOutTone, string]> = {
    pre: ['grey', 'Not back yet'],
    blocked: ['red', 'Needs sorting'],
    to_invoice: ['amber', 'Ready to invoice'],
    to_allocate: ['amber', 'Payments to allocate'],
    credit: ['amber', 'Money to sort'],
    to_send: ['amber', 'Not sent yet'],
    awaiting: ['blue', 'Awaiting payment'],
    paid: ['green', 'Paid'],
    complete: ['green', 'Completed'],
  };
  return {
    stage, tone: look[stage][0], pill: look[stage][1], steps,
    stepsDone: steps.filter(s => s === 'done').length,
    blockers, owing, credit, stillOut,
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
