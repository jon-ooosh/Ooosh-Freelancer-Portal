/**
 * Cost Capture → Xero push service.
 *
 * Two flows, picked by payment_method:
 *
 *   Paid-now (cot_card / amex / lloyds_cc / petty_cash / paypal / wise /
 *   lloyds_transfer) → a Spend Money on the mapped bank account + receipt
 *   attach. Codat's bank-feed line auto-suggests it for one-click reconcile.
 *
 *   Pay-later (not_yet_paid / reimburse_me) → an AUTHORISED ACCPAY bill, created
 *   when the cost is APPROVED in OP (so it lands in Xero's "Bills to pay"). When
 *   the cost is later marked paid (date + method), a Payment is recorded against
 *   the bill on the bank account mapped to that pay method. reimburse_me bills
 *   are raised against the staff member (the company owes them), not the receipt
 *   vendor — the vendor is noted on the line and the receipt attached as evidence.
 *
 * Driven from POST/PATCH /api/costs + the /approve and /pay endpoints (each in a
 * `setImmediate` so the API response isn't blocked), and from the manual
 * `POST /api/costs/:id/sync-xero` retry. The push is idempotent and picks up
 * wherever it left off — "Push now" does the right next step at any stage.
 *
 * State machine (costs.xero_sync_state):
 *   pending      → fresh / unpushed / awaiting approval
 *   bill_created → Spend Money OR bill created in Xero
 *   attached     → + receipt attached
 *   reconciled   → bank line matched in Xero (future, set by reconcile sync)
 *   error        → push failed; xero_error has the message; manual retry surfaces
 *
 * Soft-skip (state stays 'pending', advisory in xero_error, calm "Not synced"
 * pill rather than a red "Failed") is used for config gaps a retry alone won't
 * fix: no bank-account mapping, bill not yet approved, or the
 * `accounting.transactions` Xero scope not yet granted.
 */
import { Readable } from 'stream';
import { query, getClient } from '../config/database';
import { getFromR2, isR2Configured } from '../config/r2';
import { isXeroConfigured } from '../config/xero';
import { xeroBroker, XeroApiError, XeroLineItem } from './xero-broker';
import { getSystemSetting } from '../routes/system-settings';

// Paid-now methods → Spend Money on the mapped bank/card account.
// (Exported for the reconcile sync — cost-xero-reconcile-sync.ts.)
export const SPEND_MONEY_METHODS = ['cot_card', 'amex', 'lloyds_cc', 'petty_cash', 'paypal', 'wise', 'lloyds_transfer'] as const;
// Pay-later methods → authorised ACCPAY bill on approval, payment recorded when paid.
const BILL_METHODS = ['not_yet_paid', 'reimburse_me'] as const;

const PUSHED_STATES = ['bill_created', 'attached', 'reconciled'];

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function guessContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  return {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
  }[ext] || 'application/octet-stream';
}

async function recordError(costId: string, message: string): Promise<void> {
  await query(
    `UPDATE costs SET xero_sync_state='error', xero_error=$1 WHERE id=$2`,
    [message.slice(0, 500), costId]
  );
}

// Calm advisory — keeps state 'pending' (UI shows a grey "Not synced" pill, not
// a red "Failed"). For config gaps a plain retry won't fix.
async function recordAdvisory(costId: string, message: string): Promise<void> {
  await query(
    `UPDATE costs SET xero_error=$1 WHERE id=$2`,
    [message.slice(0, 500), costId]
  );
}

// A bill/payment write fails until the granular bill scopes are granted on the
// Custom Connection. Two shapes: the isolated bills-token mint rejects the scope
// (invalid_scope), or the API call returns 401/403 insufficient_scope. Treat all
// as a calm advisory, not a red failure — granting the scopes + Push now fixes it.
function isScopeError(err: unknown): boolean {
  if (!(err instanceof XeroApiError)) return false;
  if (err.status === 401 || err.status === 403) return true;
  return /invalid_scope/i.test(err.message);
}

