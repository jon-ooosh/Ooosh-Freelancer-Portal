/**
 * shop-close.ts — the weekly close (docs/SHOP-SALES-SPEC.md §20).
 *
 * Turns a finished week's shop job into: one approved invoice dated the week's
 * Sunday, every payment on the job allocated to it (£0 owing in HireHop AND
 * Xero), the job Completed, and OP knowing the week is done.
 *
 *   1. Pre-flight — the week is over, nothing queued or failed, the balance
 *      check is clean, and there is no invoice on the job yet.
 *   2. Draft invoice — `billing_save.php`, `all: 1` ALWAYS.
 *   3. Penny check — the draft's gross must equal OP's total AND the payments
 *      held. Any difference stops HERE: drafts never reach Xero.
 *   4. Approve (the Xero commit point) — then push it to Xero.
 *   5. Allocate every payment with money left to the invoice — then push each.
 *   6. Complete the job (status 11 keeps sale stock consumed, §2.1).
 *   7. Record it in OP.
 *
 * Every call was captured from HireHop's own UI first
 * (docs/reference/HIREHOP-BILLING-API.md §3–§6). Every write is READ BACK:
 * `success: true` has twice meant nothing (§2.5).
 *
 * RESUMABLE. `close_state` says how far it got; pressing Close again carries
 * on from there. It never creates a second invoice (`hh_invoice_id` is set the
 * moment HireHop returns one) and never allocates a payment twice (it only
 * allocates what HireHop says is still unallocated).
 *
 * Everything runs inside the shop drain lock, so no sale can be pushed onto
 * the job half-way through, and once `close_state` is set the drain sends a
 * late sale to the current week instead (shop-period.ts getShopPeriodForSale).
 *
 * An EMPTY week — every sale cancelled or refunded — has nothing to invoice:
 * it goes straight to Completed with no invoice. (A week with no sales at all
 * has no job, so never reaches here.)
 */
import { query } from '../config/database';
import hhBroker from './hirehop-broker';
import { readBillingRows, readDepositAvailability } from './hh-deposit-release';
import { syncSavedRowToXero, sendXeroSyncFailedAlert } from './hh-xero-sync';
import { withShopDrainLock } from './shop-drain';
import { checkShopPeriodLocked, SHOP_ALERT_RECIPIENT, ShopCheck } from './shop-reconcile';
import { londonDate } from './shop-period';
import { hhLocalNow } from './shop-stock';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

const PENNY = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;
const gbp = (n: number) => `£${n.toFixed(2)}`;

/** HireHop status codes the close sets or refuses. */
const COMPLETED = 11;

export type CloseState = 'drafted' | 'approved' | 'allocated' | 'completed';

export interface CloseLogEntry {
  at: string;
  step: string;
  ok: boolean;
  detail: string;
}

export interface ClosePayment {
  depositId: number;
  bankId: number | null;
  description: string;
  /** Unallocated — what the close will allocate to the invoice. */
  available: number;
}

export interface ClosePreview {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  hhJobNumber: number;
  closeState: CloseState | null;
  hhInvoiceId: number | null;
  hhInvoiceNumber: string | null;
  closedAt: string | null;
  /** True when Close can be pressed (a fresh close whose pre-flight passed, or a resume). */
  ready: boolean;
  /** Plain-English reasons it can't start. Empty when ready. */
  blockers: string[];
  /** OP's own gross for the job: every line it pushed and hasn't removed. */
  expectedGross: number;
  expectedNet: number;
  /** Payments on the job with money not yet allocated. */
  payments: ClosePayment[];
  paymentsHeld: number;
  /** Nothing sold (all cancelled or refunded) — closes with no invoice. */
  empty: boolean;
  /** The date the invoice will carry — the week's Sunday. */
  invoiceDate: string;
  check: ShopCheck | null;
  log: CloseLogEntry[];
}

export interface CloseResult {
  /** True when the week is now fully closed. */
  done: boolean;
  /** What happened, for the person who pressed the button. */
  message: string;
  preview: ClosePreview;
}

interface PeriodRow {
  id: string;
  period_start: string;
  period_end: string;
  hh_job_number: number | null;
  hh_invoice_id: number | null;
  hh_invoice_number: string | null;
  close_state: CloseState | null;
  close_log: CloseLogEntry[] | null;
  closed_at: string | null;
}

