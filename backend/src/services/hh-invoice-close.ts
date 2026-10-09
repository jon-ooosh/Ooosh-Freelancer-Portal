/**
 * hh-invoice-close.ts — THE recipe for settling a HireHop invoice end to end
 * (docs/reference/HIREHOP-BILLING-API.md §8), shared by the shop's weekly close
 * (shop-close.ts) and the hire close-out (docs/HIRE-CLOSE-OUT-SPEC.md).
 *
 *   draft → approve → invoice to Xero → allocate payments in HireHop →
 *   apply the credits in Xero ourselves → read Xero back → complete the job
 *
 * This file holds the HireHop/Xero mechanics only: how to read a job's billing
 * rows, and one function per write, each of which READS BACK before believing
 * anything (`success: true` has twice meant nothing — §0). What it does NOT
 * hold is any caller's own state, pre-flight or wording: the caller passes a
 * `CloseReporter` that logs each step where it keeps its log, throws `Stop`
 * when the recipe must halt, and says how the person resumes ("press Close").
 *
 * Lifted from shop-close.ts in Oct 2026 with the shop's behaviour unchanged —
 * its tests (shop-close.test.ts) are the regression suite for this file too.
 */
import hhBroker from './hirehop-broker';
import { readBillingRows, readDepositAvailability } from './hh-deposit-release';
import { syncSavedRowToXero, sendXeroSyncFailedAlert } from './hh-xero-sync';
import xeroBroker from './xero-broker';
import { isXeroConfigured } from '../config/xero';
import { londonDate } from './shop-period';
import { hhLocalNow } from './shop-stock';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Row = Record<string, any>;

export const PENNY = 0.005;
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const gbp = (n: number) => `£${n.toFixed(2)}`;

/** HireHop job status the recipe sets. */
export const HH_COMPLETED = 11;

/** Thrown by `reporter.stop()`: the recipe halted on purpose and said why. */
export class Stop extends Error {}

/**
 * How a caller hears from the recipe. `log` records a step where the caller
 * keeps its log; `stop` records a failed step and throws `Stop`; `retryHint`
 * is how the person carries on afterwards, as a lower-case verb phrase the
 * messages can embed ("press Close", "press Allocate payments").
 */
