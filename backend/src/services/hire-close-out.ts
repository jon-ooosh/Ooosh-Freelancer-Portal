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
  invoiceAllocations, unallocatedPayments, readJobStatus,
  postAllocation, applyCreditsInXero, completeJob,
} from './hh-invoice-close';
import xeroBroker from './xero-broker';
import { isXeroConfigured } from '../config/xero';
import { DISPLAY_NAME_SQL } from './display-name';

/* eslint-disable @typescript-eslint/no-explicit-any */

const HH_RETURNED_INCOMPLETE = 6;

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

export interface CloseOutPlan {
  jobId: string;
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
}

export interface CloseOutResult {
  done: boolean;
  message: string;
  plan: CloseOutPlan;
}

interface JobRow {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  is_internal: boolean | null;
  pipeline_status: string | null;
}

// ── Log ──────────────────────────────────────────────────────────────────

async function log(jobId: string, userId: string | null, step: string, ok: boolean, detail: string,
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

function reporter(jobId: string, userId: string | null, retryHint: string): CloseReporter {
  return {
    log: (step, ok, detail) => log(jobId, userId, step, ok, detail),
    stop: async (step, detail) => { await log(jobId, userId, step, false, detail); throw new Stop(detail); },
    retryHint,
  };
}

// ── Reading ──────────────────────────────────────────────────────────────

async function loadJob(jobIdOrNumber: string): Promise<JobRow> {
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
function approvedInvoices(rows: Row[]): CloseOutInvoice[] {
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
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.invoiceId - b.invoiceId);
}

/** Every positive, non-excess deposit on the job (allocated or not). */
function hireDepositRows(rows: Row[]): Row[] {
  return rows.filter((row) => kindOf(row) === 6
    && parseFloat(row.credit ?? row.data?.credit ?? '0') > 0
    && !isExcessDeposit(row));
}

/** Hire deposits with money left, oldest first, with the display fields. */
function hirePayments(rows: Row[]): CloseOutPayment[] {
  const banks: Array<{ ID: number; NAME: string }> = (rows as any).banks || [];
  const byId = new Map(rows.filter((r) => kindOf(r) === 6).map((r) => [idOf(r), r]));
  return unallocatedPayments(rows, isExcessDeposit)
    .map((p) => {
      const row = byId.get(p.depositId);
      return {
        ...p,
        bankName: banks.find((b) => Number(b.ID) === p.bankId)?.NAME ?? null,
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

// ── The plan (§4.3, §6) ──────────────────────────────────────────────────

async function buildPlan(job: JobRow): Promise<CloseOutPlan> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const base = {
    jobId: job.id, hhJobNumber: Number(job.hh_job_number), jobName: job.job_name, hhStatus: null as number | null,
    invoices: [] as CloseOutInvoice[], payments: [] as CloseOutPayment[], allocations: [] as PlannedAllocation[],
    surplus: [] as Array<{ depositId: number; amount: number }>, shortfall: 0, excessHeld: 0,
    blockers, warnings, sentences: [] as string[], ready: false, readyToComplete: false,
    log: await readLog(job.id),
  };
  if (!job.hh_job_number) { blockers.push('This job has no HireHop job number.'); return base; }
  if (job.is_internal) { blockers.push('Internal job — there is no client to invoice.'); return base; }
  if (job.pipeline_status === 'cancelled' || job.pipeline_status === 'lost') {
    blockers.push(`This job is ${job.pipeline_status} — cancellations have their own path.`); return base;
  }

  const hhJobNumber = Number(job.hh_job_number);
  const [rows, hhStatus, excess] = await Promise.all([
    readBillingRows(hhJobNumber),
    readJobStatus(hhJobNumber),
    query(`SELECT COALESCE(SUM(held_amount), 0) AS held FROM v_excess_held WHERE job_id = $1`, [job.id]),
  ]);
  base.hhStatus = hhStatus;
  base.excessHeld = round2(Number(excess.rows[0]?.held ?? 0));
  if (hhStatus != null && hhStatus < HH_RETURNED_INCOMPLETE) {
    warnings.push(`HireHop says this job hasn't returned yet (status ${hhStatus}).`);
  }

  // Invoices.
  const invoices = approvedInvoices(rows);
  base.invoices = invoices;
  const open = invoices.filter((i) => i.owing >= PENNY);
  if (invoices.length === 0) {
    blockers.push('Raise the invoice first — the job has no approved invoice in HireHop.');
  }
  if (open.length > 1) {
    blockers.push(`${open.length} invoices are owing (${open.map((i) => i.number).join(', ')}) — allocating across more than `
      + 'one open invoice is not switched on yet. Allocate this one by hand in HireHop, or ask for it to be turned on.');
  }
  for (const inv of open) {
    if (!inv.inXero) blockers.push(`${inv.number} is approved in HireHop but has not reached Xero — check it there first.`);
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
  const { allocations, surplus, shortfall } = planAllocations(open.length === 1 ? open : [], payments);
  base.allocations = allocations;
  base.surplus = surplus;
  base.shortfall = open.length === 1 ? shortfall : round2(open.reduce((s, i) => s + i.owing, 0));
  if (base.excessHeld >= PENNY) {
    warnings.push(`${gbp(base.excessHeld)} excess is still held on this job — claim, roll over or reimburse it from the Excess card. It is never allocated here.`);
  }

  // Sentences.
  const sentences: string[] = [];
  for (const a of allocations) sentences.push(`Allocate ${gbp(a.amount)} of payment ${a.depositId} to ${a.invoiceNumber}.`);
  for (const s of surplus) sentences.push(`Leave ${gbp(s.amount)} of payment ${s.depositId} unallocated — refund it, apply it to another job, or hold it on account.`);
  if (base.shortfall >= PENNY) sentences.push(`The client will still owe ${gbp(base.shortfall)} after this.`);
  if (allocations.length === 0 && blockers.length === 0) {
    sentences.push(open.length ? 'Nothing to allocate — no hire payment is holding money.' : 'Every invoice is at £0.00 in HireHop.');
  }
  base.sentences = sentences;
  base.ready = blockers.length === 0 && allocations.length > 0;
  base.readyToComplete = blockers.length === 0 && invoices.length > 0 && open.length === 0 && surplus.length === 0 && payments.length === 0;
  return base;
}

/** What Allocate would do, without doing it. */
export async function planHireCloseOut(jobIdOrNumber: string): Promise<CloseOutPlan> {
  return buildPlan(await loadJob(jobIdOrNumber));
}

// ── Allocate ─────────────────────────────────────────────────────────────

/** One job at a time, in this process. */
const running = new Set<string>();

async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  if (running.has(jobId)) throw new Error('Someone else is working on this job\'s money right now — try again in a moment.');
  running.add(jobId);
  try { return await fn(); } finally { running.delete(jobId); }
}

/** For a cross-job allocation, the source job's billing rows (its deposit carries the Xero overpayment id). */
async function sourceJobRows(rows: Row[], invoiceId: number): Promise<Row[]> {
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

/** Do the plan: allocate in HireHop (read back each), then apply the credits in Xero (read back). */
export async function runHireAllocation(jobIdOrNumber: string, userId: string | null): Promise<CloseOutResult> {
  const job = await loadJob(jobIdOrNumber);
  return withJobLock(job.id, async () => {
    const rep = reporter(job.id, userId, 'press Allocate payments');
    let done = false;
    let message: string;
    try {
      message = await allocateSteps(job, rep);
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

async function allocateSteps(job: JobRow, rep: CloseReporter): Promise<string> {
  const plan = await buildPlan(job);
  if (plan.blockers.length) await rep.stop('preflight', plan.blockers.join(' '));
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
  if (after.surplus.length) parts.push(`${gbp(round2(after.surplus.reduce((s, x) => s + x.amount, 0)))} is unallocated — refund it, apply it to another job, or hold it on account.`);
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