async function loadPeriod(periodId: string): Promise<PeriodRow> {
  const r = await query(
    `SELECT id, period_start::text, period_end::text, hh_job_number, hh_invoice_id,
            hh_invoice_number, close_state, close_log, closed_at
       FROM shop_sale_periods WHERE id = $1`,
    [periodId],
  );
  const p = r.rows[0];
  if (!p) throw new Error('That week does not exist.');
  if (!p.hh_job_number) throw new Error('That week has no HireHop job, so there is nothing to close.');
  return p;
}

async function log(periodId: string, step: string, ok: boolean, detail: string): Promise<void> {
  const entry: CloseLogEntry = { at: new Date().toISOString(), step, ok, detail };
  // JSONB — stringify, never a bare JS array (CLAUDE.md).
  await query(
    `UPDATE shop_sale_periods SET close_log = COALESCE(close_log, '[]'::jsonb) || $2::jsonb WHERE id = $1`,
    [periodId, JSON.stringify([entry])],
  );
  console.log(`[shop-close] ${periodId} ${step}: ${ok ? 'ok' : 'STOPPED'} — ${detail}`);
}

// ── Reading HireHop ──────────────────────────────────────────────────────

const kindOf = (row: Row) => parseInt(row.kind ?? '0');
const idOf = (row: Row) => parseInt(row.data?.ID || row.number || '0');

function invoiceRows(rows: Row[]): Row[] {
  return rows.filter((row) => kindOf(row) === 1);
}

function findInvoice(rows: Row[], invoiceId: number): Row | null {
  return invoiceRows(rows).find((row) => idOf(row) === invoiceId) ?? null;
}

function invoiceStatus(row: Row): number {
  return parseInt(row.status ?? row.data?.STATUS ?? '0');
}

/** Gross (inc VAT): `debit`, else NET + TAX. */
function invoiceGross(row: Row): number | null {
  const debit = parseFloat(row.debit ?? row.data?.debit ?? '');
  if (Number.isFinite(debit)) return round2(debit);
  const net = parseFloat(row.data?.NET ?? '');
  const tax = parseFloat(row.data?.TAX ?? '');
  return Number.isFinite(net) && Number.isFinite(tax) ? round2(net + tax) : null;
}

function invoiceNet(row: Row): number | null {
  const net = parseFloat(row.data?.NET ?? '');
  return Number.isFinite(net) ? round2(net) : null;
}

function invoiceOwing(row: Row): number | null {
  const owing = parseFloat(row.owing ?? row.data?.owing ?? '');
  return Number.isFinite(owing) ? round2(owing) : null;
}

/**
 * Has the approved invoice reached Xero? After `accounting/tasks.php` HireHop
 * stamps it with the Xero invoice id (`ACC_ID`) and `exported: 1` (§4 capture).
 */
function invoiceInXero(row: Row): boolean {
  const d = row.data || {};
  const accId = String(d.ACC_ID ?? d.acc_id ?? '').trim();
  return (accId !== '' && accId !== '0') || Number(row.exported ?? d.exported ?? 0) === 1;
}