export interface CloseReporter {
  log(step: string, ok: boolean, detail: string): Promise<void>;
  stop(step: string, detail: string): Promise<never>;
  retryHint: string;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── Reading HireHop ──────────────────────────────────────────────────────

export const kindOf = (row: Row) => parseInt(row.kind ?? '0');
export const idOf = (row: Row) => parseInt(row.data?.ID || row.number || '0');

export function invoiceRows(rows: Row[]): Row[] {
  return rows.filter((row) => kindOf(row) === 1);
}

export function findInvoice(rows: Row[], invoiceId: number): Row | null {
  return invoiceRows(rows).find((row) => idOf(row) === invoiceId) ?? null;
}

/** HireHop invoice STATUS: 0 draft · 2 approved · 3 paid (seen on 16762 once allocated). */
export function invoiceStatus(row: Row): number {
  return parseInt(row.status ?? row.data?.STATUS ?? '0');
}

/** Gross (inc VAT): `debit`, else NET + TAX. */
export function invoiceGross(row: Row): number | null {
  const debit = parseFloat(row.debit ?? row.data?.debit ?? '');
  if (Number.isFinite(debit)) return round2(debit);
  const net = parseFloat(row.data?.NET ?? '');
  const tax = parseFloat(row.data?.TAX ?? '');
  return Number.isFinite(net) && Number.isFinite(tax) ? round2(net + tax) : null;
}

export function invoiceNet(row: Row): number | null {
  const net = parseFloat(row.data?.NET ?? '');
  return Number.isFinite(net) ? round2(net) : null;
}

export function invoiceOwing(row: Row): number | null {
  const owing = parseFloat(row.owing ?? row.data?.owing ?? '');
  return Number.isFinite(owing) ? round2(owing) : null;
}

/**
 * Has the approved invoice reached Xero? After `accounting/tasks.php` HireHop
 * stamps it with the Xero invoice id (`ACC_ID`) and `exported: 1` (§4 capture).
 */
export function invoiceInXero(row: Row): boolean {
  const d = row.data || {};
  const accId = String(d.ACC_ID ?? d.acc_id ?? '').trim();
  return (accId !== '' && accId !== '0') || Number(row.exported ?? d.exported ?? 0) === 1;
}

/** A payment (kind 6 deposit) on the job with money still unallocated. */
export interface UnallocatedPayment {
  depositId: number;
  bankId: number | null;
  description: string;
  /** Unallocated — what a close can allocate to an invoice. */
  available: number;
}

/**
 * Every payment on the job with money still unallocated. `skip` lets a caller
 * leave some deposits out — the hire close-out never touches excess deposits.
 */
export function unallocatedPayments(rows: Row[], skip?: (row: Row) => boolean): UnallocatedPayment[] {
  const out: UnallocatedPayment[] = [];
  for (const row of rows) {
    if (kindOf(row) !== 6) continue;
    if (!(parseFloat(row.credit ?? row.data?.credit ?? '0') > 0)) continue;   // refunds/negatives aren't payments
    if (skip && skip(row)) continue;
    const id = idOf(row);
    const dep = id ? readDepositAvailability(rows, id) : null;
    if (!dep || dep.available < PENNY) continue;
    const bank = row.data?.ACC_ACCOUNT_ID;
    out.push({
      depositId: id,
      bankId: bank != null && bank !== '' ? Number(bank) : null,
      description: String(row.data?.DESCRIPTION || row.desc || ''),
      available: round2(dep.available),
    });
  }
  return out;
}

/** The allocations on an invoice (the invoice-side twin of each kind 3 row). */
export function invoiceAllocations(rows: Row[], invoiceId: number): Row[] {
  return rows.filter((row) => kindOf(row) === 3
    && String(row.parent_is ?? row.data?.parent_is ?? '') === 'invoice'
    && Number(row.data?.OWNER ?? 0) === invoiceId);
}

/** HireHop's job status, fresh. Null if it couldn't be read. */
export async function readJobStatus(hhJobNumber: number): Promise<number | null> {
  const res = await hhBroker.get<any>('/api/job_data.php', { job: hhJobNumber },
    { priority: 'high', cacheTTL: -1, skipCache: true });
  const s = res?.success ? parseFloat(String(res.data?.STATUS ?? '')) : NaN;
  return Number.isFinite(s) ? s : null;
}

// ── Writing HireHop — one call each, read back by the caller ─────────────

/**
 * Draft an invoice from every line not yet invoiced (`all: 1` — proven to
 * pick up ONLY uninvoiced lines, §3). Returns HireHop's reply and the id of
 * the invoice it says it made (0 if it said nothing). The caller must read
 * the job back: the broker retries POSTs after a network blip, so the reply
 * alone proves nothing.
 */
export async function postDraftInvoice(hhJobNumber: number, ref: string): Promise<{ res: any; newId: number }> {
  const res = await hhBroker.post<any>('/php_functions/billing_save.php', {
    id: 0,
    desc: '',
    ref,                    // → the Xero invoice's Reference
    memo: '',
    bank: 169,              // the invoice's default bank as captured; payments carry their own
    tax_total: '0.00',
    tax_rate: 0,
    all: 1,                 // "Include all owing items" — ALWAYS; the UI default is a user setting
    novat: 0,
    aggregated: 0,
    local: hhLocalNow(),
    tz: 'Europe/London',
    'currency[CODE]': 'GBP',
    'currency[NAME]': 'United Kingdom Pound',
    'currency[SYMBOL]': '£',
    'currency[DECIMALS]': 2,
    'currency[MULTIPLIER]': 1,
    'currency[NEGATIVE_FORMAT]': 1,
    'currency[SYMBOL_POSITION]': 0,
    'currency[DECIMAL_SEPARATOR]': '.',
    'currency[THOUSAND_SEPARATOR]': ',',
    upto: '',
    job: hhJobNumber,
  }, { priority: 'high' });
  const fromResponse = (res.data?.rows || []).find((r: Row) => kindOf(r) === 1);
  return { res, newId: fromResponse ? idOf(fromResponse) : 0 };
}

/**
 * Approve a draft (the Xero commit point — §4). `dateTime` is the invoice
 * date as HireHop wants it ('YYYY-MM-DD HH:MM:SS'). Never call this on an
 * invoice already at status ≥ 2; the caller checks and reads back.
 */
export async function postApproveInvoice(invoiceId: number, dateTime: string): Promise<any> {
  return hhBroker.post<any>('/php_functions/billing_save_status.php', {
    id: invoiceId,
    status: 2,
    date: dateTime,
    type: 1,
    local: hhLocalNow(),
  }, { priority: 'high' });
}

/**
 * Allocate `amount` of a deposit to an invoice (§5): a new application
 * (`id: 0`), dated today, on the DEPOSIT's bank. The caller reads back that
 * the deposit's free balance and the invoice's owing both fell by `amount`.
 */
export async function postAllocation(input: {
  depositId: number; bankId: number; amount: number; invoiceId: number;
}): Promise<any> {
  return hhBroker.post<any>('/php_functions/billing_payments_save.php', {
    id: 0,                 // a new application
    date: londonDate(new Date()),
    desc: '',
    paid: input.amount,
    memo: '',
    bank: input.bankId,    // the PAYMENT's bank, not the invoice's
    OWNER: input.invoiceId,
    deposit: input.depositId,
    no_webhook: 1,
  }, { priority: 'high' });
}

// ── The Xero legs ────────────────────────────────────────────────────────

/**
 * Push an approved invoice to Xero and read back that HireHop has stamped it
 * (`ACC_ID` / `exported`). `saved` is HireHop's own approve reply, which
 * names the sync task; default `hh_task: 'post_invoice_credit'` yourself if
 * it lacks one (the helper's default is `post_payment`, wrong for an invoice).
 */
export async function pushInvoiceToXero(rep: CloseReporter, input: {
  label: string; hhJobNumber: number; invoiceId: number; number: string; gross: number; saved: Row;
  /** For the failure alert: the OP job (null for the shop) and what this invoice is. */
  alert: { jobId: string | null; what: string };
}): Promise<void> {
  const { hhJobNumber, invoiceId, number, gross } = input;
  const sync = await syncSavedRowToXero(input.label, input.saved);
  if (!sync.ok) {
    void sendXeroSyncFailedAlert({
      jobId: input.alert.jobId, hhJobNumber, what: input.alert.what, amount: gross,
      hhRowId: invoiceId, error: sync.error || 'unknown',
    });
    await rep.stop('xero', `Invoice ${number} is approved in HireHop but Xero refused it: ${sync.error}. `
      + `No payments have been allocated. Fix it in Xero (you've been emailed), then ${rep.retryHint} to carry on.`);
  }
  // Read back: HireHop stamps the invoice once Xero has it.
  const inv = findInvoice(await readBillingRows(hhJobNumber), invoiceId);
  if (!inv || !invoiceInXero(inv)) {
    const keys = inv?.data ? Object.keys(inv.data).join(',') : 'none';
    console.warn(`[hh-invoice-close] invoice ${invoiceId} shows no Xero id after sync. data keys: ${keys}`);
    await rep.stop('xero', `HireHop says invoice ${number} was sent to Xero, but it doesn't show as exported yet. `
      + `Check it is in Xero, then ${rep.retryHint} to carry on.`);
  }
  await rep.log('xero', true, `Invoice ${number} is in Xero.`);
}

const xeroMoney = (v: unknown) => round2(Number(v) || 0);

/**
 * Make Xero match HireHop: apply each payment's overpayment to the invoice —
 * Xero's "Apply credit" — then ask XERO whether the invoice is paid.
 *
 * HireHop allocates on its side but never pushes the allocation to Xero (jon,
 * Sep 2026: it never has; 16762 and 16750 proved it, and on 9 Oct 2026 every
 * OP-pushed deposit was still an unapplied overpayment in Xero). The ids are
 * already on HireHop's rows: the invoice's `ACC_ID` is the Xero invoice, each
 * deposit's `ACC_DATA.OverpaymentID` is its Xero overpayment.
 *
 * Idempotent. It applies only what each overpayment has NOT already applied to
 * this invoice, so a resume — or the bookkeeper pressing "Apply credit" in
 * Xero by hand — never applies anything twice. The only judge of "done" is
 * Xero's AmountDue.
 *
 * `rows` must include the deposit rows the allocations point at. For an
 * allocation whose deposit lives on ANOTHER job (a cross-job apply), pass
 * `extraRows` with that job's billing rows so its OverpaymentID can be found.
 */
export async function applyCreditsInXero(
  rep: CloseReporter, rows: Row[], invoiceId: number, number: string, extraRows: Row[] = [],
): Promise<void> {
  if (!isXeroConfigured()) {
    await rep.stop('xero', 'OP has no Xero connection on this server, so it cannot apply the payments in Xero. '
      + `Apply the credit to ${number} in Xero by hand, then ${rep.retryHint} to finish.`);
  }
  const inv = findInvoice(rows, invoiceId);
  const xeroInvoiceId = String(inv?.data?.ACC_ID ?? '').trim();
  if (!xeroInvoiceId) {
    await rep.stop('xero', `${number} has no Xero id in HireHop, so OP can't find it in Xero. Check it reached Xero, then ${rep.retryHint}.`);
  }

  const amountDue = async () => {
    const x = await xeroBroker.getInvoice(xeroInvoiceId);
    if (!x) throw new Error(`Xero can't find ${number} (${xeroInvoiceId}).`);
    return xeroMoney(x.AmountDue);
  };

  const depositRows = [...rows, ...extraRows];
  try {
    if ((await amountDue()) < PENNY) {
      await rep.log('xero', true, `${number} already shows paid in Xero.`);
      return;
    }
    const today = londonDate(new Date());
    for (const app of invoiceAllocations(rows, invoiceId)) {
      const depositId = Number(app.data?.OWNER_DEPOSIT ?? 0);
      const amount = xeroMoney(Math.abs(parseFloat(app.credit ?? app.data?.AMOUNT ?? '0')));
      const dep = depositRows.find((r) => kindOf(r) === 6 && idOf(r) === depositId);
      const overpaymentId = String(dep?.data?.ACC_DATA?.OverpaymentID ?? '').trim();
      if (!overpaymentId) {
        await rep.stop('xero', `Payment ${depositId} (${gbp(amount)}) isn't in Xero as a payment, so there's no credit to apply. `
          + `Check it in HireHop (it should have the cloud icon), then ${rep.retryHint}.`);
      }
      const op = await xeroBroker.getOverpayment(overpaymentId);
      if (!op) await rep.stop('xero', `Xero can't find the overpayment for payment ${depositId}. Check it in Xero, then ${rep.retryHint}.`);
      const applied = xeroMoney(((op!.Allocations as any[]) || [])
        .filter((a) => String(a?.Invoice?.InvoiceID ?? '') === xeroInvoiceId)
        .reduce((sum, a) => sum + (Number(a?.Amount) || 0), 0));
      const need = round2(amount - applied);
      if (need < PENNY) continue;                 // already applied — by us earlier, or by hand
      const remaining = xeroMoney(op!.RemainingCredit);
      if (remaining + PENNY < need) {
        await rep.stop('xero', `Payment ${depositId} needs ${gbp(need)} applying to ${number}, but Xero says only `
          + `${gbp(remaining)} of it is unused — it has been applied elsewhere. Check it in Xero; nothing more was applied.`);
      }
      await xeroBroker.allocateOverpayment({ overpaymentId, invoiceId: xeroInvoiceId, amount: need, date: today });
      await rep.log('xero', true, `Payment ${depositId} — ${gbp(need)} credit applied to ${number} in Xero.`);
    }
    const due = await amountDue();
    if (due >= PENNY) {
      await rep.stop('xero', `After applying every payment, Xero still shows ${gbp(due)} due on ${number}. `
        + `The job has NOT been completed. Check the invoice in Xero, then ${rep.retryHint}.`);
    }
  } catch (err) {
    if (err instanceof Stop) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const scope = /\b40[13]\b|scope|token rejected/i.test(msg)
      ? ' This looks like OP\'s Xero connection lacking permission to apply credit (accounting.payments).' : '';
    await rep.stop('xero', `Xero refused while applying the payments to ${number}: ${msg}.${scope} `
      + `Anything already applied stays applied; ${rep.retryHint} to carry on.`);
  }
  await rep.log('xero', true, `${number} shows paid in Xero.`);
}

// ── Completing the job ───────────────────────────────────────────────────

/** Status 11, read back. */
export async function completeJob(rep: CloseReporter, hhJobNumber: number): Promise<void> {
  if ((await readJobStatus(hhJobNumber)) !== HH_COMPLETED) {
    const res = await hhBroker.post<any>('/frames/status_save.php', {
      job: hhJobNumber, status: HH_COMPLETED, no_webhook: 1,
    }, { priority: 'high' });
    const status = await readJobStatus(hhJobNumber);
    if (status !== HH_COMPLETED) {
      await rep.stop('complete', `HireHop job ${hhJobNumber} is status ${status ?? '?'}, not Completed `
        + `(${res.error || 'no error given'}). ${capitalise(rep.retryHint)} to try again.`);
    }
  }
  await rep.log('complete', true, `HireHop job ${hhJobNumber} is Completed.`);
}
