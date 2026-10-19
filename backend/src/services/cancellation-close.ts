/**
 * cancellation-close.ts — the money end of a cancelled job (docs/CANCELLATION-SPEC.md,
 * "Oct 2026 — the money end").
 *
 * A cancelled job owes its CANCELLATION FEE, not the hire. HireHop keeps the hire's
 * lines on the job (status 9 frees the stock; the lines stay as the record of what was
 * booked, and Re-open duplicates them), so its job total still reads the full hire.
 * The truthful figures are the fee invoice and the payments against it. This file is
 * what is cancellation-specific; the close-out module (hire-close-out.ts) plans and
 * allocates exactly as for a hire, and the HireHop/Xero mechanics are the shared
 * recipe (hh-invoice-close.ts).
 *
 * Settled with jon, 14 Oct 2026:
 *   - the fee invoice is ONE custom line on Misc income (190) at 20%, transport and
 *     crew included — nothing was supplied, so it is not the hire's lines;
 *   - deposits are allocated up to the fee only, so the rest stays refundable (a
 *     fully-applied deposit cannot be refunded — HireHop error 370);
 *   - the rest goes back through the existing refund route, pressed by a person;
 *   - excess is the Excess card's business, never this;
 *   - the job stays Cancelled (HireHop 9) — it is never completed.
 *
 * Deliberately imports nothing from hire-close-out.ts at run time (that file imports
 * this one).
 */
import { query } from '../config/database';
import {
  PENNY, round2, gbp, CloseReporter, Row, MISC_INCOME_NOMINAL, customLineGross, raiseCustomLineInvoice,
  invoiceRows, invoiceStatus, invoiceNet, isChargeOnlyInvoice,
} from './hh-invoice-close';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const HH_CANCELLED = 9;
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/** The fee's one line: Misc income at 20% (jon, 14 Oct 2026). */
const FEE_RATE = 20;
const FEE_TAX_ID = 20;

/** What OP recorded when the job was cancelled (the modal's figures). */
export interface CancellationFacts {
  /** The retained fee EX VAT, transport and crew included (`jobs.cancellation_fee`). */
  feeNet: number;
  /** The same inc VAT, rounded as HireHop rounds one line. */
  feeGross: number;
  cancelledAt: string | null;
  jobDate: string | null;
  jobEnd: string | null;
}

/** OP's own reminder that a refund is due (`job_payments`, refund, pending). */
export interface RefundReminder { id: string; amount: number }

/** The cancellation half of the close-out plan. */
export interface CancellationPlan extends CancellationFacts {
  /** The fee is on an approved invoice (or there is no fee to invoice). */
  invoiced: boolean;
  /** OP's pending refund reminder(s) on the job. */
  refundReminders: RefundReminder[];
  /** Fee invoiced and paid, nothing left on a hire payment — the money is done. */
  settled: boolean;
}

/** The fee inc VAT — one line at 20%, rounded per line as HireHop does. */
export const cancellationFeeGross = (feeNet: number) => customLineGross({ amount: round2(feeNet), rate: FEE_RATE });

export async function readCancellation(jobId: string): Promise<CancellationFacts> {
  const r = await query(
    `SELECT cancellation_fee, cancelled_at, job_date, job_end FROM jobs WHERE id = $1`,
    [jobId],
  );
  const row = r.rows[0] || {};
  const feeNet = round2(Number(row.cancellation_fee ?? 0) || 0);
  return {
    feeNet,
    feeGross: cancellationFeeGross(feeNet),
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
    jobDate: row.job_date ? new Date(row.job_date).toISOString() : null,
    jobEnd: row.job_end ? new Date(row.job_end).toISOString() : null,
  };
}

export async function readRefundReminders(jobId: string): Promise<RefundReminder[]> {
  const r = await query(
    `SELECT id, amount FROM job_payments
      WHERE job_id = $1 AND payment_type = 'refund' AND payment_status = 'pending'
      ORDER BY payment_date`,
    [jobId],
  );
  return r.rows.map((x: any) => ({ id: String(x.id), amount: round2(Number(x.amount)) }));
}

