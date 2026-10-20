/**
 * hire-close-out.ts — finishing a hire's money from OP (docs/HIRE-CLOSE-OUT-SPEC.md).
 *
 * Phase 1: ALLOCATE and COMPLETE, on jobs whose invoice was raised by hand.
 *
 *   plan     — read HireHop fresh, run the pre-flight (§6) and the allocation
 *              rule (§5), and say in sentences what Allocate would do. Never writes.
 *   allocate — do exactly that plan: one HireHop application at a time, each read
 *              back; then apply the credits in Xero and read Xero back. Stops on
 *              the first disagreement and says why; the next press resumes.
 *   complete — HireHop status 11, only when every invoice is paid in HireHop AND
 *              Xero and no hire deposit still holds money. Excess still held is
 *              a warning with a manager override, never a gate.
 *
 * The HireHop/Xero mechanics are hh-invoice-close.ts (shared with the shop).
 * This file is the hire's own rules:
 *   - excess deposits are NEVER allocated here (they reach an invoice only
 *     through the claim flow);
 *   - more than one OPEN invoice is refused until the first real one has been
 *     walked through live (§1.8);
 *   - every HireHop deposit must have OP's own record of it, and every HireHop
 *     refund OP's own refund — the check that would have caught job 16015's
 *     hand-entered "refund" (a blank-description OWNER=0 row nobody made);
 *   - a surplus is surfaced with the three choices and never moved.
 *
 * Everything it does or refuses is a row in job_closeout_log (§7).
 */
import { query } from '../config/database';
import { readBillingRows, readDepositAvailability } from './hh-deposit-release';
import { isExcessText } from './hh-billing-deposits';
import {
  PENNY, round2, gbp, Stop, CloseReporter, Row,
  kindOf, idOf, invoiceRows, findInvoice, invoiceStatus, invoiceGross, invoiceOwing, invoiceInXero,
  invoiceAllocations, unallocatedPayments, readJobStatus, invoiceNet,
  postAllocation, applyCreditsInXero, completeJob, postDraftInvoice, postApproveInvoice, pushInvoiceToXero,
  adoptLostXeroInvoices, isChargeOnlyInvoice, readSupplyList, postPasteSupplyLines,
} from './hh-invoice-close';
import { splitEuDraft } from './eu-vat-split';
import xeroBroker from './xero-broker';
import { isXeroConfigured } from '../config/xero';
import { DISPLAY_NAME_SQL } from './display-name';
import { hasNonStandardVatItem } from './vat-adjustment';
import { hhLocalNow } from './shop-stock';
import { getMethodForBankId, PAYMENT_METHODS_LABELS } from './hh-deposit';
import { handleJobStatusChange } from '../routes/webhooks';
import {
  CancellationPlan, readCancellation, readRefundReminders, planCancellationInvoice, raiseCancellationFee, syncRefundReminder, markCancellationReconciled,
} from './cancellation-close';

/* eslint-disable @typescript-eslint/no-explicit-any */

const HH_RETURNED_INCOMPLETE = 6;
const HH_COMPLETED_STATUS = 11;

/** The route maps exactly this message to 404 — never match on "does not exist" (a Postgres error says that too). */
export const JOB_NOT_FOUND = 'That job does not exist.';

export interface CloseOutInvoice {
  invoiceId: number;
  number: string;
  /** 2 approved · 3 paid. Drafts and proformas are not listed. */
  status: number;
  date: string;
  gross: number;
  owing: number;
  inXero: boolean;
  xeroId: string | null;
  /** A charge raised after completion (custom lines only, spec §4.6) — not part of the hire total. */
  chargeOnly: boolean;
}

export interface CloseOutPayment {
  depositId: number;
  bankId: number | null;
  bankName: string | null;
  description: string;
  date: string;
  /** Cash received on the deposit. */
  credit: number;
  /** Still unallocated. */
  available: number;
}

export interface PlannedAllocation {
  depositId: number;
  bankId: number;
  amount: number;
  invoiceId: number;
  invoiceNumber: string;
}

export interface CloseOutLogEntry {
  id: string;
  step: string;
  ok: boolean;
  detail: string;
  hh_refs: Record<string, unknown> | null;
  user_id: string | null;
  user_name: string | null;
  created_at: string;
}

/** The Invoice card's half of the plan (§4.1). */
export interface InvoicePlan {
  /** HireHop's quoted net for the job (kind 0 accrued). */
  accruedNet: number;
  /** Net already on approved or draft invoices. */
  invoicedNet: number;
  /** What Raise invoice would bill, ex VAT. */
  netToInvoice: number;
  /** A draft already on the job — Raise invoice adopts it. */
  draft: CloseOutInvoice | null;
  /** The job carries the "Non-standard VAT rules" item: Raise invoice splits the VAT (eu-vat-split.ts). */
  euTrigger: boolean;
  /** HireHop says the job has not returned (status < 6) — a manager may override. */
  notReturned: boolean;
  blockers: string[];
  ready: boolean;
}

export interface CloseOutPlan {
  jobId: string;
  /** True when this came from OP's own record of the job being Completed, with no HireHop read (§4.4). */
  fromLog?: boolean;
  invoice: InvoicePlan;
  hhJobNumber: number;
  jobName: string | null;
  /** HireHop's job status, fresh (11 = Completed). */
  hhStatus: number | null;
  invoices: CloseOutInvoice[];
  payments: CloseOutPayment[];
  allocations: PlannedAllocation[];
  /** Hire deposits that would still hold money after every open invoice is paid. */
  surplus: Array<{ depositId: number; amount: number }>;
  /** What the client would still owe after every hire deposit is used. */
  shortfall: number;
  /** Excess OP holds on this job (v_excess_held) — never allocated here. */
  excessHeld: number;
  /** Why Allocate / Complete cannot run. Empty when they can. */
  blockers: string[];
  warnings: string[];
  /** The plan, in the sentences the card shows before the button. */
  sentences: string[];
  /** Allocate has something to do and nothing stops it. */
  ready: boolean;
  /** Every invoice at £0 in HireHop and no hire deposit holding money (Xero is checked at Complete). */
  readyToComplete: boolean;
  log: CloseOutLogEntry[];
  /** OP's Invoice requirement — "Mark as sent" ticks it Done. */
  invoiceRequirementId: string | null;
  invoiceSent: boolean;
  /** Problems still open on the job — a warning for the invoice, a gate for Complete. */
  openProblems: number;
  /**
   * More than one invoice owing (a hire invoice and a separate damage one, say): the one a
   * manager chose for the hire payments (`setPaymentTarget`, kept in the close-out log).
   * Allocation fills only that invoice; the others are settled by an excess claim or Record
   * payment. Null when there is nothing to choose, or nobody has chosen yet (jon, 14 Oct 2026).
   */
  paymentTarget: { invoiceId: number; number: string } | null;
  /**
   * A CANCELLED job (CANCELLATION-SPEC.md, the money end): the invoice is the fee, not the
   * hire; what is left on the hire payments after it is a refund due; the job is never
   * completed. Null on every other job.
   */
  cancellation: CancellationPlan | null;
}

export interface CloseOutResult {
  done: boolean;
  message: string;
  plan: CloseOutPlan;
}

export interface JobRow {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  is_internal: boolean | null;
  pipeline_status: string | null;
}

// ── Log ──────────────────────────────────────────────────────────────────