const SCOPE_ADVISORY =
  'Xero bills not enabled yet — grant the "accounting.invoices" + "accounting.payments" scopes on the Custom Connection (re-authorise it), then Push now';

const MISSING_CATEGORY_MSG =
  'No category on this cost — open Edit, pick "What\'s this cost for?" and save (the push then retries automatically)';

interface PushResult {
  pushed: boolean;
  skipped?: string;
  bankTransactionID?: string;
  invoiceID?: string;
  paymentID?: string;
  error?: string;
}

interface CostRow {
  id: string;
  payment_method: string | null;
  payment_status: string;
  approval_state: string | null;
  amount_gross: string | number | null;
  amount_vat: string | number | null;
  amount_net: string | number | null;
  vat_treatment: string | null;
  xero_account_code: string | null;
  xero_object_id: string | null;
  xero_payment_id: string | null;
  xero_sync_state: string;
  supplier_name: string | null;
  invoice_number: string | null;
  description: string | null;
  category: string | null;
  cost_date: string | null;
  xero_contact_id: string | null;
  paid_method: string | null;
  paid_value_date: string | null;
  paid_at: string | null;
  receipt_r2_key: string | null;
  receipt_filename: string | null;
  uploaded_by_name: string | null;
}

async function loadCost(costId: string): Promise<CostRow | null> {
  const r = await query(
    `SELECT c.*, CONCAT(up.first_name, ' ', up.last_name) AS uploaded_by_name
       FROM costs c
       LEFT JOIN users u   ON u.id = c.uploaded_by
       LEFT JOIN people up ON up.id = u.person_id
      WHERE c.id = $1`,
    [costId]
  );
  return r.rows[0] || null;
}

function dateOnly(v: string | null | undefined): string | undefined {
  return v ? new Date(v).toISOString().slice(0, 10) : undefined;
}

