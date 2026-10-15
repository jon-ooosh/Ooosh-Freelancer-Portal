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
  /** Who pressed it, when a caller's own records need it (the shop leaves it out). */
  userId?: string | null;
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
export async function postDraftInvoice(hhJobNumber: number, ref: string,
  opts: { all?: 0 | 1 } = {}): Promise<{ res: any; newId: number }> {
  const res = await hhBroker.post<any>('/php_functions/billing_save.php', {
    id: 0,
    desc: '',
    ref,                    // → the Xero invoice's Reference
    memo: '',
    bank: 169,              // the invoice's default bank as captured; payments carry their own
    tax_total: '0.00',
    tax_rate: 0,
    // "Include all owing items" — 1 unless the caller wants an EMPTY draft (0, §3: a charge
    // invoice built from custom lines only). Always sent: the UI default is a user setting.
    all: opts.all ?? 1,
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

// ── Invoice LINES on a draft (HIREHOP-BILLING-API.md §10) ────────────────

/**
 * A charge invoice raised after completion (completed-charges.ts): custom lines only,
 * no job line behind any of them. Its money is deliberately NOT on the HireHop job, so
 * it is left out of every "invoices add up to the job's quoted total" sum.
 */
export const isChargeOnlyInvoice = (row: Row) => {
  const items = Array.isArray(row?.data?.items) ? row.data.items : [];
  return items.length > 0 && items.every((it: Row) => Number(it.MAIN_ID || 0) === 0);
};

/** An invoice's lines as HireHop lists them (`data.items` on its kind-1 row). */
export function invoiceItems(row: Row | null): Row[] {
  return Array.isArray(row?.data?.items) ? row!.data.items : [];
}

/**
 * Edit one invoice line IN PLACE, by its own id — `billing_save_item.php`
 * (singular), exactly as HireHop's line editor sends it (§10.3, and captured
 * again 12 Oct 2026 setting a line to £0: same id, `PRICE: 0`, unit price
 * kept). `total` is the line's new net; `rate` / `taxId` its VAT. The nominal
 * is sent back unchanged.
 *
 * NOT `billing_save_items.php` (plural): that ASSIGNS a job line to the
 * invoice and, for a line already on it, adds a second copy (15745, 12 Oct).
 * The caller reads back.
 */
export async function postInvoiceLineEdit(hhJobNumber: number, invoiceId: number, line: Row,
  edit: { total: number; rate: number; taxId: number }): Promise<any> {
  return hhBroker.post<any>('/php_functions/billing_save_item.php', {
    id: line.ID,
    bill: invoiceId,
    kind: line.KIND,
    total: edit.total,
    desc: line.DESCRIPTION || line.ITEM || '',
    memo: line.MEMO || '',
    vat_rate: edit.rate,
    vat_id: edit.taxId,
    nominal_id: line.ACC_NOMINAL_ID,
    unit: 0,
    main_id: hhJobNumber,
    type: 1,
    selected: line.ID,
  }, { priority: 'high' });
}

/**
 * Add a custom line to a draft (§10.3b — `billing_save_item.php`, `id: 0`,
 * `kind: 3`): no job item behind it, so the job's supply list is never
 * touched. `after` is the line it goes after. The caller reads back.
 */
export async function postCustomInvoiceLine(hhJobNumber: number, invoiceId: number, line: {
  description: string; amount: number; rate: number; taxId: number; nominalId: number; after: number;
}): Promise<any> {
  return hhBroker.post<any>('/php_functions/billing_save_item.php', {
    id: 0,
    bill: invoiceId,
    kind: 3,
    qty: 1,
    note: line.description,
    unit: line.amount,
    total: line.amount,
    memo: '',
    vat_rate: line.rate,
    vat_id: line.taxId,
    nominal_id: line.nominalId,
    main_id: hhJobNumber,
    type: 1,
    selected: line.after,
  }, { priority: 'high' });
}

/** Misc income (Xero 275) — HireHop's invoice nominal id. Charges after completion and cancellation fees. */
export const MISC_INCOME_NOMINAL = 190;

/** One custom line on an invoice built from custom lines only (no job line behind it). */
export interface CustomInvoiceLine { description: string; amount: number; rate: number; taxId: number; nominalId: number }

/**
 * HireHop keeps only the first 80 characters of a custom line's text and says nothing:
 * 16739's fee line lost "Oct 2026" off its end (14 Oct 2026). Longer is refused up front.
 */
export const CUSTOM_LINE_MAX = 80;

/** What a custom line comes to inc VAT, rounded per line as HireHop does. */
export const customLineGross = (l: { amount: number; rate: number }) => round2(l.amount + round2(l.amount * l.rate / 100));

/**
 * An invoice built ONLY from custom lines — a charge after completion
 * (completed-charges.ts) or a cancellation fee (cancellation-close.ts):
 * an EMPTY draft (`all: 0`), one custom line each (§10.3b), a penny check
 * that the draft is exactly the lines, approve dated today, push to Xero.
 * Every write read back; any doubt stops at the draft, which never reaches
 * Xero. No job line and no stock is ever touched.
 *
 * The caller does its own pre-flight (who may, which job status) and its own
 * logging of the result; this refuses a job that already has a draft.
 */
export async function raiseCustomLineInvoice(rep: CloseReporter, input: {
  hhJobNumber: number;
  /** The log step every line of this run is written under ('charge', 'cancel_fee'). */
  step: string;
  lines: CustomInvoiceLine[];
  /** For the Xero push and its failure alert. */
  xeroLabel: string;
  alert: { jobId: string | null; what: string };
}): Promise<{ invoiceId: number; number: string; gross: number }> {
  const { hhJobNumber, step, lines } = input;
  for (const l of lines) {
    if (l.description.length > CUSTOM_LINE_MAX) {
      await rep.stop(step, `"${l.description}" is ${l.description.length} characters — HireHop keeps only ${CUSTOM_LINE_MAX} on an invoice line, so shorten it. Nothing was changed.`);
    }
  }
  let rows = await readBillingRows(hhJobNumber);
  if (invoiceRows(rows).some((r) => invoiceStatus(r) === 0)) {
    await rep.stop(step, `Job ${hhJobNumber} already has a draft invoice in HireHop — approve or delete it there first.`);
  }

  // ── 1. An EMPTY draft ──
  const { res: draftRes } = await postDraftInvoice(hhJobNumber, `Job ${hhJobNumber}`, { all: 0 });
  rows = await readBillingRows(hhJobNumber);
  const fresh = invoiceRows(rows).filter((r) => invoiceStatus(r) === 0);
  if (fresh.length !== 1) {
    await rep.stop(step, fresh.length === 0
      ? `HireHop did not create the draft (${draftRes?.error || 'no draft on the job afterwards'}) — it may not allow invoices on this job for OP's HireHop user. Nothing was changed.`
      : `HireHop now shows ${fresh.length} drafts on job ${hhJobNumber}; expected one. Delete them in HireHop, then ${rep.retryHint}.`);
  }
  const draftId = idOf(fresh[0]);
  const deleteHint = `Delete draft ${draftId} in HireHop, then ${rep.retryHint}.`;
  if (invoiceItems(fresh[0]).length) {
    await rep.stop(step, `HireHop put job lines on draft ${draftId} — this invoice must be empty to start. Nothing has gone to Xero. ${deleteHint}`);
  }
  await rep.log(step, true, `Empty draft ${draftId} created.`);

  // ── 2. The custom lines, each read back ──
  let draft = findInvoice(rows, draftId);
  for (const l of lines) {
    const before = [...invoiceItems(draft)];   // a snapshot — never the live list the next read may share
    const after0 = before.length ? Number(before[before.length - 1].ID) : 0;
    const res = await postCustomInvoiceLine(hhJobNumber, draftId, { ...l, after: after0 });
    rows = await readBillingRows(hhJobNumber);
    draft = findInvoice(rows, draftId);
    const added = invoiceItems(draft).filter((x: Row) => !before.some((b: Row) => Number(b.ID) === Number(x.ID)));
    const ok = added.length === 1 && Math.abs(Number(added[0].PRICE) - l.amount) < PENNY
      && Number(added[0].ACC_TAX_RATE_ID) === l.taxId && Number(added[0].ACC_NOMINAL_ID) === l.nominalId;
    if (!ok) {
      await rep.stop(step, `HireHop did not add "${l.description}" (${gbp(l.amount)}) as asked${res?.error ? ` (${res.error})` : ''}. Nothing has gone to Xero. ${deleteHint}`);
    }
  }

  // ── 3. Penny check: the draft is exactly the lines ──
  const wantNet = round2(lines.reduce((s, l) => s + l.amount, 0));
  const wantGross = round2(lines.reduce((s, l) => s + customLineGross(l), 0));
  const net = invoiceNet(draft!) ?? 0;
  const gross = invoiceGross(draft!) ?? 0;
  if (Math.abs(net - wantNet) >= PENNY || Math.abs(gross - wantGross) >= PENNY) {
    await rep.stop(step, `Draft ${draftId} comes to ${gbp(net)} ex VAT / ${gbp(gross)} inc VAT; the lines are ${gbp(wantNet)} / ${gbp(wantGross)}. Nothing has gone to Xero. ${deleteHint}`);
  }

  // ── 4. Approve, dated today, then Xero ──
  const approveRes = await postApproveInvoice(draftId, hhLocalNow());
  rows = await readBillingRows(hhJobNumber);
  const approved = findInvoice(rows, draftId);
  const number = String(approved?.data?.NUMBER || '');
  if (!approved || invoiceStatus(approved) < 2 || !number) {
    await rep.stop(step, `HireHop did not approve draft ${draftId} (${approveRes?.error || 'still a draft on read-back'}). Nothing has gone to Xero — ${rep.retryHint}.`);
  }
  await pushInvoiceToXero(rep, {
    label: `${input.xeroLabel} — invoice ${number}`, hhJobNumber, invoiceId: draftId, number, gross,
    saved: { ...(approveRes?.data || {}), hh_task: approveRes?.data?.hh_task || 'post_invoice_credit', hh_id: approveRes?.data?.hh_id || draftId },
    alert: { jobId: input.alert.jobId, what: `${input.alert.what} ${number}` },
  });
  return { invoiceId: draftId, number, gross };
}

// ── Laying an invoice out like the quote ──────────────────────────────────

/** The job's supply list exactly as HireHop's own grid gets it (headers, £0 lines, prompts, LFT/RGT). */
export async function readSupplyList(hhJobNumber: number): Promise<Row[]> {
  const res = await hhBroker.get<any>('/frames/items_to_supply_list.php', { job: hhJobNumber }, { priority: 'high', cacheTTL: -1 });
  if (!res.success || !res.data) return [];
  const raw: Row[] = Array.isArray(res.data) ? res.data : (res.data.items || res.data.rows || []);
  return [...raw].sort((a, b) => Number(a.LFT ?? 0) - Number(b.LFT ?? 0));
}

/**
 * Put the whole supply list on an EMPTY draft in its own order — what staff do by hand
 * with Copy, then Paste on a blank invoice (`billing_paste.php`, captured 13 Oct 2026 on
 * 16598: HIREHOP-BILLING-API.md §10.7). Copy never reaches the server; Paste sends the
 * grid's rows, so we send the rows the supply list gave us with the prices multiplied out
 * as the grid shows them, plus the `inv_UNIT_PRICE` / `inv_PRICE` pair the grid adds. HireHop works out VAT and nominal from the stock (the
 * capture sent `VAT_RATE: 0` and got 20% back). Headers and nesting come through as on the
 * quote; "include all owing items" (`all: 1`) flattens them in an order nobody chose.
 * The caller reads back.
 */
export async function postPasteSupplyLines(hhJobNumber: number, invoiceId: number, items: Row[]): Promise<any> {
  const body: Record<string, unknown> = { selected: '', bill: invoiceId };
  items.forEach((item, i) => {
    // The feed's UNIT_PRICE / PRICE are per charge PERIOD (a day, a week); MULTIPLIER is how
    // many periods the job runs. HireHop's grid multiplies them out before it pastes, and
    // HireHop prices the invoice line from what it is sent — sending the feed's figures put
    // every per-Day line on at half price on a 2-day job (16849, 13 Oct 2026: £8 bar → £4).
    const m = Number(item.MULTIPLIER);
    const times = Number.isFinite(m) && m > 0 ? m : 1;
    const unit = round2(Number(item.UNIT_PRICE ?? 0) * times);
    const price = round2(Number(item.PRICE ?? 0) * times);
    const row: Row = {
      ...item,
      UNIT_PRICE: unit, PRICE: price, inv_UNIT_PRICE: unit, inv_PRICE: price,
      // As the grid sends them: a missing nominal / duration is 0, not blank.
      ACC_NOMINAL: item.ACC_NOMINAL ?? 0, ACC_NOMINAL_PO: item.ACC_NOMINAL_PO ?? 0, DURATION: item.DURATION ?? 0,
    };
    for (const [k, v] of Object.entries(row)) {
      if (v !== null && typeof v === 'object') continue;   // TYPE_CUSTOM_FIELDS and the like: the grid doesn't send them
      body[`data[${i}][${k}]`] = v ?? '';
    }
  });
  body.origin_type = 1;
  body.origin_id = hhJobNumber;
  return hhBroker.post<any>('/php_functions/billing_paste.php', body, { priority: 'high' });
}

// ── The Xero legs ────────────────────────────────────────────────────────

/**
 * Invoices HireHop has lost track of. Now and then HireHop's push reaches
 * Xero but HireHop never records it: the row keeps `ACC_ID: ""`, and a
 * re-push fails "Invoice # must be unique" (OT-INV-12000, job 15812, Jul
 * 2026). For each approved invoice like that, look Xero up by invoice number
 * and, when exactly one live ACCREC invoice has that number AND the same
 * total, put its id on the row IN MEMORY so the Xero steps can work. HireHop
 * itself is never told (no captured call for it). Returns a sentence per
 * invoice adopted. Never throws: on any doubt the row is left as it was.
 */
export async function adoptLostXeroInvoices(rows: Row[]): Promise<string[]> {
  const notes: string[] = [];
  if (!isXeroConfigured()) return notes;
  for (const row of invoiceRows(rows)) {
    if (invoiceStatus(row) < 2 || invoiceInXero(row)) continue;
    const number = String(row.data?.NUMBER || '').trim();
    const gross = invoiceGross(row);
    if (!/^[A-Za-z0-9-]+$/.test(number) || gross == null) continue;
    try {
      const found = (await xeroBroker.getInvoices(`Type=="ACCREC" AND InvoiceNumber=="${number}"`))
        .filter((x) => !['VOIDED', 'DELETED'].includes(String(x.Status)));
      if (found.length !== 1 || Math.abs(round2(Number(found[0].Total) || 0) - gross) >= PENNY) continue;
      row.data = { ...(row.data || {}), ACC_ID: String(found[0].InvoiceID) };
      notes.push(`${number} is in Xero but HireHop lost the link — matched it by number and total.`);
    } catch (err) {
      console.warn(`[hh-invoice-close] Xero lookup for ${number} failed:`, err);
    }
  }
  return notes;
}

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
 * `expectedDue` is what Xero SHOULD still show afterwards — £0 for a settled
 * invoice (the shop), the HireHop owing for a hire whose client still owes a
 * balance. Anything else is a stop.
 */
export async function applyCreditsInXero(
  rep: CloseReporter, rows: Row[], invoiceId: number, number: string,
  opts: { extraRows?: Row[]; expectedDue?: number } = {},
): Promise<void> {
  const extraRows = opts.extraRows ?? [];
  const expectedDue = round2(opts.expectedDue ?? 0);
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
    const dueNow = await amountDue();
    // Xero AHEAD of HireHop — a credit applied by hand in Xero, or an allocation undone in
    // HireHop but not in Xero (job 16015). Applying more can't fix that; say so, never "matches".
    if (dueNow < expectedDue - PENNY) {
      await rep.stop('xero', `Xero shows ${gbp(dueNow)} due on ${number} but HireHop says ${gbp(expectedDue)} — Xero has more `
        + 'applied to it than HireHop (a credit applied by hand in Xero, or an allocation removed in HireHop but not in Xero). '
        + `Nothing was applied. Check the invoice's payments in Xero, then ${rep.retryHint}.`);
    }
    if (dueNow <= expectedDue + PENNY) {
      await rep.log('xero', true, expectedDue < PENNY
        ? `${number} already shows paid in Xero.`
        : `${number} already shows ${gbp(expectedDue)} due in Xero — nothing more to apply.`);
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
    if (Math.abs(due - expectedDue) >= PENNY) {
      await rep.stop('xero', `After applying every payment, Xero still shows ${gbp(due)} due on ${number}`
        + (expectedDue >= PENNY ? ` (HireHop says ${gbp(expectedDue)})` : '') + '. '
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
  await rep.log('xero', true, expectedDue < PENNY
    ? `${number} shows paid in Xero.`
    : `${number} shows ${gbp(expectedDue)} due in Xero, matching HireHop.`);
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