export async function log(jobId: string, userId: string | null, step: string, ok: boolean, detail: string,
  refs?: Record<string, unknown>): Promise<void> {
  // JSONB — stringify, never a bare object/array (CLAUDE.md).
  await query(
    `INSERT INTO job_closeout_log (job_id, step, ok, detail, hh_refs, user_id) VALUES ($1, $2, $3, $4, $5, $6)`,
    [jobId, step, ok, detail, refs ? JSON.stringify(refs) : null, userId],
  );
  console.log(`[hire-close-out] ${jobId} ${step}: ${ok ? 'ok' : 'STOPPED'} — ${detail}`);
}

async function readLog(jobId: string): Promise<CloseOutLogEntry[]> {
  // Who pressed it: users has no name of its own — it points at people (CLAUDE.md).
  const r = await query(
    `SELECT l.id, l.step, l.ok, l.detail, l.hh_refs, l.user_id,
            NULLIF(TRIM(${DISPLAY_NAME_SQL}), '') AS user_name, l.created_at
       FROM job_closeout_log l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN people p ON p.id = u.person_id
      WHERE l.job_id = $1 ORDER BY l.created_at DESC LIMIT 50`,
    [jobId],
  );
  return r.rows;
}

export function reporter(jobId: string, userId: string | null, retryHint: string): CloseReporter {
  return {
    log: (step, ok, detail) => log(jobId, userId, step, ok, detail),
    stop: async (step, detail) => { await log(jobId, userId, step, false, detail); throw new Stop(detail); },
    retryHint,
    userId,
  };
}

// ── Reading ──────────────────────────────────────────────────────────────

export async function loadJob(jobIdOrNumber: string): Promise<JobRow> {
  const isUuid = /^[0-9a-f]{8}-/i.test(jobIdOrNumber);
  const r = await query(
    isUuid
      ? `SELECT id, hh_job_number, job_name, is_internal, pipeline_status FROM jobs WHERE id = $1`
      : `SELECT id, hh_job_number, job_name, is_internal, pipeline_status FROM jobs WHERE hh_job_number = $1`,
    [isUuid ? jobIdOrNumber : parseInt(jobIdOrNumber, 10)],
  );
  const job = r.rows[0];
  if (!job) throw new Error(JOB_NOT_FOUND);
  return job;
}

const depositText = (row: Row) =>
  String(row.data?.DESCRIPTION || row.desc || '') + ' ' + String(row.data?.MEMO || '');
const isExcessDeposit = (row: Row) => isExcessText(depositText(row));