/** Every payment on the job with money still unallocated. */
function unallocatedPayments(rows: Row[]): ClosePayment[] {
  const out: ClosePayment[] = [];
  for (const row of rows) {
    if (kindOf(row) !== 6) continue;
    if (!(parseFloat(row.credit ?? row.data?.credit ?? '0') > 0)) continue;   // refunds/negatives aren't payments
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

/** HireHop's job status, fresh. Null if it couldn't be read. */
async function readJobStatus(hhJobNumber: number): Promise<number | null> {
  const res = await hhBroker.get<any>('/api/job_data.php', { job: hhJobNumber },
    { priority: 'high', cacheTTL: -1, skipCache: true });
  const s = res?.success ? parseFloat(String(res.data?.STATUS ?? '')) : NaN;
  return Number.isFinite(s) ? s : null;
}

// ── OP's side ────────────────────────────────────────────────────────────

/** OP's own total for the job — every sale line it pushed and hasn't removed. */
async function expectedTotals(hhJobNumber: number): Promise<{ gross: number; net: number; lines: number }> {
  const r = await query(
    `SELECT COALESCE(SUM(l.line_gross), 0) AS gross, COALESCE(SUM(l.line_net), 0) AS net, COUNT(*) AS lines
       FROM shop_sale_lines l JOIN shop_sales s ON s.id = l.sale_id
      WHERE s.kind = 'sale' AND s.hh_job_number = $1
        AND l.hh_line_id IS NOT NULL AND l.hh_line_removed_at IS NULL`,
    [hhJobNumber],
  );
  return {
    gross: round2(Number(r.rows[0].gross)),
    net: round2(Number(r.rows[0].net)),
    lines: Number(r.rows[0].lines),
  };
}

/**
 * Sales or refunds that haven't finished reaching HireHop and belong to this
 * week — on its job, or a walk-in rung up that week that hasn't been given a
 * job yet (it would land on this week's).
 */
async function unfinishedCount(p: PeriodRow): Promise<number> {
  const r = await query(
    `SELECT COUNT(*) AS n FROM shop_sales
      WHERE kind IN ('sale', 'reversal') AND status IN ('queued', 'failed')
        AND (hh_job_number = $1
             OR (hh_job_number IS NULL AND kind = 'sale' AND sold_to_job_id IS NULL
                 AND (created_at AT TIME ZONE 'Europe/London')::date BETWEEN $2::date AND $3::date))`,
    [p.hh_job_number, p.period_start, p.period_end],
  );
  return Number(r.rows[0].n);
}

// ── Pre-flight / preview ─────────────────────────────────────────────────

/** Must be called holding the drain lock. */
async function buildPreview(p: PeriodRow): Promise<ClosePreview> {
  const hhJobNumber = Number(p.hh_job_number);
  const blockers: string[] = [];

  const [expected, rows] = await Promise.all([
    expectedTotals(hhJobNumber),
    readBillingRows(hhJobNumber),
  ]);
  const payments = unallocatedPayments(rows);
  const paymentsHeld = round2(payments.reduce((s, x) => s + x.available, 0));

  let check: ShopCheck | null = null;
  if (!p.close_state) {
    // A fresh close — every pre-flight condition (§20.1 step 1).
    if (londonDate(new Date()) <= p.period_end) {
      blockers.push(`The week isn't over yet — it can be closed from Monday.`);
    }
    const unfinished = await unfinishedCount(p);
    if (unfinished > 0) {
      blockers.push(`${unfinished} sale${unfinished === 1 ? '' : 's'} or refund${unfinished === 1 ? '' : 's'} from this week `
        + `${unfinished === 1 ? "hasn't" : "haven't"} reached HireHop yet — see Needs attention.`);
    }
    const invoices = invoiceRows(rows);
    if (invoices.length) {
      blockers.push(`The job already has ${invoices.length === 1 ? 'an invoice' : `${invoices.length} invoices`} in HireHop `
        + `(${invoices.map((r) => r.data?.NUMBER || `draft ${idOf(r)}`).join(', ')}). `
        + 'OP only closes a week it invoices itself — deal with that one by hand first.');
    }
    check = await checkShopPeriodLocked(p.id);
    for (const problem of check.problems) blockers.push(problem);
    if (check.status === COMPLETED) {
      blockers.push('The job is already Completed in HireHop.');
    }
  }

  return {
    periodId: p.id,
    periodStart: p.period_start,
    periodEnd: p.period_end,
    hhJobNumber,
    closeState: p.close_state,
    hhInvoiceId: p.hh_invoice_id != null ? Number(p.hh_invoice_id) : null,
    hhInvoiceNumber: p.hh_invoice_number,
    closedAt: p.closed_at,
    ready: p.close_state !== 'completed' && blockers.length === 0,
    blockers,
    expectedGross: expected.gross,
    expectedNet: expected.net,
    payments,
    paymentsHeld,
    empty: expected.lines === 0 && paymentsHeld < PENNY,
    invoiceDate: p.period_end,
    check,
    log: Array.isArray(p.close_log) ? p.close_log : [],
  };
}

/** What Close would do, without doing it. Admin-only at the route. */
export async function previewShopClose(periodId: string): Promise<ClosePreview> {
  return withShopDrainLock(async () => buildPreview(await loadPeriod(periodId)));
}

// ── The close ────────────────────────────────────────────────────────────

class Stop extends Error {}

/** Run (or resume) the close for one week. Admin-only at the route. */
export async function runShopClose(periodId: string, userId: string | null): Promise<CloseResult> {
  return withShopDrainLock(async () => {
    let message: string;
    let done = false;
    try {
      message = await closeSteps(periodId, userId);
      done = true;
    } catch (err) {
      if (!(err instanceof Stop)) {
        // Anything unexpected is logged as a stop too — the next press resumes.
        const detail = err instanceof Error ? err.message : String(err);
        await log(periodId, 'error', false, detail).catch(() => undefined);
      }
      message = err instanceof Error ? err.message : String(err);
    }
    return { done, message, preview: await buildPreview(await loadPeriod(periodId)) };
  });
}

async function stop(periodId: string, step: string, detail: string): Promise<never> {
  await log(periodId, step, false, detail);
  throw new Stop(detail);
}

async function setState(periodId: string, state: CloseState): Promise<void> {
  await query(`UPDATE shop_sale_periods SET close_state = $2 WHERE id = $1`, [periodId, state]);
}

async function closeSteps(periodId: string, userId: string | null): Promise<string> {
  let p = await loadPeriod(periodId);
  if (p.close_state === 'completed') return 'This week is already closed.';
  const hhJobNumber = Number(p.hh_job_number);
  const week = `w/c ${p.period_start} (HireHop job ${hhJobNumber})`;

  // ── 1. Pre-flight (fresh closes only; a resume has already passed it) ──
  if (!p.close_state) {
    const preview = await buildPreview(p);
    if (preview.blockers.length) {
      await stop(periodId, 'pre-flight', preview.blockers.join(' '));
    }
    await log(periodId, 'pre-flight', true,
      `Clean. OP total ${gbp(preview.expectedGross)}; ${preview.payments.length} payment(s) holding ${gbp(preview.paymentsHeld)}.`);

    if (preview.empty) {
      // Nothing to invoice — straight to Completed.
      await completeJob(periodId, hhJobNumber);
      await finish(periodId, userId);
      await log(periodId, 'closed', true, 'Nothing was sold (all cancelled or refunded) — job Completed, no invoice.');
      return 'Nothing was sold this week, so there was no invoice to raise. The job is now Completed.';
    }
  }

  // ── 2. Draft invoice ──
  if (!p.hh_invoice_id) {
    const res = await hhBroker.post<any>('/php_functions/billing_save.php', {
      id: 0,
      desc: '',
      ref: '',
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

    // Read back regardless of what it said. The broker retries a POST after a
    // network blip, so "one invoice on the job, and it's a draft" is the only
    // state that is safe to carry on from.
    const rows = await readBillingRows(hhJobNumber);
    const invoices = invoiceRows(rows);
    const fromResponse = (res.data?.rows || []).find((r: Row) => kindOf(r) === 1);
    const newId = fromResponse ? idOf(fromResponse) : 0;

    if (invoices.length === 0) {
      await stop(periodId, 'draft', `HireHop did not create the invoice (${res.error || 'no invoice on the job afterwards'}). Nothing was changed — press Close to try again.`);
    }
    if (invoices.length > 1) {
      await stop(periodId, 'draft', `HireHop now shows ${invoices.length} invoices on the job — expected one. `
        + 'Delete the extra draft(s) in HireHop, then set this week up again (ask for help — do not press Close).');
    }
    const draft = invoices[0];
    const draftId = idOf(draft);
    if (newId && newId !== draftId) {
      await stop(periodId, 'draft', `HireHop returned invoice ${newId} but the job shows invoice ${draftId}. Check the job by hand.`);
    }
    if (invoiceStatus(draft) !== 0) {
      await stop(periodId, 'draft', `The invoice on the job (${draftId}) is not a draft. Check the job by hand.`);
    }
    await query(`UPDATE shop_sale_periods SET hh_invoice_id = $2, close_state = 'drafted' WHERE id = $1`,
      [periodId, draftId]);
    await log(periodId, 'draft', true, `Draft invoice ${draftId} created.`);
    p = await loadPeriod(periodId);
  }
  const invoiceId = Number(p.hh_invoice_id);

  // ── 3. Penny check (until approved — approval is the Xero commit point) ──
  if (p.close_state === 'drafted') {
    const [expected, rows] = await Promise.all([expectedTotals(hhJobNumber), readBillingRows(hhJobNumber)]);
    const inv = findInvoice(rows, invoiceId);
    if (!inv) {
      // Deleted by hand — the way out of a stopped draft. Nothing reached Xero,
      // so forget it and let the next press start again from the pre-flight.
      await query(`UPDATE shop_sale_periods SET hh_invoice_id = NULL, close_state = NULL WHERE id = $1`, [periodId]);
      await stop(periodId, 'penny check', `Draft invoice ${invoiceId} has been deleted in HireHop. Press Close to start again.`);
    }
    const gross = invoiceGross(inv!);
    const net = invoiceNet(inv!);
    const held = round2(unallocatedPayments(rows).reduce((s, x) => s + x.available, 0));
    const grossOk = gross != null && Math.abs(gross - expected.gross) < PENNY;
    const heldOk = gross != null && Math.abs(gross - held) < PENNY;
    if (!grossOk || !heldOk) {
      const vatOnly = net != null && Math.abs(net - expected.net) < PENNY && !grossOk;
      const detail = `Draft invoice ${gross == null ? '?' : gbp(gross)} (ex VAT ${net == null ? '?' : gbp(net)}), `
        + `OP's total ${gbp(expected.gross)} (ex VAT ${gbp(expected.net)}), payments held ${gbp(held)}.`
        + (vatOnly ? ' The ex-VAT figures agree, so the difference is VAT rounding.' : '')
        + ' Stopped at the draft — nothing has gone to Xero. Fix and press Close again, or approve or delete the draft by hand.';
      await emailService.sendRaw({
        to: SHOP_ALERT_RECIPIENT,
        subject: `[Shop] Week close stopped at the draft — ${week}`,
        html: `<p>The weekly close for <strong>${week}</strong> created a draft invoice but did not approve it, `
          + 'because the numbers do not agree to the penny:</p>'
          + `<ul><li>Draft invoice: <strong>${gross == null ? '?' : gbp(gross)}</strong> (ex VAT ${net == null ? '?' : gbp(net)})</li>`
          + `<li>OP's total: <strong>${gbp(expected.gross)}</strong> (ex VAT ${gbp(expected.net)})</li>`
          + `<li>Payments held: <strong>${gbp(held)}</strong></li></ul>`
          + (vatOnly ? '<p>The ex-VAT figures agree, so the difference is VAT rounding.</p>' : '')
          + '<p>Nothing has gone to Xero. Fix it and press Close again on the Shop Till page (This week), '
          + 'or approve or delete the draft in HireHop by hand.</p>',
        variant: 'internal',
      }).catch((e) => console.error('[shop-close] penny-check email failed:', e));
      await stop(periodId, 'penny check', detail);
    }
    await log(periodId, 'penny check', true, `Draft ${gbp(gross!)} = OP's total = payments held.`);

    // ── 4. Approve, dated the week's Sunday ──
    // Skipped if it's already approved — a resume after the approve landed but
    // its read-back failed. Approving twice is not something to find out about.
    const alreadyApproved = invoiceStatus(inv!) === 2;
    const res = alreadyApproved
      ? { success: true, data: null as any, error: undefined }
      : await hhBroker.post<any>('/php_functions/billing_save_status.php', {
        id: invoiceId,
        status: 2,
        date: `${p.period_end} 23:59:00`,
        type: 1,
        local: hhLocalNow(),
      }, { priority: 'high' });
    const after = findInvoice(await readBillingRows(hhJobNumber), invoiceId);
    const number = after?.data?.NUMBER ? String(after.data.NUMBER) : '';
    if (!after || invoiceStatus(after) !== 2 || !number) {
      await stop(periodId, 'approve', `HireHop did not approve invoice ${invoiceId} (${res.error || 'still a draft on read-back'}). `
        + 'Nothing has gone to Xero — press Close to try again.');
    }
    await query(`UPDATE shop_sale_periods SET hh_invoice_number = $2, close_state = 'approved' WHERE id = $1`,
      [periodId, number]);
    await log(periodId, 'approve', true, `Invoice ${number} approved, dated ${p.period_end}.`);

    // Push to Xero. The save names its own task; if it ever doesn't, the task
    // for an invoice is post_invoice_credit — never the post_payment default.
    await pushInvoiceToXero(periodId, hhJobNumber, invoiceId, number, gross!, {
      ...(res.data || {}),
      hh_task: res.data?.hh_task || 'post_invoice_credit',
      hh_id: res.data?.hh_id || invoiceId,
    });
    p = await loadPeriod(periodId);
  }

  // ── 4b. Resuming an approved invoice: make sure it reached Xero ──
  if (p.close_state === 'approved') {
    const inv = findInvoice(await readBillingRows(hhJobNumber), invoiceId);
    if (!inv) await stop(periodId, 'xero', `Invoice ${invoiceId} is no longer on the job. Check HireHop by hand.`);
    if (!invoiceInXero(inv!)) {
      await pushInvoiceToXero(periodId, hhJobNumber, invoiceId, p.hh_invoice_number || String(invoiceId),
        invoiceGross(inv!) ?? 0, {
          hh_task: 'post_invoice_credit', hh_id: invoiceId, hh_acc_package_id: 3, hh_package_type: 1,
        });
    }

    // ── 5. Allocate every payment ──
    const payments = unallocatedPayments(await readBillingRows(hhJobNumber));
    const today = londonDate(new Date());
    for (const pay of payments) {
      if (pay.bankId == null) {
        await stop(periodId, 'allocate', `Couldn't read which bank payment ${pay.depositId} is on. Nothing more was allocated.`);
      }
      const res = await hhBroker.post<any>('/php_functions/billing_payments_save.php', {
        id: 0,                 // a new application
        date: today,
        desc: '',
        paid: pay.available,
        memo: '',
        bank: pay.bankId,      // the PAYMENT's bank, not the invoice's
        OWNER: invoiceId,
        deposit: pay.depositId,
        no_webhook: 1,
      }, { priority: 'high' });
      if (!res.success || !res.data) {
        await stop(periodId, 'allocate', `HireHop refused to allocate payment ${pay.depositId} (${gbp(pay.available)}): `
          + `${res.error || 'no reply'}. Press Close to carry on — payments already allocated are skipped.`);
      }
      if (!res.data.hh_id) {
        await stop(periodId, 'allocate', `Payment ${pay.depositId} was allocated in HireHop, but HireHop didn't say how to send it to Xero. `
          + 'Open it in HireHop and Save to push it, then press Close to carry on.');
      }
      const sync = await syncSavedRowToXero(`shop close ${week} — payment ${pay.depositId}`, res.data);
      if (!sync.ok) {
        void sendXeroSyncFailedAlert({
          jobId: null, hhJobNumber, what: `shop week payment allocation (${week})`,
          amount: pay.available, hhRowId: res.data.hh_id, hhDepositId: pay.depositId,
          error: sync.error || 'unknown',
        });
        await stop(periodId, 'allocate', `Payment ${pay.depositId} (${gbp(pay.available)}) is allocated in HireHop but Xero refused it: `
          + `${sync.error}. Fix that one in Xero (you've been emailed), then press Close to carry on.`);
      }
      await log(periodId, 'allocate', true, `Payment ${pay.depositId} — ${gbp(pay.available)} allocated and sent to Xero.`);
    }

    // Read back: nothing left owing, nothing left unallocated.
    const rows = await readBillingRows(hhJobNumber);
    const settled = findInvoice(rows, invoiceId);
    const owing = settled ? invoiceOwing(settled) : null;
    const left = unallocatedPayments(rows);
    if (owing == null || Math.abs(owing) >= PENNY || left.length) {
      await stop(periodId, 'allocate', `After allocating, the invoice shows ${owing == null ? '?' : gbp(owing)} owing`
        + `${left.length ? ` and ${left.length} payment(s) still hold money` : ''} — expected £0.00. Check the job in HireHop.`);
    }
    await setState(periodId, 'allocated');
    await log(periodId, 'allocate', true, 'Invoice shows £0.00 owing.');
    p = await loadPeriod(periodId);
  }

  // ── 6 & 7. Complete the job, record it ──
  if (p.close_state === 'allocated') {
    await completeJob(periodId, hhJobNumber);
    await finish(periodId, userId);
    await log(periodId, 'closed', true, `Job Completed. Week closed — invoice ${p.hh_invoice_number}.`);
  }
  return `Closed. Invoice ${p.hh_invoice_number} is approved and paid, and the job is Completed.`;
}

async function pushInvoiceToXero(
  periodId: string, hhJobNumber: number, invoiceId: number, number: string, gross: number, saved: Row,
): Promise<void> {
  const sync = await syncSavedRowToXero(`shop close — invoice ${number}`, saved);
  if (!sync.ok) {
    void sendXeroSyncFailedAlert({
      jobId: null, hhJobNumber, what: `shop week invoice ${number}`, amount: gross,
      hhRowId: invoiceId, error: sync.error || 'unknown',
    });
    await stop(periodId, 'xero', `Invoice ${number} is approved in HireHop but Xero refused it: ${sync.error}. `
      + 'No payments have been allocated. Fix it in Xero (you\'ve been emailed), then press Close to carry on.');
  }
  // Read back: HireHop stamps the invoice once Xero has it.
  const inv = findInvoice(await readBillingRows(hhJobNumber), invoiceId);
  if (!inv || !invoiceInXero(inv)) {
    const keys = inv?.data ? Object.keys(inv.data).join(',') : 'none';
    console.warn(`[shop-close] invoice ${invoiceId} shows no Xero id after sync. data keys: ${keys}`);
    await stop(periodId, 'xero', `HireHop says invoice ${number} was sent to Xero, but it doesn't show as exported yet. `
      + 'Check it is in Xero, then press Close to carry on.');
  }
  await log(periodId, 'xero', true, `Invoice ${number} is in Xero.`);
}

/** Status 11, read back. Completed keeps sale stock consumed (§2.1). */
async function completeJob(periodId: string, hhJobNumber: number): Promise<void> {
  if ((await readJobStatus(hhJobNumber)) !== COMPLETED) {
    const res = await hhBroker.post<any>('/frames/status_save.php', {
      job: hhJobNumber, status: COMPLETED, no_webhook: 1,
    }, { priority: 'high' });
    const status = await readJobStatus(hhJobNumber);
    if (status !== COMPLETED) {
      await stop(periodId, 'complete', `HireHop job ${hhJobNumber} is status ${status ?? '?'}, not Completed `
        + `(${res.error || 'no error given'}). Press Close to try again.`);
    }
  }
  await log(periodId, 'complete', true, `HireHop job ${hhJobNumber} is Completed.`);
}

async function finish(periodId: string, userId: string | null): Promise<void> {
  await query(
    `UPDATE shop_sale_periods
        SET close_state = 'completed', closed_at = NOW(), closed_by = $2,
            invoiced_at = COALESCE(invoiced_at, CASE WHEN hh_invoice_id IS NOT NULL THEN NOW() END)
      WHERE id = $1`,
    [periodId, userId],
  );
}

// ── The Monday email ─────────────────────────────────────────────────────

/**
 * Monday 08:55: tell jon which finished weeks are waiting to be closed, and
 * whether each one is ready or what's stopping it. Silent when there are none
 * (a week with no sales has no job, so nothing to close).
 */
export async function sendShopCloseDigest(): Promise<number> {
  const r = await query(
    `SELECT id FROM shop_sale_periods
      WHERE hh_job_number IS NOT NULL AND period_end < $1::date
        AND close_state IS DISTINCT FROM 'completed'
      ORDER BY period_start`,
    [londonDate(new Date())],
  );
  if (!r.rows.length) return 0;

  const items: string[] = [];
  for (const row of r.rows) {
    try {
      const pv = await previewShopClose(row.id);
      const link = `${getFrontendUrl()}/money/shop?tab=week&start=${pv.periodStart}`;
      const label = `Week of ${pv.periodStart} (HireHop job ${pv.hhJobNumber})`;
      const body = pv.closeState
        ? `started but not finished (stopped after: ${pv.closeState}) — press Close to carry on.`
        : pv.ready
          ? `ready to close — ${gbp(pv.expectedGross)} from ${pv.payments.length} payment${pv.payments.length === 1 ? '' : 's'}.`
          : `can't close yet: ${pv.blockers.map(escapeHtml).join(' ')}`;
      items.push(`<li><a href="${link}">${label}</a>: ${body}</li>`);
    } catch (err) {
      items.push(`<li>Week ${row.id}: couldn't check — ${escapeHtml(err instanceof Error ? err.message : String(err))}</li>`);
    }
  }
  await emailService.sendRaw({
    to: SHOP_ALERT_RECIPIENT,
    subject: `[Shop] ${r.rows.length} week${r.rows.length === 1 ? '' : 's'} to close`,
    html: `<p>Shop weeks waiting to be closed (invoice, allocate, complete):</p><ul>${items.join('')}</ul>`
      + '<p>The Close button is on the Shop Till page, under <em>This week</em>.</p>',
    variant: 'internal',
  });
  return r.rows.length;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