const isProforma = (row: Row) => String(row.data?.DESCRIPTION || row.desc || '').toLowerCase().includes('proforma');
const approvedRows = (rows: Row[]) => invoiceRows(rows).filter((r) => invoiceStatus(r) >= 2 && !isProforma(r));

/** The fee invoice(s): approved, custom lines only. */
export const feeInvoiceRows = (rows: Row[]) => approvedRows(rows).filter(isChargeOnlyInvoice);
/** An approved invoice with the hire's own lines on it — the hire was invoiced before it was cancelled. */
export const hireInvoiceRows = (rows: Row[]) => approvedRows(rows).filter((r) => !isChargeOnlyInvoice(r));

const day = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
};

/** What the client reads on the invoice. */
export function feeLineDescription(f: CancellationFacts): string {
  const hire = [day(f.jobDate), day(f.jobEnd)].filter(Boolean);
  // Short on purpose: HireHop keeps only the first 80 characters of a line (CUSTOM_LINE_MAX).
  // The cancellation date, not the hire dates — the invoice already prints Job Start / Job
  // Finish (jon, 14 Oct 2026). Hire dates only when no cancellation date is recorded.
  if (f.cancelledAt) return `Cancellation fee (T&Cs clause 7) - cancelled ${day(f.cancelledAt)}`;
  const parts = ['Cancellation fee (T&Cs clause 7)'];
  if (hire.length) parts.push(`hire ${hire.length === 2 && hire[0] !== hire[1] ? `${hire[0]} to ${hire[1]}` : hire[0]}`);
  return parts.join(' - ');
}

/**
 * The Invoice half of the plan for a cancelled job: the fee, not the hire. Same shape as
 * the hire's (`InvoicePlan`) so the panel and the run path read it the same way.
 * `planBlockers` are the refusals that stop allocation too (a hire invoice on the job).
 */
export function planCancellationInvoice(rows: Row[], hhStatus: number | null, facts: CancellationFacts, hhJobNumber: number) {
  const blockers: string[] = [];
  const planBlockers: string[] = [];
  const warnings: string[] = [];
  const fee = feeInvoiceRows(rows);
  const invoicedNet = round2(fee.reduce((s, r) => s + (invoiceNet(r) ?? 0), 0));
  const invoiced = fee.length > 0 || facts.feeNet < PENNY;
  const netToInvoice = invoiced ? 0 : facts.feeNet;

  const hire = hireInvoiceRows(rows);
  if (hire.length) {
    const numbers = hire.map((r) => String(r.data?.NUMBER || r.number || r.data?.ID)).join(', ');
    planBlockers.push(`The hire was invoiced before it was cancelled (${numbers}) — that needs a credit note, which OP doesn't raise. `
      + 'Credit it by hand in HireHop, then press Check again.');
  }
  if (!invoiced) {
    if (invoiceRows(rows).some((r) => invoiceStatus(r) === 0 && !isProforma(r))) {
      blockers.push(`Job ${hhJobNumber} has a draft invoice in HireHop — approve or delete it there first.`);
    }
    if (hhStatus !== HH_CANCELLED) {
      blockers.push(`HireHop doesn't show job ${hhJobNumber} as Cancelled (status ${hhStatus ?? 'unknown'}) — set it there first.`);
    }
  }
  if (fee.length && Math.abs(invoicedNet - facts.feeNet) >= PENNY) {
    warnings.push(`The fee invoice comes to ${gbp(invoicedNet)} ex VAT; the fee recorded at cancellation was ${gbp(facts.feeNet)}.`);
  }
  blockers.push(...planBlockers);
  return {
    invoice: {
      accruedNet: facts.feeNet, invoicedNet, netToInvoice, draft: null, euTrigger: false, notReturned: false,
      blockers, ready: blockers.length === 0 && netToInvoice >= PENNY,
    },
    planBlockers, warnings, invoiced,
  };
}

/**
 * Raise the fee invoice on the shared recipe (empty draft → one Misc line → penny check →
 * approve today → Xero), log it and put it on the job's timeline. The caller has run
 * the pre-flight (planCancellationInvoice) and holds the job lock.
 */