/** Approved, non-proforma invoices on the job, oldest first. */
export function approvedInvoices(rows: Row[]): CloseOutInvoice[] {
  return invoiceRows(rows)
    .filter((row) => invoiceStatus(row) >= 2)
    .filter((row) => !String(row.data?.DESCRIPTION || row.desc || '').toLowerCase().includes('proforma'))
    .map((row) => ({
      invoiceId: idOf(row),
      number: String(row.data?.NUMBER || row.number || idOf(row)),
      status: invoiceStatus(row),
      date: String(row.data?.TAX_POINT || row.date || ''),
      gross: invoiceGross(row) ?? 0,
      owing: invoiceOwing(row) ?? 0,
      inXero: invoiceInXero(row),
      xeroId: String(row.data?.ACC_ID ?? '').trim() || null,
      chargeOnly: isChargeOnlyInvoice(row),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.invoiceId - b.invoiceId);
}

/** Every positive, non-excess deposit on the job (allocated or not). */
function hireDepositRows(rows: Row[]): Row[] {
  return rows.filter((row) => kindOf(row) === 6
    && parseFloat(row.credit ?? row.data?.credit ?? '0') > 0
    && !isExcessDeposit(row));
}

/**
 * Excess money on an invoice that OP never recorded as claimed — job 16015, Oct 2026: an
 * excess deposit applied to the hire invoice by hand in HireHop, so OP still showed the
 * excess as held, and the nightly sweep copied the £1,200 into Xero as if it were hire money.
 * OP's own ways of putting excess on an invoice (Excess → Claim, capture-and-apply) add to
 * the record's claim_amount, so an excess deposit may stand on invoices up to that and no
 * further. One sentence per excess deposit over the line; [] when OP knows about every use.
 */
export async function unrecordedExcessUse(rows: Row[], invoiceId: number, extraRows: Row[] = []): Promise<string[]> {
  const all = [...rows, ...extraRows];
  const excessIds = new Set<number>();
  for (const app of invoiceAllocations(rows, invoiceId)) {
    const id = Number(app.data?.OWNER_DEPOSIT ?? 0);
    const dep = all.find((r) => kindOf(r) === 6 && idOf(r) === id);
    if (dep && isExcessDeposit(dep)) excessIds.add(id);
  }
  const out: string[] = [];
  for (const id of excessIds) {
    // Everything that has left this deposit for an invoice, on any job (refunds are not invoices).
    const seen = new Set<number>();
    const applied = round2((readDepositAvailability(all, id)?.applications ?? [])
      .filter((a) => !a.applicationId || (!seen.has(a.applicationId) && !!seen.add(a.applicationId)))
      .reduce((sum, a) => sum + a.amount, 0));
    const r = await query(`SELECT COALESCE(SUM(claim_amount), 0)::float8 AS claimed FROM job_excess WHERE hh_deposit_id = $1`, [id]);
    const claimed = round2(Number(r.rows[0]?.claimed ?? 0));
    if (applied - claimed >= PENNY) {
      out.push(`Excess payment ${id} has ${gbp(applied)} applied to invoices in HireHop, but OP has recorded only ${gbp(claimed)} `
        + 'claimed from that excess — it looks like it was applied by hand. If the excess should pay this, remove the allocation '
        + 'in HireHop and use Excess → Claim; if not, just remove it in HireHop. Nothing is applied in Xero until the two agree.');
    }
  }
  return out;
}

/** Hire deposits with money left, oldest first, with the display fields. */
function hirePayments(rows: Row[]): CloseOutPayment[] {
  const byId = new Map(rows.filter((r) => kindOf(r) === 6).map((r) => [idOf(r), r]));
  return unallocatedPayments(rows, isExcessDeposit)
    .map((p) => {
      const row = byId.get(p.depositId);
      return {
        ...p,
        // The billing rows carry only the bank id; name it the way OP names methods.
        bankName: p.bankId != null ? (PAYMENT_METHODS_LABELS[getMethodForBankId(p.bankId)] ?? null) : null,
        date: String(row?.data?.DATE || row?.date || ''),
        credit: round2(parseFloat(row?.credit ?? row?.data?.credit ?? '0')),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.depositId - b.depositId);
}

/** Refunds out of hire deposits: deposit-side kind 3 rows with no invoice (OWNER 0). */
function refundRows(rows: Row[], hireDepositIds: Set<number>): Row[] {
  return rows.filter((row) => {
    if (kindOf(row) !== 3) return false;
    const d = row.data || {};
    if (String(row.parent_is ?? d.parent_is ?? '') !== 'deposit') return false;
    const owner = d.OWNER != null ? parseInt(String(d.OWNER)) : 0;
    if (owner > 0) return false;
    if (!(parseFloat(row.credit ?? d.credit ?? '0') < 0)) return false;
    return hireDepositIds.has(Number(d.OWNER_DEPOSIT ?? 0));
  });
}

// ── The allocation rule (§5) ─────────────────────────────────────────────

export function planAllocations(invoices: CloseOutInvoice[], payments: CloseOutPayment[]): {
  allocations: PlannedAllocation[]; surplus: Array<{ depositId: number; amount: number }>; shortfall: number;
} {
  const owing = new Map(invoices.map((i) => [i.invoiceId, i.owing]));
  const available = new Map(payments.map((p) => [p.depositId, p.available]));
  const allocations: PlannedAllocation[] = [];
  for (const inv of invoices) {                       // oldest invoice first
    for (const pay of payments) {                     // oldest deposit first
      const left = owing.get(inv.invoiceId)!;
      if (left < PENNY) break;
      const have = available.get(pay.depositId)!;
      const amount = round2(Math.min(have, left));
      if (amount < PENNY || pay.bankId == null) continue;
      allocations.push({ depositId: pay.depositId, bankId: pay.bankId, amount, invoiceId: inv.invoiceId, invoiceNumber: inv.number });
      owing.set(inv.invoiceId, round2(left - amount));
      available.set(pay.depositId, round2(have - amount));
    }
  }
  const surplus = payments
    .map((p) => ({ depositId: p.depositId, amount: available.get(p.depositId)! }))
    .filter((s) => s.amount >= PENNY);
  const shortfall = round2([...owing.values()].reduce((s, v) => s + v, 0));
  return { allocations, surplus, shortfall };
}

// ── The invoice (§4.1) ───────────────────────────────────────────────────

const accruedNetOf = (rows: Row[]) => {
  const total = rows.find((r) => kindOf(r) === 0);
  return round2(parseFloat(total?.accrued ?? total?.data?.TOTAL ?? '0') || 0);
};
const isProformaRow = (row: Row) => String(row.data?.DESCRIPTION || row.desc || '').toLowerCase().includes('proforma');
const draftRows = (rows: Row[]) => invoiceRows(rows).filter((r) => invoiceStatus(r) === 0 && !isProformaRow(r));
const toInvoice = (row: Row): CloseOutInvoice => ({
  invoiceId: idOf(row),
  number: String(row.data?.NUMBER || row.number || idOf(row)),
  status: invoiceStatus(row),
  date: String(row.data?.TAX_POINT || row.date || ''),
  gross: invoiceGross(row) ?? 0,
  owing: invoiceOwing(row) ?? 0,
  inXero: invoiceInXero(row),
  xeroId: String(row.data?.ACC_ID ?? '').trim() || null,
  chargeOnly: isChargeOnlyInvoice(row),
});

async function planInvoice(rows: Row[], approved: CloseOutInvoice[], hhJobNumber: number, hhStatus: number | null): Promise<InvoicePlan> {
  const accruedNet = accruedNetOf(rows);
  const nonProforma = invoiceRows(rows).filter((r) => !isProformaRow(r) && !isChargeOnlyInvoice(r));
  const invoicedNet = round2(nonProforma.reduce((s, r) => s + (invoiceNet(r) ?? 0), 0));
  const drafts = draftRows(rows);
  const draft = drafts.length === 1 ? toInvoice(drafts[0]) : null;
  const netToInvoice = round2(Math.max(accruedNet - invoicedNet, 0));
  const blockers: string[] = [];
  const notReturned = hhStatus != null && hhStatus < HH_RETURNED_INCOMPLETE;
  let euTrigger = false;
  if (drafts.length > 1) {
    blockers.push(`${drafts.length} draft invoices in HireHop. Delete the ones you don't want there, then press Check again.`);
  }
  if (netToInvoice >= PENNY || draft) {
    const eu = await hasNonStandardVatItem(hhJobNumber);
    if (eu == null) blockers.push('Could not read the job\'s items from HireHop to check its VAT rules.');
    euTrigger = eu === true;
  }
  if (notReturned) blockers.push(`HireHop says this job hasn't returned yet (status ${hhStatus}) — a manager can raise the invoice anyway.`);
  void approved;
  return {
    accruedNet, invoicedNet, netToInvoice, draft, euTrigger, notReturned, blockers,
    ready: blockers.length === 0 && (netToInvoice >= PENNY || draft != null),
  };
}

/**
 * Raise the hire's invoice from every line not yet invoiced: draft (or adopt
 * the draft already there), penny check against HireHop's own quoted total,
 * approve dated today, push to Xero, read each back. Stops at the draft on a
 * mismatch — a draft never reaches Xero. `allowNotReturned` is the manager's
 * override for a job HireHop still shows as out.
 */
export async function raiseHireInvoice(jobIdOrNumber: string, userId: string | null,
  opts: { allowNotReturned?: boolean } = {}): Promise<CloseOutResult> {
  const job = await loadJob(jobIdOrNumber);
  return withJobLock(job.id, async () => {
    const rep = reporter(job.id, userId, 'press the Money tab button');
    let done = false;
    let message: string;
    try {
      message = await raiseSteps(job, rep, !!opts.allowNotReturned);
      done = true;
    } catch (err) {
      if (!(err instanceof Stop)) {
        await log(job.id, userId, 'error', false, err instanceof Error ? err.message : String(err)).catch(() => undefined);
      }
      message = err instanceof Error ? err.message : String(err);
    }
    return { done, message, plan: await buildPlan(job) };
  });
}

/** `system_settings.closeout_invoice_layout` = 'flat' switches the quote layout off without a deploy. */
const LAYOUT_SETTING_KEY = 'closeout_invoice_layout';
async function pasteLayoutEnabled(): Promise<boolean> {
  const r = await query(`SELECT value FROM system_settings WHERE key = $1`, [LAYOUT_SETTING_KEY]).catch(() => ({ rows: [] as any[] }));
  return String(r.rows[0]?.value ?? '').trim().toLowerCase() !== 'flat';
}

/**
 * Paste the supply list onto the new, EMPTY draft and prove it landed: every priced line
 * of the job exactly once, nothing else priced. The penny check after this still compares
 * the draft with HireHop's quoted total. Any doubt stops at the draft — nothing reaches Xero.
 */
async function pasteSupplyList(rep: CloseReporter, hhJobNumber: number, draftId: number, draft: Row): Promise<void> {
  const deleteHint = `Delete draft ${draftId} in HireHop, then ${rep.retryHint}.`;
  if ((draft.data?.items || []).length) {
    await rep.stop('invoice_draft', `HireHop put lines on draft ${draftId} before the paste — it should have been empty. Nothing has gone to Xero. ${deleteHint}`);
  }
  const supply = await readSupplyList(hhJobNumber);
  if (!supply.length) await rep.stop('invoice_draft', `Could not read job ${hhJobNumber}'s supply list from HireHop. Nothing has gone to Xero. ${deleteHint}`);
  const res = await postPasteSupplyLines(hhJobNumber, draftId, supply);
  const lines: Row[] = findInvoice(await readBillingRows(hhJobNumber), draftId)?.data?.items || [];
  const priced = supply.filter((r) => Number(r.kind ?? 0) !== 0 && Math.abs(Number(r.PRICE ?? 0)) >= PENNY);
  // Count by job line id, not "exactly one": a prompt's id repeats when two vans carry it.
  const count = (xs: Row[], id: number, key: 'ID' | 'MAIN_ID') => xs.filter((x) => Number(x[key]) === id).length;
  const missing = priced.filter((r) => count(lines, Number(r.ID), 'MAIN_ID') !== count(priced, Number(r.ID), 'ID'));
  const pricedLines = lines.filter((l) => Math.abs(Number(l.PRICE ?? 0)) >= PENNY);
  if (!lines.length || missing.length || pricedLines.length !== priced.length) {
    await rep.stop('invoice_draft', !lines.length
      ? `HireHop did not paste the supply list onto draft ${draftId}${res?.error ? ` (${res.error})` : ''}. Nothing has gone to Xero. ${deleteHint}`
      : `Draft ${draftId} doesn't match the supply list after the paste (${missing.length ? `${missing.map((r) => `"${String(r.alt_title || r.title || r.ID)}"`).slice(0, 3).join(', ')} missing or doubled` : `${pricedLines.length} priced lines, expected ${priced.length}`}). Nothing has gone to Xero. ${deleteHint}`);
  }
  await rep.log('invoice_draft', true, `Draft invoice ${draftId} laid out like the quote: ${lines.length} lines pasted from the supply list.`);
}

/**
 * The penny check's stop, worded for how the draft came to be. HireHop shows a "Quoted net
 * total" on BOTH its Supplying and Billing tabs, and the check compares the draft with the
 * Billing one — so "HireHop's quoted net is £158.13" read as a contradiction beside a
 * Supplying tab saying £197.50 (job 16724, 20 Oct 2026: a per-Hour line with a hand-typed
 * £45 that Billing priced as 3 × £1.88). A pasted draft carries the Supplying tab's figures,
 * so a mismatch on one means HireHop prices a line differently on its two tabs.
 */
export function pennyStopMessage(p: {
  draftId: number; draftNet: number; othersNet: number; accrued: number; retryHint: string;
  /** pasted = the supply list onto an empty draft · adopted = a draft already on the job · drafted = "all owing items". */
  how: 'pasted' | 'adopted' | 'drafted';
}): string {
  const apart = gbp(round2(Math.abs(p.draftNet + p.othersNet - p.accrued)));
  const billing = `HireHop's Billing tab says the job comes to ${gbp(p.accrued)} ex VAT (${apart} apart)`;
  const withOthers = p.othersNet >= PENNY ? ` (${gbp(round2(p.draftNet + p.othersNet))} with the ${gbp(p.othersNet)} already invoiced)` : '';
  const stopped = 'Stopped at the draft; nothing has gone to Xero.';
  const twoTabs = 'HireHop is pricing a line differently on its two tabs (usually an hourly or daily line with a hand-typed price)';
  if (p.how === 'pasted') {
    return `Draft ${p.draftId} has the Supplying tab's lines, ${gbp(p.draftNet)} ex VAT, but ${billing}. ${twoTabs}. ${stopped} `
      + `Fix that line in Supplying until the Billing tab's "Quoted net total" agrees, delete draft ${p.draftId} in HireHop, then ${p.retryHint}.`;
  }
  if (p.how === 'adopted') {
    return `Draft ${p.draftId}, already on the job, is ${gbp(p.draftNet)} ex VAT${withOthers}, but ${billing}. ${stopped} `
      + `If the draft matches the Supplying tab's "Quoted net total", ${twoTabs}: fix that line. `
      + `If not, change the job's lines in HireHop to agree with the draft, or delete draft ${p.draftId}. Then ${p.retryHint}.`;
  }
  return `Draft ${p.draftId} is ${gbp(p.draftNet)} ex VAT${withOthers}, but ${billing}. ${stopped} `
    + `Check the job's lines in HireHop, delete draft ${p.draftId}, then ${p.retryHint}.`;
}

async function raiseSteps(job: JobRow, rep: CloseReporter, allowNotReturned: boolean): Promise<string> {
  const plan = await buildPlan(job);
  const inv = plan.invoice;
  const hhJobNumber = plan.hhJobNumber;
  if (plan.cancellation) {
    // A cancelled job's invoice is its fee — one Misc income line (cancellation-close.ts).
    if (inv.blockers.length) await rep.stop('invoice_preflight', inv.blockers.join(' '));
    if (inv.netToInvoice < PENNY) await rep.stop('invoice_preflight', 'Nothing to invoice — the cancellation fee is already on an invoice (or there is no fee).');
    return raiseCancellationFee(rep, { jobId: job.id, hhJobNumber, facts: plan.cancellation, userId: rep.userId ?? null });
  }
  const blockers = inv.blockers.filter((b) => !(allowNotReturned && b.includes("hasn't returned yet")));
  if (plan.blockers.some((b) => b.startsWith('This job') || b.startsWith('Internal'))) blockers.unshift(...plan.blockers);
  if (blockers.length) await rep.stop('invoice_preflight', blockers.join(' '));
  if (inv.netToInvoice < PENNY && !inv.draft) await rep.stop('invoice_preflight', 'Nothing to invoice — every line is already on an invoice.');

  // 1. Draft (or adopt). The job's FIRST invoice is laid out like the quote — an empty
  // draft with the supply list pasted in (§3.1). A top-up invoice ("added since") stays
  // "include all owing items": pasting the whole list again would invoice lines twice.
  let rows = await readBillingRows(hhJobNumber);
  let draftId = inv.draft?.invoiceId ?? 0;
  const firstInvoice = !invoiceRows(rows).some((r) => !isProformaRow(r) && !isChargeOnlyInvoice(r));
  const paste = !draftId && firstInvoice && await pasteLayoutEnabled();
  if (!draftId) {
    const before = new Set(draftRows(rows).map(idOf));
    const { res, newId } = await postDraftInvoice(hhJobNumber, `Job ${hhJobNumber}`, { all: paste ? 0 : 1 });
    rows = await readBillingRows(hhJobNumber);
    const fresh = draftRows(rows).filter((r) => !before.has(idOf(r)));
    if (fresh.length !== 1) {
      await rep.stop('invoice_draft', fresh.length === 0
        ? `HireHop did not create the draft (${res.error || 'no new draft on the job afterwards'}). Nothing was changed — ${rep.retryHint} to try again.`
        : `HireHop now shows ${fresh.length} new drafts on the job — expected one. Delete the extra draft(s) by hand, then ${rep.retryHint}.`);
    }
    draftId = idOf(fresh[0]);
    if (newId && newId !== draftId) {
      await rep.stop('invoice_draft', `HireHop returned invoice ${newId} but the job shows draft ${draftId}. Check the job by hand.`);
    }
    if (paste) {
      await pasteSupplyList(rep, hhJobNumber, draftId, fresh[0]);
      rows = await readBillingRows(hhJobNumber);
    } else {
      await rep.log('invoice_draft', true, `Draft invoice ${draftId} created from the uninvoiced lines.`);
    }
  } else {
    await rep.log('invoice_draft', true, `Using the draft invoice ${draftId} already on the job.`);
  }

  // 2. Penny check: the drafts' net + what was already invoiced = HireHop's quoted net.
  const draft = findInvoice(rows, draftId);
  if (!draft) await rep.stop('invoice_penny', `Draft ${draftId} is no longer on the job. ${capitalise(rep.retryHint)} to start again.`);
  const draftNet = invoiceNet(draft!) ?? 0;
  const draftGross = invoiceGross(draft!) ?? 0;
  const othersNet = round2(invoiceRows(rows).filter((r) => !isProformaRow(r) && !isChargeOnlyInvoice(r) && idOf(r) !== draftId).reduce((s, r) => s + (invoiceNet(r) ?? 0), 0));
  const accrued = accruedNetOf(rows);
  if (Math.abs(round2(draftNet + othersNet) - accrued) >= PENNY) {
    await rep.stop('invoice_penny', pennyStopMessage({
      draftId, draftNet, othersNet, accrued, retryHint: rep.retryHint,
      how: inv.draft ? 'adopted' : paste ? 'pasted' : 'drafted',
    }));
  }
  await rep.log('invoice_penny', true, `Draft ${draftId}: ${gbp(draftNet)} ex VAT, ${gbp(draftGross)} inc VAT — matches HireHop's quoted total.`);

  // 2b. EU hire: split the VAT on the draft (§10.1). splitEuDraft reads back
  // every write, checks the whole draft and (first invoice) matches it to the
  // portal's figure before returning — so a split draft goes straight on to be
  // approved like any other (jon, 12 Oct, after 15745 split cleanly).
  let gross = draftGross;
  if (inv.euTrigger && invoiceStatus(draft!) < 2) {
    await splitEuDraft(rep, { jobId: job.id, hhJobNumber, draftId, firstInvoice: othersNet < PENNY });
    rows = await readBillingRows(hhJobNumber);
    gross = invoiceGross(findInvoice(rows, draftId)!) ?? draftGross;
  }

  // 3. Approve, dated today (§1.11).
  let number = '';
  if (invoiceStatus(draft!) < 2) {
    const res = await postApproveInvoice(draftId, hhLocalNow());
    rows = await readBillingRows(hhJobNumber);
    const after = findInvoice(rows, draftId);
    number = String(after?.data?.NUMBER || '');
    if (!after || invoiceStatus(after) < 2 || !number) {
      await rep.stop('invoice_approve', `HireHop did not approve invoice ${draftId} (${res.error || 'still a draft on read-back'}). Nothing has gone to Xero — ${rep.retryHint} to try again.`);
    }
    await rep.log('invoice_approve', true, `Invoice ${number} (${draftId}) approved, dated today.`);
    await pushInvoiceToXero(rep, {
      label: `hire close-out — invoice ${number}`, hhJobNumber, invoiceId: draftId, number, gross,
      saved: { ...(res.data || {}), hh_task: res.data?.hh_task || 'post_invoice_credit', hh_id: res.data?.hh_id || draftId },
      alert: { jobId: job.id, what: `hire invoice ${number}` },
    });
  } else {
    number = String(draft!.data?.NUMBER || draftId);
    if (!invoiceInXero(draft!)) {
      await pushInvoiceToXero(rep, {
        label: `hire close-out — invoice ${number}`, hhJobNumber, invoiceId: draftId, number, gross,
        saved: { hh_task: 'post_invoice_credit', hh_id: draftId, hh_acc_package_id: 3, hh_package_type: 1 },
        alert: { jobId: job.id, what: `hire invoice ${number}` },
      });
    }
  }
  return `Invoice ${number} raised for ${gbp(gross)} and sent to Xero. Allocate the payments next.`;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── The plan (§4.3, §6) ──────────────────────────────────────────────────

/**
 * OP-side facts the Money panel shows beside HireHop's: the Invoice
 * requirement (its id, so the panel can tick it Sent, and whether it is), and
 * how many Problems are open.
 */
async function jobFacts(jobId: string): Promise<{ invoiceRequirementId: string | null; invoiceSent: boolean; openProblems: number }> {
  const r = await query(
    `SELECT req.id AS invoice_req_id, req.status AS invoice_req_status,
            (SELECT COUNT(*) FROM job_issues
              WHERE job_id = $1 AND status NOT IN ('resolved', 'written_off', 'cancelled'))::int AS open_problems
       FROM (SELECT 1) one
       LEFT JOIN LATERAL (
         SELECT id, status FROM job_requirements
          WHERE job_id = $1 AND requirement_type = 'invoice' AND COALESCE(notes, '') NOT LIKE '%[Suspended:%'
          -- A cancelled job's own fee-invoice card is made after the cancellation sweep closed
          -- the hire's one: prefer the card that is still live.
          ORDER BY (status = 'cancelled'), created_at LIMIT 1
       ) req ON true`,
    [jobId],
  );
  const row = r.rows[0] || {};
  return {
    invoiceRequirementId: row.invoice_req_id ?? null,
    invoiceSent: row.invoice_req_status === 'done',
    openProblems: Number(row.open_problems ?? 0),
  };
}

async function buildPlan(job: JobRow): Promise<CloseOutPlan> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const base = {
    jobId: job.id, hhJobNumber: Number(job.hh_job_number), jobName: job.job_name, hhStatus: null as number | null,
    invoice: { accruedNet: 0, invoicedNet: 0, netToInvoice: 0, draft: null, euTrigger: false, notReturned: false, blockers: [] as string[], ready: false } as InvoicePlan,
    invoices: [] as CloseOutInvoice[], payments: [] as CloseOutPayment[], allocations: [] as PlannedAllocation[],
    surplus: [] as Array<{ depositId: number; amount: number }>, shortfall: 0, excessHeld: 0,
    blockers, warnings, sentences: [] as string[], ready: false, readyToComplete: false,
    log: await readLog(job.id),
    ...await jobFacts(job.id),
    paymentTarget: null as CloseOutPlan['paymentTarget'],
    cancellation: null as CancellationPlan | null,
  };
  if (!job.hh_job_number) { blockers.push('This job has no HireHop job number.'); return base; }
  if (job.is_internal) { blockers.push('Internal job — there is no client to invoice.'); return base; }
  if (job.pipeline_status === 'lost') { blockers.push('This job is lost — there is nothing to invoice.'); return base; }
  // A cancelled job is planned like a hire, with its cancellation fee in place of the hire invoice.
  const cancelled = job.pipeline_status === 'cancelled';

  const hhJobNumber = Number(job.hh_job_number);
  const [rows, hhStatus, excess] = await Promise.all([
    readBillingRows(hhJobNumber),
    readJobStatus(hhJobNumber),
    query(`SELECT COALESCE(SUM(held_amount), 0) AS held FROM v_excess_held WHERE job_id = $1`, [job.id]),
  ]);
  base.hhStatus = hhStatus;
  base.excessHeld = round2(Number(excess.rows[0]?.held ?? 0));
  warnings.push(...await adoptLostXeroInvoices(rows));
  if (!cancelled && hhStatus != null && hhStatus < HH_RETURNED_INCOMPLETE) {
    warnings.push(`HireHop says this job hasn't returned yet (status ${hhStatus}).`);
  }

  // Invoices.
  const invoices = approvedInvoices(rows);
  base.invoices = invoices;
  const open = invoices.filter((i) => i.owing >= PENNY);

  // A cancelled job's invoice is its fee (cancellation-close.ts); a hire's is its lines (§4.1).
  let feeInvoiced = false;
  if (cancelled) {
    const facts = await readCancellation(job.id);
    const c = planCancellationInvoice(rows, hhStatus, facts, hhJobNumber);
    base.invoice = c.invoice;
    blockers.push(...c.planBlockers);
    warnings.push(...c.warnings);
    feeInvoiced = c.invoiced;
    base.cancellation = { ...facts, invoiced: c.invoiced, refundReminders: await readRefundReminders(job.id), settled: false };
  }
  if (invoices.length === 0 && !(cancelled && feeInvoiced)) {
    blockers.push('Raise the invoice first — the job has no approved invoice in HireHop.');
  }
  // Several owing: the hire payments go to ONE of them, chosen by a manager — never spread
  // oldest-first, or hire money would spill onto a damage invoice the client wants kept apart.
  let target: CloseOutInvoice | null = open.length === 1 ? open[0] : null;
  if (open.length > 1) {
    const chosen = base.log.find((e) => e.step === PAYMENT_TARGET_STEP && e.ok);   // newest first
    target = open.find((i) => i.invoiceId === Number((chosen?.hh_refs as any)?.invoiceId || 0)) ?? null;
    if (target) base.paymentTarget = { invoiceId: target.invoiceId, number: target.number };
    else blockers.push(`${open.length} invoices are owing (${open.map((i) => i.number).join(', ')}) — choose which one the hire payments go to.`);
  }
  for (const inv of open) {
    if (!inv.inXero) blockers.push(`${inv.number} is approved in HireHop but has not reached Xero — check it there first.`);
  }
  // Excess on an invoice that OP doesn't know was claimed — the same check the nightly sweep makes.
  const excessNotes = new Set<string>();
  for (const inv of invoices) {
    for (const note of await unrecordedExcessUse(rows, inv.invoiceId, await sourceJobRows(rows, inv.invoiceId))) excessNotes.add(note);
  }
  blockers.push(...excessNotes);

  // The Invoice card (§4.1): what is left to bill, and whether Raise invoice may run.
  if (!cancelled) base.invoice = await planInvoice(rows, invoices, hhJobNumber, hhStatus);
  if (base.invoice.euTrigger && (base.invoice.netToInvoice >= PENNY || base.invoice.draft)) {
    warnings.push('EU hire: the invoice\'s VAT is split by UK / non-UK days (HMRC 741A).');
  }

  // Deposits — HireHop vs OP (§6).
  const hireRows = hireDepositRows(rows);
  const hireIds = new Set(hireRows.map(idOf));
  const op = await query(
    `SELECT hirehop_deposit_id, payment_type, amount::float8 AS amount, payment_method, source, notes
       FROM job_payments
      WHERE job_id = $1 AND payment_status = 'completed' AND hirehop_deposit_id IS NOT NULL`,
    [job.id],
  );
  const opDeposits = op.rows.filter((r: any) => ['deposit', 'balance'].includes(r.payment_type) && r.source !== 'cross_job_apply');
  const opRefunds = op.rows.filter((r: any) => r.payment_type === 'refund');
  for (const row of hireRows) {
    const id = idOf(row);
    const credit = round2(parseFloat(row.credit ?? row.data?.credit ?? '0'));
    const mine = opDeposits.filter((r: any) => Number(r.hirehop_deposit_id) === id);
    if (mine.length === 0) {
      blockers.push(`Payment ${id} (${gbp(credit)}, ${String(row.data?.DESCRIPTION || row.desc || '').trim() || 'no description'}) `
        + 'is in HireHop but OP has no record of taking it — check how it was taken before allocating.');
    } else {
      const opTotal = round2(mine.reduce((s: number, r: any) => s + Number(r.amount), 0));
      if (Math.abs(opTotal - credit) >= PENNY) {
        blockers.push(`Payment ${id} is ${gbp(credit)} in HireHop but ${gbp(opTotal)} in OP — the two must agree before allocating.`);
      }
    }
  }
  for (const r of opDeposits) {
    if (!hireIds.has(Number(r.hirehop_deposit_id)) && !rows.some((row) => kindOf(row) === 6 && idOf(row) === Number(r.hirehop_deposit_id))) {
      blockers.push(`OP recorded a ${gbp(Number(r.amount))} payment as HireHop deposit ${r.hirehop_deposit_id}, but HireHop has no such deposit.`);
    }
  }
  for (const row of refundRows(rows, hireIds)) {
    const d = row.data || {};
    const depositId = Number(d.OWNER_DEPOSIT);
    const amount = round2(Math.abs(parseFloat(row.credit ?? d.credit ?? '0')));
    const desc = String(d.DESCRIPTION || row.desc || '').trim();
    const matched = opRefunds.some((r: any) => Number(r.hirehop_deposit_id) === depositId && Math.abs(Math.abs(Number(r.amount)) - amount) < PENNY);
    if (matched) continue;
    const when = String(d.DATE || row.date || '').slice(0, 10);
    if (!desc) {
      blockers.push(`HireHop shows ${gbp(amount)} refunded from payment ${depositId}${when ? ` on ${when}` : ''} but OP has no refund — `
        + 'if nobody refunded it, delete that payment row in HireHop (and its Xero mirror), then try again.');
    } else {
      warnings.push(`HireHop shows ${gbp(amount)} refunded from payment ${depositId} ("${desc}") that OP did not record.`);
    }
  }

  // Payments with money left, and the plan.
  const payments = hirePayments(rows);
  base.payments = payments;
  for (const p of payments) {
    const row = rows.find((r) => kindOf(r) === 6 && idOf(r) === p.depositId);
    if (!String(row?.data?.ACC_DATA?.OverpaymentID ?? '').trim()) {
      blockers.push(`Payment ${p.depositId} (${gbp(p.available)}) isn't in Xero as a payment (no overpayment id) — it can't be applied there.`);
    }
    if (p.bankId == null) blockers.push(`Couldn't read which bank payment ${p.depositId} is on.`);
  }
  const { allocations, surplus } = planAllocations(target ? [target] : [], payments);
  base.allocations = allocations;
  base.surplus = surplus;
  base.shortfall = round2(open.reduce((s, i) => s + i.owing, 0) - allocations.reduce((s, a) => s + a.amount, 0));
  if (base.excessHeld >= PENNY) {
    warnings.push(`${gbp(base.excessHeld)} excess is still held on this job — claim, roll over or reimburse it from the Excess card. It is never allocated here.`);
  }

  // Sentences.
  const sentences: string[] = [];
  for (const a of allocations) sentences.push(`Allocate ${gbp(a.amount)} of payment ${a.depositId} to ${a.invoiceNumber}.`);
  if (cancelled && base.invoice.netToInvoice >= PENNY) {
    sentences.unshift(`Raise the cancellation fee invoice: ${gbp(base.invoice.netToInvoice)} + VAT = ${gbp(base.cancellation!.feeGross)}.`);
  }
  for (const s of surplus) {
    sentences.push(cancelled
      ? `Refund ${gbp(s.amount)} of payment ${s.depositId} to the client.`
      : `Leave ${gbp(s.amount)} of payment ${s.depositId} unallocated — refund it, apply it to another job, or hold it on account.`);
  }
  if (base.paymentTarget) {
    for (const inv of open.filter((i) => i.invoiceId !== target!.invoiceId)) {
      sentences.push(`${inv.number} (${gbp(inv.owing)} owing) takes no hire payments — settle it with an excess claim or Record payment.`);
    }
  }
  if (base.shortfall >= PENNY) sentences.push(`The client will still owe ${gbp(base.shortfall)} after this.`);
  if (allocations.length === 0 && blockers.length === 0) {
    sentences.push(open.length ? 'Nothing to allocate — no hire payment is holding money.' : 'Every invoice is at £0.00 in HireHop.');
  }
  base.sentences = sentences;
  base.ready = blockers.length === 0 && allocations.length > 0;
  base.readyToComplete = !cancelled && blockers.length === 0 && invoices.length > 0 && open.length === 0 && surplus.length === 0 && payments.length === 0;
  if (base.cancellation) {
    base.cancellation.settled = blockers.length === 0 && feeInvoiced && open.length === 0 && payments.length === 0;
    if (base.cancellation.settled) await markCancellationReconciled(job.id);
  }
  return base;
}

/**
 * What Allocate would do, without doing it. A job OP already knows is
 * Completed is not re-read from HireHop on every page view (jon, 9 Oct: once
 * it's completed it's completed) — the card shows OP's own record instead,
 * and "Check again" (`fresh`) forces the full read.
 */
const PAYMENT_TARGET_STEP = 'payments_target';

/**
 * A manager chooses which of several owing invoices the hire payments go to. Recorded in
 * the close-out log (newest wins) — nothing in HireHop or Xero changes until Allocate.
 */
export async function setPaymentTarget(jobIdOrNumber: string, userId: string | null, invoiceId: number): Promise<CloseOutPlan> {
  const job = await loadJob(jobIdOrNumber);
  const plan = await buildPlan(job);
  const inv = plan.invoices.find((i) => i.invoiceId === invoiceId && i.owing >= PENNY);
  if (!inv) throw Object.assign(new Error('That invoice is not owing on this job.'), { status: 400 });
  await log(job.id, userId, PAYMENT_TARGET_STEP, true, `Hire payments go to ${inv.number}.`, { invoiceId: inv.invoiceId, number: inv.number });
  return buildPlan(job);
}

export async function planHireCloseOut(jobIdOrNumber: string, opts: { fresh?: boolean } = {}): Promise<CloseOutPlan> {
  const job = await loadJob(jobIdOrNumber);
  if (!opts.fresh && job.pipeline_status === 'completed') {
    const entries = await readLog(job.id);
    const completed = entries.find((e) => e.step === 'complete' && e.ok);
    // A charge raised after completion (spec §4.6) can still be owed — read HireHop live.
    const charged = entries.some((e) => e.step === 'charge' && e.ok);
    if (completed && !charged) {
      return {
        jobId: job.id, hhJobNumber: Number(job.hh_job_number), jobName: job.job_name, hhStatus: HH_COMPLETED_STATUS, fromLog: true,
        invoice: { accruedNet: 0, invoicedNet: 0, netToInvoice: 0, draft: null, euTrigger: false, notReturned: false, blockers: [], ready: false },
        invoices: [], payments: [], allocations: [], surplus: [], shortfall: 0, excessHeld: 0,
        blockers: [], warnings: [],
        sentences: [`Completed in HireHop${completed.user_name ? ` by ${completed.user_name}` : ''} on ${String(completed.created_at).slice(0, 10)}.`],
        ready: false, readyToComplete: false, log: entries, ...await jobFacts(job.id), paymentTarget: null, cancellation: null,
      };
    }
  }
  return buildPlan(job);
}

// ── The one button (§3, Oct 2026): invoice if needed, then allocate ──────

/**
 * What the card's main button does: raise the invoice when there is anything
 * left to bill (or a draft to finish), then allocate every hire deposit in
 * HireHop and apply the credits in Xero. One press for the normal case; a
 * run that stops says where, and the same button carries on from there.
 * Complete stays its own button — jobs are deliberately left open while
 * damage quotes or missing items are pending (jon, 9 Oct).
 */
export async function runHireCloseOut(jobIdOrNumber: string, userId: string | null,
  opts: { allowNotReturned?: boolean } = {}): Promise<CloseOutResult> {
  const job = await loadJob(jobIdOrNumber);
  return withJobLock(job.id, async () => {
    const rep = reporter(job.id, userId, 'press the Money tab button');
    let done = false;
    let message: string;
    try {
      const plan = await buildPlan(job);
      const parts: string[] = [];
      if (plan.invoice.netToInvoice >= PENNY || plan.invoice.draft) {
        parts.push(await raiseSteps(job, rep, !!opts.allowNotReturned));
      }
      parts.push(await allocateSteps(job, rep));
      message = parts.join(' ').replace('Allocate the payments next. ', '');
      done = true;
    } catch (err) {
      if (!(err instanceof Stop)) {
        await log(job.id, userId, 'error', false, err instanceof Error ? err.message : String(err)).catch(() => undefined);
      }
      message = err instanceof Error ? err.message : String(err);
    }
    return { done, message, plan: await buildPlan(job) };
  });
}

// ── Allocate ─────────────────────────────────────────────────────────────

/** One job at a time, in this process. */
const running = new Set<string>();

export async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  if (running.has(jobId)) throw new Error('Someone else is working on this job\'s money right now — try again in a moment.');
  running.add(jobId);
  try { return await fn(); } finally { running.delete(jobId); }
}

/** For a cross-job allocation, the source job's billing rows (its deposit carries the Xero overpayment id). */
export async function sourceJobRows(rows: Row[], invoiceId: number): Promise<Row[]> {
  const mine = new Set(rows.filter((r) => kindOf(r) === 6).map(idOf));
  const extra: Row[] = [];
  const seen = new Set<number>();
  for (const app of invoiceAllocations(rows, invoiceId)) {
    const depositId = Number(app.data?.OWNER_DEPOSIT ?? 0);
    if (!depositId || mine.has(depositId)) continue;
    const m = /^(\d{4,6})\s*-/.exec(String(app.data?.DESCRIPTION || app.desc || ''));
    const src = m ? parseInt(m[1], 10) : 0;
    if (!src || seen.has(src)) continue;
    seen.add(src);
    try { extra.push(...await readBillingRows(src)); } catch (e) { console.warn(`[hire-close-out] could not read source job ${src}:`, e); }
  }
  return extra;
}

/**
 * Do the plan: allocate in HireHop (read back each), then apply the credits in Xero (read back).
 *
 * `onlyFromDeposit` is the arrival hook's guard (§4.5): refuse unless every planned
 * allocation comes from that one payment, so money someone left unallocated on purpose
 * (to refund, or held on account) is never picked up by a payment that just arrived.
 */
export async function runHireAllocation(jobIdOrNumber: string, userId: string | null,
  opts: { onlyFromDeposit?: number; retryHint?: string } = {}): Promise<CloseOutResult> {
  const job = await loadJob(jobIdOrNumber);
  return withJobLock(job.id, async () => {
    const rep = reporter(job.id, userId, opts.retryHint ?? 'press Allocate payments');
    let done = false;
    let message: string;
    try {
      message = await allocateSteps(job, rep, opts.onlyFromDeposit);
      done = true;
    } catch (err) {
      if (!(err instanceof Stop)) {
        await log(job.id, userId, 'error', false, err instanceof Error ? err.message : String(err)).catch(() => undefined);
      }
      message = err instanceof Error ? err.message : String(err);
    }
    return { done, message, plan: await buildPlan(job) };
  });
}

async function allocateSteps(job: JobRow, rep: CloseReporter, onlyFromDeposit?: number): Promise<string> {
  const plan = await buildPlan(job);
  if (plan.blockers.length) await rep.stop('preflight', plan.blockers.join(' '));
  if (onlyFromDeposit != null) {
    const others = [...new Set(plan.allocations.filter((a) => a.depositId !== onlyFromDeposit).map((a) => a.depositId))];
    if (others.length || !plan.allocations.length) {
      await rep.stop('arrival', others.length
        ? `Payment ${onlyFromDeposit} arrived, but payment${others.length > 1 ? 's' : ''} ${others.join(', ')} on this job `
          + `still hold${others.length > 1 ? '' : 's'} money and would be used first — left for a person to allocate.`
        : `Payment ${onlyFromDeposit} arrived, but there is nothing for it to pay — left for a person.`);
    }
  }
  const hhJobNumber = plan.hhJobNumber;
  await rep.log('preflight', true, `Clean. ${plan.sentences.join(' ')}`);

  // 1. HireHop, one application at a time, each read back.
  let rows = await readBillingRows(hhJobNumber);
  for (const a of plan.allocations) {
    const before = readDepositAvailability(rows, a.depositId)?.available ?? 0;
    const invBefore = invoiceOwing(findInvoice(rows, a.invoiceId) || {}) ?? 0;
    const res = await postAllocation({ depositId: a.depositId, bankId: a.bankId, amount: a.amount, invoiceId: a.invoiceId });
    rows = await readBillingRows(hhJobNumber);
    const after = readDepositAvailability(rows, a.depositId)?.available ?? 0;
    const invAfter = invoiceOwing(findInvoice(rows, a.invoiceId) || {}) ?? 0;
    const depositMoved = Math.abs((before - after) - a.amount) < PENNY;
    const invoiceMoved = Math.abs((invBefore - invAfter) - a.amount) < PENNY;
    if (!res.success || !depositMoved || !invoiceMoved) {
      await rep.stop('allocate_hh', `HireHop did not allocate ${gbp(a.amount)} of payment ${a.depositId} to ${a.invoiceNumber}`
        + (res.error ? ` (${res.error})` : '')
        + `: the payment went from ${gbp(before)} to ${gbp(after)} free and the invoice from ${gbp(invBefore)} to ${gbp(invAfter)} owing. `
        + `Nothing more was allocated — check the job in HireHop, then ${rep.retryHint}.`);
    }
    await log(job.id, null, 'allocate_hh', true,
      `${gbp(a.amount)} of payment ${a.depositId} allocated to ${a.invoiceNumber} in HireHop — invoice now ${gbp(invAfter)} owing.`,
      { depositId: a.depositId, invoiceId: a.invoiceId, amount: a.amount });
  }

  // 2. Xero — every allocation on every approved invoice, not just the ones just made.
  await adoptLostXeroInvoices(rows);
  const invoices = approvedInvoices(rows);
  for (const inv of invoices) {
    if (!invoiceAllocations(rows, inv.invoiceId).length) continue;
    if (!inv.inXero) {
      await rep.stop('allocate_xero', `${inv.number} has not reached Xero, so its payments can't be applied there. Check it in Xero, then ${rep.retryHint}.`);
    }
    const extraRows = await sourceJobRows(rows, inv.invoiceId);
    await applyCreditsInXero(rep, rows, inv.invoiceId, inv.number, { extraRows, expectedDue: inv.owing });
  }

  const after = await buildPlan(job);
  const parts: string[] = [];
  if (plan.allocations.length) parts.push(`${plan.allocations.length === 1 ? 'Payment allocated' : `${plan.allocations.length} payments allocated`} in HireHop and Xero.`);
  else parts.push('Nothing to allocate in HireHop; Xero checked.');
  if (after.shortfall >= PENNY) parts.push(`The client still owes ${gbp(after.shortfall)}.`);
  const left = round2(after.surplus.reduce((s, x) => s + x.amount, 0));
  if (after.cancellation) {
    // What is left after the fee is a refund due. OP's reminder follows the real figure;
    // the refund itself is a person pressing Process (never moved here).
    const note = await syncRefundReminder(job.id, left, rep.userId ?? null);
    if (note) parts.push(note);
  } else if (after.surplus.length) {
    parts.push(`${gbp(left)} is unallocated — refund it, apply it to another job, or hold it on account.`);
  }
  if (after.readyToComplete) parts.push('Ready to complete.');
  return parts.join(' ');
}

// ── Complete ─────────────────────────────────────────────────────────────

/**
 * HireHop status 11. Refuses (with the reason) unless every invoice is paid in
 * HireHop AND Xero and no hire deposit holds money. Excess still held is a
 * warning: `allowExcessHeld` is the manager's "Complete anyway".
 */
export async function completeHireJob(jobIdOrNumber: string, userId: string | null,
  opts: { allowExcessHeld?: boolean } = {}): Promise<CloseOutResult> {
  const job = await loadJob(jobIdOrNumber);
  return withJobLock(job.id, async () => {
    const rep = reporter(job.id, userId, 'press Complete job');
    let done = false;
    let message: string;
    try {
      const plan = await buildPlan(job);
      if (plan.cancellation) await rep.stop('complete', 'A cancelled job stays Cancelled in HireHop — it is never completed.');
      const reasons = [...plan.blockers];
      const open = plan.invoices.filter((i) => i.owing >= PENNY);
      if (open.length) reasons.push(`${open.map((i) => `${i.number} still shows ${gbp(i.owing)} owing`).join('; ')} in HireHop.`);
      if (plan.surplus.length) {
        reasons.push(`${gbp(round2(plan.surplus.reduce((s, x) => s + x.amount, 0)))} of the client's money is unallocated — `
          + 'refund it, apply it to another job, or record that it is held on account first.');
      }
      if (plan.excessHeld >= PENNY && !opts.allowExcessHeld) {
        reasons.push(`${gbp(plan.excessHeld)} excess is still held — claim, roll over or reimburse it, or a manager can complete anyway.`);
      }
      if (!reasons.length) {
        if (!isXeroConfigured()) reasons.push('OP has no Xero connection on this server, so it cannot confirm the invoices are paid in Xero.');
        for (const inv of plan.invoices) {
          if (!inv.xeroId) { reasons.push(`${inv.number} has not reached Xero.`); continue; }
          const x = await xeroBroker.getInvoice(inv.xeroId);
          const due = round2(Number(x?.AmountDue) || 0);
          if (!x) reasons.push(`Xero can't find ${inv.number}.`);
          else if (due >= PENNY) reasons.push(`${inv.number} still shows ${gbp(due)} due in Xero — press Allocate payments to apply the credit.`);
        }
      }
      if (reasons.length) await rep.stop('complete', reasons.join(' '));
      await completeJob(rep, plan.hhJobNumber);
      // HireHop was told no_webhook, so apply the same transition OP's webhook
      // would (pipeline_status → completed, cascades, timeline) right now.
      try {
        const mirrored = await handleJobStatusChange({ STATUS: HH_COMPLETED_STATUS }, undefined, plan.hhJobNumber);
        if (!mirrored.success) await log(job.id, userId, 'complete', true, `HireHop is Completed; OP's own status was not updated (${mirrored.message}) — the next HireHop sync will.`);
      } catch (e) {
        await log(job.id, userId, 'complete', true, `HireHop is Completed; OP's own status was not updated (${e instanceof Error ? e.message : String(e)}) — the next HireHop sync will.`);
      }
      if (plan.excessHeld >= PENNY) {
        await log(job.id, userId, 'complete', true, `Completed with ${gbp(plan.excessHeld)} excess still held (manager override).`);
      }
      message = `HireHop job ${plan.hhJobNumber} is Completed.`;
      done = true;
    } catch (err) {
      if (!(err instanceof Stop)) {
        await log(job.id, userId, 'error', false, err instanceof Error ? err.message : String(err)).catch(() => undefined);
      }
      message = err instanceof Error ? err.message : String(err);
    }
    return { done, message, plan: await buildPlan(job) };
  });
}