// Xero requires a DueDate on an ACCPAY bill. We derive it from the supplier's
// payment terms (computeDueDate), falling back to invoice + 30 when there's no
// invoice date. Staff set the real payment date at "Mark paid" anyway, so this
// just drives the Bills-to-pay aging.
function addDaysISO(iso: string | undefined, days: number): string {
  const base = iso ? new Date(`${iso}T00:00:00Z`) : new Date();
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

// Resolve the Xero TaxType for a cost's line. No VAT recorded → 'NONE' (so a
// freelancer's no-VAT invoice doesn't inherit the account's 20% default). VAT
// recorded → the org's purchase tax type for the implied rate (fallback: leave
// undefined so Xero applies the account default, which is correct for 20%).
async function resolveLineTaxType(cost: CostRow): Promise<string | undefined> {
  const vat = Number(cost.amount_vat || 0);
  const net = Number(cost.amount_net || 0);
  if (vat <= 0) return 'NONE';
  const rate = net > 0 ? Math.round((vat / net) * 100) : 20;
  return (await xeroBroker.getPurchaseTaxType(rate)) || undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Xero Reference field: the supplier's invoice number when we have one (so the
// bill/transaction is findable by the number printed on the paperwork),
// falling back to the supplier name. Max 255 chars per Xero.
function xeroReference(cost: CostRow): string | undefined {
  const ref = (cost.invoice_number || cost.supplier_name || '').toString().trim().slice(0, 255);
  return ref || undefined;
}

// Build the Xero line items + lineAmountTypes for a cost.
//
// Standard costs → a single INCLUSIVE line; Xero derives the VAT from the
// account / tax type. Works whenever the VAT is a clean standard rate of net.
//
// Costs flagged vat_treatment='reclaim_split' (insurance-claim / "VAT-only"
// invoices, where the VAT is non-standard relative to net — e.g. £750 excess +
// £702.68 reclaimable VAT) push the 3-line EXCLUSIVE structure exactly as an
// accountant enters it by hand:
//   1. net          @ No VAT   — the real net cost (the excess)
//   2. vat / 0.20   @ 20% VAT  — the VAT base, so Xero computes exactly the VAT
//   3. -(vat/0.20)  @ No VAT   — cancels the phantom net
// Lines 2+3 net to zero, so subtotal=net, VAT=vat, total=gross — for ANY
// net/vat pair. (Assumes the underlying VAT was charged at the 20% standard
// rate, which is the only realistic case for these UK invoices.)
async function buildCostLineItems(
  cost: CostRow,
  description: string,
): Promise<{ lineItems: XeroLineItem[]; lineAmountTypes: 'Inclusive' | 'Exclusive' }> {
  const account = String(cost.xero_account_code);

  if (cost.vat_treatment === 'reclaim_split') {
    const net = round2(Number(cost.amount_net || 0));
    const vat = round2(Number(cost.amount_vat || 0));
    const vatBase = round2(vat / 0.20);
    const std = await xeroBroker.getPurchaseTaxType(20);
    return {
      lineAmountTypes: 'Exclusive',
      lineItems: [
        { Description: description, Quantity: 1, UnitAmount: net, AccountCode: account, TaxType: 'NONE' },
        { Description: 'VAT', Quantity: 1, UnitAmount: vatBase, AccountCode: account, ...(std ? { TaxType: std } : {}) },
        { Description: 'VAT adjustment', Quantity: 1, UnitAmount: -vatBase, AccountCode: account, TaxType: 'NONE' },
      ],
    };
  }

  const taxType = await resolveLineTaxType(cost);
  return {
    lineAmountTypes: 'Inclusive',
    lineItems: [
      { Description: description, Quantity: 1, UnitAmount: Number(cost.amount_gross), AccountCode: account, ...(taxType ? { TaxType: taxType } : {}) },
    ],
  };
}

async function attachReceipt(
  cost: CostRow,
  entity: 'Invoices' | 'BankTransactions',
  entityId: string,
): Promise<string | null> {
  if (!(cost.receipt_r2_key && cost.receipt_filename && isR2Configured())) return null;
  const r2obj = await getFromR2(cost.receipt_r2_key);
  const body = r2obj.Body as Readable | undefined;
  if (!body) throw new Error('Receipt body unavailable from R2');
  const buffer = await streamToBuffer(body);
  await xeroBroker.attachReceipt(entity, entityId, cost.receipt_filename, buffer, guessContentType(cost.receipt_filename));
  return entityId;
}

// ── Spend Money flow (paid-now methods) ──────────────────────────────────────

async function pushSpendMoney(cost: CostRow): Promise<PushResult> {
  if (cost.xero_object_id && PUSHED_STATES.includes(cost.xero_sync_state)) {
    return { pushed: false, skipped: `Already at state ${cost.xero_sync_state}` };
  }
  if (cost.payment_status !== 'paid') {
    return { pushed: false, skipped: `Payment status is ${cost.payment_status} — not yet pushable` };
  }
  if (!cost.amount_gross || Number(cost.amount_gross) <= 0) {
    await recordError(cost.id, 'Gross amount required to push');
    return { pushed: false, error: 'Gross amount required' };
  }
  if (!cost.xero_account_code) {
    await recordError(cost.id, MISSING_CATEGORY_MSG);
    return { pushed: false, error: MISSING_CATEGORY_MSG };
  }

  const bankAccountId = await getSystemSetting(`xero_bank_${cost.payment_method}`);
  if (!bankAccountId) {
    await recordAdvisory(cost.id, `No Xero bank account mapped for "${cost.payment_method}" — set it in Settings → Xero Bank Accounts to enable sync`);
    return { pushed: false, skipped: 'Bank account mapping missing' };
  }

  const description = (cost.description || cost.category || cost.supplier_name || 'Cost').toString().slice(0, 4000);
  const { lineItems, lineAmountTypes } = await buildCostLineItems(cost, description);

  let bankTransactionID: string;
  try {
    const supplier = (cost.supplier_name || 'Unknown supplier').toString().slice(0, 500);
    const txn = await xeroBroker.createSpendMoney({
      bankAccountId,
      contactName: supplier,
      date: dateOnly(cost.cost_date),
      reference: xeroReference(cost),
      lineItems,
      lineAmountTypes,
    });
    bankTransactionID = txn.BankTransactionID;
  } catch (err) {
    const msg = err instanceof XeroApiError ? `Xero: ${err.message}` : err instanceof Error ? err.message : String(err);
    await recordError(cost.id, msg);
    return { pushed: false, error: msg };
  }

  await query(
    `UPDATE costs SET xero_object_id=$1, xero_sync_state='bill_created', xero_synced_at=NOW(), xero_error=NULL WHERE id=$2`,
    [bankTransactionID, cost.id]
  );

  // Receipt attach is non-fatal — the Spend Money is the important leg.
  if (cost.receipt_r2_key) {
    try {
      await attachReceipt(cost, 'BankTransactions', bankTransactionID);
      await query(`UPDATE costs SET xero_sync_state='attached', xero_synced_at=NOW() WHERE id=$1`, [cost.id]);
    } catch (err) {
      const msg = err instanceof XeroApiError ? `Receipt attach: ${err.message}` : err instanceof Error ? err.message : String(err);
      await query(`UPDATE costs SET xero_error=$1 WHERE id=$2`, [msg.slice(0, 500), cost.id]);
      return { pushed: true, bankTransactionID, error: msg };
    }
  }
  return { pushed: true, bankTransactionID };
}

// ── Bill flow (pay-later methods) ────────────────────────────────────────────
// Step 1: create the AUTHORISED bill on approval. Step 2: once paid, record the
// payment against it. The push picks up whichever step is outstanding.

async function pushBill(cost: CostRow): Promise<PushResult> {
  const billExists = Boolean(cost.xero_object_id) && PUSHED_STATES.includes(cost.xero_sync_state);

  // ── Step 1: ensure the bill is in Xero ──────────────────────────────────
  if (!billExists) {
    if (!cost.approval_state || !['approved', 'paid'].includes(cost.approval_state)) {
      await recordAdvisory(cost.id, 'Bill is created in Xero once this cost is approved');
      return { pushed: false, skipped: 'Awaiting approval' };
    }
    if (!cost.amount_gross || Number(cost.amount_gross) <= 0) {
      await recordError(cost.id, 'Gross amount required to push');
      return { pushed: false, error: 'Gross amount required' };
    }
    if (!cost.xero_account_code) {
      await recordError(cost.id, MISSING_CATEGORY_MSG);
      return { pushed: false, error: MISSING_CATEGORY_MSG };
    }

    // reimburse_me: the company owes the STAFF MEMBER, not the receipt vendor.
    // Bill goes to the staff member; the vendor is noted on the line + the
    // receipt attached as supporting evidence.
    const isReimburse = cost.payment_method === 'reimburse_me';
    const contactName = isReimburse
      ? (cost.uploaded_by_name?.trim() || 'Staff reimbursement')
      : (cost.supplier_name || 'Unknown supplier').toString().slice(0, 500);
    const baseDesc = (cost.description || cost.category || 'Cost').toString();
    const description = (isReimburse && cost.supplier_name ? `${cost.supplier_name} — ${baseDesc}` : baseDesc).slice(0, 4000);

    const { lineItems, lineAmountTypes } = await buildCostLineItems(cost, description);
    const { resolveTermsForSupplier, computeDueDate } = await import('./supplier-terms');
    const billTerms = await resolveTermsForSupplier(cost.xero_contact_id, cost.supplier_name);
    const billDueDate = computeDueDate(dateOnly(cost.cost_date), billTerms) ?? addDaysISO(dateOnly(cost.cost_date), 30);
    let invoiceID: string;
    try {
      const bill = await xeroBroker.createBill({
        contactName,
        date: dateOnly(cost.cost_date),
        dueDate: billDueDate,
        reference: xeroReference(cost),
        status: 'AUTHORISED',
        lineAmountTypes,
        lineItems,
      });
      invoiceID = bill.InvoiceID;
    } catch (err) {
      if (isScopeError(err)) {
        await recordAdvisory(cost.id, SCOPE_ADVISORY);
        return { pushed: false, skipped: 'Bills scope not granted' };
      }
      const msg = err instanceof XeroApiError ? `Xero: ${err.message}` : err instanceof Error ? err.message : String(err);
      await recordError(cost.id, msg);
      return { pushed: false, error: msg };
    }

    await query(
      `UPDATE costs SET xero_object_id=$1, xero_sync_state='bill_created', xero_synced_at=NOW(), xero_error=NULL WHERE id=$2`,
      [invoiceID, cost.id]
    );
    cost.xero_object_id = invoiceID;
    cost.xero_sync_state = 'bill_created';

    if (cost.receipt_r2_key) {
      try {
        await attachReceipt(cost, 'Invoices', invoiceID);
        await query(`UPDATE costs SET xero_sync_state='attached', xero_synced_at=NOW() WHERE id=$1`, [cost.id]);
        cost.xero_sync_state = 'attached';
      } catch (err) {
        const msg = err instanceof XeroApiError ? `Receipt attach: ${err.message}` : err instanceof Error ? err.message : String(err);
        await query(`UPDATE costs SET xero_error=$1 WHERE id=$2`, [msg.slice(0, 500), cost.id]);
        // fall through — the bill exists; payment can still be recorded.
      }
    }
  }

  // ── Step 2: if paid, record the payment against the bill ─────────────────
  if (cost.payment_status === 'paid' && !cost.xero_payment_id && cost.xero_object_id) {
    const payResult = await recordBillPayment(cost);
    if (payResult.error) return { pushed: true, invoiceID: cost.xero_object_id, error: payResult.error };
    if (payResult.skipped) return { pushed: true, invoiceID: cost.xero_object_id, skipped: payResult.skipped };
    return { pushed: true, invoiceID: cost.xero_object_id, paymentID: payResult.paymentID };
  }

  return { pushed: true, invoiceID: cost.xero_object_id || undefined };
}

// Record a Payment against an existing bill. Bank account = the pay method's
// mapping; date = paid_value_date (can be future) || paid_at || today.
async function recordBillPayment(cost: CostRow): Promise<{ paymentID?: string; skipped?: string; error?: string }> {
  if (!cost.xero_object_id) return { skipped: 'Bill not in Xero yet' };
  if (cost.xero_payment_id) return { skipped: 'Payment already recorded' };

  const payMethod = cost.paid_method;
  if (!payMethod) {
    await recordAdvisory(cost.id, 'Mark the bill paid with a payment method to record the payment in Xero');
    return { skipped: 'No pay method' };
  }
  const bankAccountId = await getSystemSetting(`xero_bank_${payMethod}`);
  if (!bankAccountId) {
    await recordAdvisory(cost.id, `No Xero bank account mapped for "${payMethod}" — set it in Settings → Xero Bank Accounts to record the payment`);
    return { skipped: 'Pay-method bank mapping missing' };
  }

  try {
    const payment = await xeroBroker.payInvoice({
      invoiceId: cost.xero_object_id,
      accountId: bankAccountId,
      amount: Number(cost.amount_gross),
      date: dateOnly(cost.paid_value_date) || dateOnly(cost.paid_at) || undefined,
      reference: xeroReference(cost),
    });
    await query(`UPDATE costs SET xero_payment_id=$1, xero_synced_at=NOW(), xero_error=NULL WHERE id=$2`, [payment.PaymentID, cost.id]);
    return { paymentID: payment.PaymentID };
  } catch (err) {
    if (isScopeError(err)) {
      await recordAdvisory(cost.id, SCOPE_ADVISORY);
      return { skipped: 'Bills scope not granted' };
    }
    const msg = err instanceof XeroApiError ? `Xero payment: ${err.message}` : err instanceof Error ? err.message : String(err);
    // Don't downgrade the bill's attached state — flag the payment failure only.
    await query(`UPDATE costs SET xero_error=$1 WHERE id=$2`, [msg.slice(0, 500), cost.id]);
    return { error: msg };
  }
}

/**
 * Push a single cost to Xero. Idempotent and resumable: a fully-pushed cost is a
 * no-op; a part-done one continues from where it stopped.
 */
export async function pushCostToXero(costId: string): Promise<PushResult> {
  if (!isXeroConfigured()) return { pushed: false, skipped: 'Xero not configured' };

  // Serialize all pushes for THIS cost behind a Postgres advisory lock. The push
  // is triggered from five places (create / update / approve / pay / Push-Now),
  // most fire-and-forget, so two can overlap — e.g. approve's background push
  // racing the Push-Now button. Each reads xero_object_id as null, passes the
  // billExists guard, and creates its own Xero bill → DUPLICATE BILLS (seen live
  // on T.Reeve repair invoices). The lock makes the second push wait for the
  // first to commit xero_object_id, after which loadCost + the billExists /
  // PUSHED_STATES guard short-circuit it. Different costs hash to different keys
  // so unrelated pushes never contend.
  const client = await getClient();
  const lockSql = 'pg_advisory_lock(hashtext($1)::bigint)';
  const key = `cost-push:${costId}`;
  try {
    await client.query(`SELECT ${lockSql}`, [key]);
    return await pushCostToXeroLocked(costId);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [key]); }
    catch (err) { console.error('[cost-xero-push] advisory unlock failed:', costId, err); }
    client.release();
  }
}