export async function raiseCancellationFee(rep: CloseReporter, input: {
  jobId: string; hhJobNumber: number; facts: CancellationFacts; userId: string | null;
}): Promise<string> {
  const { jobId, hhJobNumber, facts } = input;
  const description = feeLineDescription(facts);
  const { number, gross } = await raiseCustomLineInvoice(rep, {
    hhJobNumber, step: 'cancel_fee',
    lines: [{ description, amount: facts.feeNet, rate: FEE_RATE, taxId: FEE_TAX_ID, nominalId: MISC_INCOME_NOMINAL }],
    xeroLabel: 'cancellation fee', alert: { jobId, what: 'cancellation fee invoice' },
  });
  await rep.log('cancel_fee', true, `Cancellation fee invoice ${number} raised for ${gbp(gross)} (${gbp(facts.feeNet)} + VAT).`);
  await query(
    `INSERT INTO interactions (job_id, type, content, created_by, source) VALUES ($1, 'note', $2, $3, 'system')`,
    [jobId, `🧾 Cancellation fee invoice ${number} raised: ${gbp(gross)} inc VAT ("${description}").`, input.userId || SYSTEM_USER_ID],
  ).catch((e) => console.warn('[cancellation-close] timeline note failed:', e));
  return `Fee invoice ${number} raised for ${gbp(gross)} and sent to Xero.`;
}

/**
 * Keep OP's refund reminder equal to what is really left to refund. The cancellation
 * modal creates it with its own estimate; after allocation the true figure is the money
 * still free on the hire payments. One reminder → its amount follows; none → one is made;
 * more than one → left for a person. Never moves money — the reminder is what the Money
 * tab's Process button and the Money overview's "Pending refunds" list read.
 */
export async function syncRefundReminder(jobId: string, refundDue: number, userId: string | null): Promise<string | null> {
  const due = round2(refundDue);
  const reminders = await readRefundReminders(jobId);
  if (reminders.length > 1) {
    return `OP has ${reminders.length} pending refunds on this job — check they add up to ${gbp(due)}.`;
  }
  const [one] = reminders;
  if (!one) {
    if (due < PENNY) return null;
    await query(
      `INSERT INTO job_payments (job_id, payment_type, amount, payment_method, payment_status, notes, recorded_by)
       VALUES ($1, 'refund', $2, 'bank_transfer', 'pending', $3, $4)`,
      [jobId, due, 'Cancellation refund — what is left after the cancellation fee', userId],
    );
    return `A pending refund of ${gbp(due)} is on the Money tab — press Process on it to refund the client.`;
  }
  if (due < PENNY) {
    return `Nothing is left to refund, but OP still has a pending refund of ${gbp(one.amount)} — clear it on the Money tab if it is no longer due.`;
  }
  if (Math.abs(one.amount - due) >= PENNY) {
    await query(
      `UPDATE job_payments SET amount = $2,
              notes = COALESCE(notes, '') || $3
        WHERE id = $1 AND payment_status = 'pending'`,
      [one.id, due, ` [amount set to ${gbp(due)} after the fee was allocated — was ${gbp(one.amount)}]`],
    );
    return `The pending refund on the Money tab is now ${gbp(due)} (was ${gbp(one.amount)}) — press Process on it to refund the client.`;
  }
  return `The pending refund of ${gbp(due)} on the Money tab is ready — press Process on it to refund the client.`;
}

/**
 * A settled cancellation ticks its "Payment Reconciliation" card (made at cancellation as
 * "Process refund of £x"). For a hire the derivation engine ticks it once the invoices owe
 * nothing; a cancellation is only reconciled once the refund has ALSO gone, which only the
 * plan knows — so the plan ticks it. Idempotent; never un-ticks.
 */
export async function markCancellationReconciled(jobId: string): Promise<void> {
  await query(
    `UPDATE job_requirements SET status = 'done', updated_at = NOW()
      WHERE job_id = $1 AND requirement_type = 'payment_reconcile' AND phase = 'post_hire'
        AND status NOT IN ('done', 'cancelled')`,
    [jobId],
  ).catch((e) => console.warn('[cancellation-close] could not tick Payment Reconciliation:', e));
}