async function pushCostToXeroLocked(costId: string): Promise<PushResult> {
  const cost = await loadCost(costId);
  if (!cost) return { pushed: false, skipped: 'Cost not found' };

  if (cost.payment_method && (BILL_METHODS as readonly string[]).includes(cost.payment_method)) {
    return pushBill(cost);
  }
  if (cost.payment_method && (SPEND_MONEY_METHODS as readonly string[]).includes(cost.payment_method)) {
    return pushSpendMoney(cost);
  }
  return { pushed: false, skipped: `Payment method ${cost.payment_method || '(none)'} is not pushable` };
}

/**
 * Fire-and-forget wrapper used from route handlers. Logs failures but doesn't
 * surface them (the cost row carries xero_sync_state + xero_error for the UI).
 */
export function pushCostToXeroBackground(costId: string): void {
  setImmediate(() => {
    pushCostToXero(costId).catch((err) => {
      console.error('[cost-xero-push] background push failed:', costId, err);
    });
  });
}

/**
 * Re-sync an already-pushed cost to Xero IN PLACE after it was edited (the
 * "Re-sync to Xero" button behind the xero_stale flag). Updates the existing
 * Xero object rather than creating a new one — so it never duplicates.
 *
 * Hard refusals (returned as { locked: true }) — Xero won't let us mutate these,
 * and we must not try: a PAID bill (amounts locked once a payment exists) and a
 * RECONCILED spend-money. Staff fix those directly in Xero. Anything else
 * (AUTHORISED unpaid bill, unreconciled spend-money) is updated and xero_stale
 * cleared. Shares the per-cost advisory lock with pushCostToXero.
 */
export async function resyncCostToXero(costId: string): Promise<PushResult & { locked?: boolean }> {
  if (!isXeroConfigured()) return { pushed: false, skipped: 'Xero not configured' };
  const client = await getClient();
  const key = `cost-push:${costId}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [key]);
    return await resyncCostToXeroLocked(costId);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [key]); }
    catch (err) { console.error('[cost-xero-push] advisory unlock failed:', costId, err); }
    client.release();
  }
}

async function resyncCostToXeroLocked(costId: string): Promise<PushResult & { locked?: boolean }> {
  const cost = await loadCost(costId);
  if (!cost) return { pushed: false, skipped: 'Cost not found' };

  // Not in Xero yet → there's nothing to update; fall back to a normal push.
  if (!cost.xero_object_id || !PUSHED_STATES.includes(cost.xero_sync_state)) {
    return pushCostToXeroLocked(costId);
  }
  if (!cost.amount_gross || Number(cost.amount_gross) <= 0) {
    return { pushed: false, error: 'Gross amount required' };
  }
  if (!cost.xero_account_code) {
    return { pushed: false, error: MISSING_CATEGORY_MSG };
  }

  const isBill = Boolean(cost.payment_method) && (BILL_METHODS as readonly string[]).includes(cost.payment_method!);

  try {
    if (isBill) {
      // A bill with a recorded payment / marked paid has locked amounts in Xero.
      if (cost.xero_payment_id || cost.payment_status === 'paid') {
        return { pushed: false, locked: true, error: 'This bill is paid in Xero — its amounts are locked. Edit it directly in Xero.' };
      }
      const isReimburse = cost.payment_method === 'reimburse_me';
      const contactName = isReimburse
        ? (cost.uploaded_by_name?.trim() || 'Staff reimbursement')
        : (cost.supplier_name || 'Unknown supplier').toString().slice(0, 500);
      const baseDesc = (cost.description || cost.category || 'Cost').toString();
      const description = (isReimburse && cost.supplier_name ? `${cost.supplier_name} — ${baseDesc}` : baseDesc).slice(0, 4000);
      const { lineItems, lineAmountTypes } = await buildCostLineItems(cost, description);
      const { resolveTermsForSupplier, computeDueDate } = await import('./supplier-terms');
      const billTerms = await resolveTermsForSupplier(cost.xero_contact_id, cost.supplier_name);
      const billDueDate = computeDueDate(dateOnly(cost.cost_date), billTerms) ?? addDaysISO(dateOnly(cost.cost_date), 30);
      await xeroBroker.updateBill(cost.xero_object_id, {
        contactName,
        date: dateOnly(cost.cost_date),
        dueDate: billDueDate,
        reference: xeroReference(cost),
        status: 'AUTHORISED',
        lineAmountTypes,
        lineItems,
      });
    } else {
      // Spend-money: Xero blocks edits once reconciled.
      if (cost.xero_sync_state === 'reconciled') {
        return { pushed: false, locked: true, error: 'This transaction is reconciled in Xero — it can no longer be changed here. Update it directly in Xero.' };
      }
      const bankAccountId = await getSystemSetting(`xero_bank_${cost.payment_method}`);
      if (!bankAccountId) {
        return { pushed: false, error: `No Xero bank account mapped for "${cost.payment_method}".` };
      }
      const description = (cost.description || cost.category || cost.supplier_name || 'Cost').toString().slice(0, 4000);
      const { lineItems, lineAmountTypes } = await buildCostLineItems(cost, description);
      await xeroBroker.updateSpendMoney(cost.xero_object_id, {
        bankAccountId,
        contactName: (cost.supplier_name || 'Unknown supplier').toString().slice(0, 500),
        date: dateOnly(cost.cost_date),
        reference: xeroReference(cost),
        lineItems,
        lineAmountTypes,
      });
    }
  } catch (err) {
    if (isScopeError(err)) {
      await recordAdvisory(cost.id, SCOPE_ADVISORY);
      return { pushed: false, skipped: 'Bills scope not granted' };
    }
    const msg = err instanceof XeroApiError ? `Xero: ${err.message}` : err instanceof Error ? err.message : String(err);
    await recordError(cost.id, msg);
    return { pushed: false, error: msg };
  }

  await query(
    `UPDATE costs SET xero_stale=FALSE, xero_synced_at=NOW(), xero_error=NULL WHERE id=$1`,
    [cost.id]
  );
  return { pushed: true, invoiceID: cost.xero_object_id };
}
