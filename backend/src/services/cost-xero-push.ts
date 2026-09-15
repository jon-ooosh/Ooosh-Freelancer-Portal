/**
 * Cost Capture → Xero push service.
 *
 * Two flows, picked by payment_method:
 *
 *   Paid-now (cot_card / amex / lloyds_cc / petty_cash / paypal / wise /
 *   lloyds_transfer) → a Spend Money on the mapped bank account + the
 *   document set attached. Codat's bank-feed line auto-suggests it for one-click reconcile.
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
 *   attached     → + receipt (and any supporting documents) attached
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
import { collectDocuments, hasDocuments, type CostDocumentRow } from './cost-documents';
import { fetchCostLines, grossesWithResidue } from './cost-lines';

// Paid-now methods → Spend Money on the mapped bank/card account.
// (Exported for the reconcile sync — cost-xero-reconcile-sync.ts.)
export const SPEND_MONEY_METHODS = ['cot_card', 'amex', 'lloyds_cc', 'petty_cash', 'paypal', 'wise', 'lloyds_transfer'] as const;
// Pay-later methods → authorised ACCPAY bill on approval, payment recorded when paid.
const BILL_METHODS = ['not_yet_paid', 'reimburse_me'] as const;

const PUSHED_STATES = ['bill_created', 'attached', 'reconciled'];

/**
 * Does this cost already have an object in Xero?
 *
 * `xero_object_id` ALONE answers this, and nothing else may be added to it.
 *
 * The guards here used to read `xero_object_id && PUSHED_STATES.includes(state)`,
 * which conflates two different questions. `xero_object_id` says whether the
 * thing EXISTS in Xero. `xero_sync_state` says whether the LAST OPERATION on it
 * succeeded. `recordError()` sets state='error' and leaves the id in place — so
 * a cost with a live, perfectly good bill whose attach step hit a 429 read as
 * "not in Xero", and the next push created a SECOND bill. Re-sync was worst: it
 * fell through to the create path on any non-pushed state, so pressing
 * "Re-sync to Xero" on an errored cost is what duplicated it.
 *
 * An errored cost is not an unsynced cost. It is a synced cost that is unhappy.
 */
export function existsInXero(cost: { xero_object_id?: string | null }): boolean {
  return Boolean(cost.xero_object_id);
}

/**
 * Which Xero entity `xero_object_id` refers to.
 *
 * Recorded at creation (migration 209). Legacy rows fall back to the guess the
 * code used to make — the CURRENT payment method — which is right unless that
 * method changed after the push, the case that produced today's "specified
 * BankTransactionID does not match a known bank transaction" errors.
 */
function xeroEntity(cost: CostRow): 'Invoices' | 'BankTransactions' {
  if (cost.xero_object_type === 'invoice') return 'Invoices';
  if (cost.xero_object_type === 'banktransaction') return 'BankTransactions';
  const isBill = Boolean(cost.payment_method) && (BILL_METHODS as readonly string[]).includes(cost.payment_method!);
  return isBill ? 'Invoices' : 'BankTransactions';
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
  approved_at: string | null;
  cost_type: string | null;
  amount_gross: string | number | null;
  amount_vat: string | number | null;
  amount_net: string | number | null;
  vat_treatment: string | null;
  xero_account_code: string | null;
  xero_object_id: string | null;
  xero_object_type: 'invoice' | 'banktransaction' | null;
  xero_payment_id: string | null;
  xero_sync_state: string;
  supplier_name: string | null;
  invoice_number: string | null;
  description: string | null;
  category: string | null;
  cost_date: string | null;
  due_date_override: string | null;
  xero_contact_id: string | null;
  paid_method: string | null;
  paid_value_date: string | null;
  paid_at: string | null;
  receipt_r2_key: string | null;
  receipt_filename: string | null;
  supporting_documents: CostDocumentRow[] | null;
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

// Resolve the Xero TaxType for a line. No VAT recorded → 'NONE' (so a
// freelancer's no-VAT invoice doesn't inherit the account's 20% default). VAT
// recorded → the org's purchase tax type for the implied rate (fallback: leave
// undefined so Xero applies the account default, which is correct for 20%).
//
// Takes the two figures rather than a whole CostRow so it serves a cost LINE as
// well as the header. That matters: the rate is DERIVED, so a header covering
// mixed rates yields a blend that is not a real rate at all — £250 no-VAT labour
// + £60 fuel (£10 VAT) + £15 zero-rated travel implies round(10/315*100) = 3%,
// nothing matches, and the whole £325 falls through to the account default.
// Only a homogeneous line produces a true rate. See docs/COST-LINES-SPEC.md §5.
async function resolveLineTaxType(amounts: { amount_vat?: unknown; amount_net?: unknown }): Promise<string | undefined> {
  const vat = Number(amounts.amount_vat || 0);
  const net = Number(amounts.amount_net || 0);
  if (vat <= 0) return 'NONE';
  const rate = net > 0 ? Math.round((vat / net) * 100) : 20;
  return (await xeroBroker.getPurchaseTaxType(rate)) || undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Xero Reference field: the supplier's invoice number when we have one (so the
// bill/transaction is findable by the number printed on the paperwork),
// falling back to the supplier name. Max 255 chars per Xero.
// NOTE: some suppliers use a UUID-shaped invoice number verbatim (e.g. Spotify's
// printed "Invoice ID" is a real GUID) — do NOT filter those out, they're genuine.
// On SPEND-MONEY this is the field the Xero UI labels "Reference" (visible). On a
// BILL it's stored but hidden — the visible box there is InvoiceNumber (below).
function xeroReference(cost: CostRow): string | undefined {
  const ref = (cost.invoice_number || cost.supplier_name || '').toString().trim().slice(0, 255);
  return ref || undefined;
}

// Xero InvoiceNumber = the "Reference" box the Xero UI shows on a BILL (ACCPAY).
// So the supplier's invoice number must go here to actually appear on the bill.
// The invoice number ONLY — no supplier-name fallback (the Contact already names
// the supplier; a name in this box would be wrong/ugly). Undefined = leave blank.
function xeroInvoiceNumber(cost: CostRow): string | undefined {
  const n = (cost.invoice_number || '').toString().trim().slice(0, 255);
  return n || undefined;
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

  // Split into lines? One Xero line each, with its OWN account code and its own
  // derived tax rate — the whole point of lines (see resolveLineTaxType above).
  // A line with no code of its own inherits the cost's.
  const lines = await fetchCostLines(String(cost.id));
  if (lines.length) {
    const grosses = grossesWithResidue(lines, cost.amount_gross);

    const items: XeroLineItem[] = [];
    for (const [i, l] of lines.entries()) {
      const lineVat = round2(Number(l.amount_vat || 0));
      const lineTax = await resolveLineTaxType({ amount_vat: lineVat, amount_net: round2(grosses[i] - lineVat) });
      items.push({
        Description: (l.description || description || '').toString().slice(0, 4000) || description,
        Quantity: 1,
        UnitAmount: grosses[i],
        AccountCode: String(l.xero_account_code || account),
        ...(lineTax ? { TaxType: lineTax } : {}),
      });
    }
    return { lineAmountTypes: 'Inclusive', lineItems: items };
  }

  const taxType = await resolveLineTaxType(cost);
  return {
    lineAmountTypes: 'Inclusive',
    lineItems: [
      { Description: description, Quantity: 1, UnitAmount: Number(cost.amount_gross), AccountCode: account, ...(taxType ? { TaxType: taxType } : {}) },
    ],
  };
}

/**
 * Attach the receipt + every supporting document to the Xero object.
 *
 * The set (and its collision-safe filenames) comes from collectDocuments — see
 * services/cost-documents.ts for why the renaming matters.
 *
 * Throws on the FIRST failure so the caller can surface it. The part of the set
 * that did land stays attached (Xero attachments are independent) and a re-sync
 * re-attaches the lot idempotently by filename.
 */
async function attachDocuments(
  cost: CostRow,
  entity: 'Invoices' | 'BankTransactions',
  entityId: string,
): Promise<number> {
  if (!isR2Configured()) return 0;
  const docs = collectDocuments(cost);
  let attached = 0;
  for (const doc of docs) {
    const r2obj = await getFromR2(doc.r2Key);
    const body = r2obj.Body as Readable | undefined;
    if (!body) throw new Error(`Document body unavailable from R2: ${doc.filename}`);
    const buffer = await streamToBuffer(body);
    await xeroBroker.attachReceipt(entity, entityId, doc.filename, buffer, doc.contentType);
    attached += 1;
  }
  return attached;
}

// ── Spend Money flow (paid-now methods) ──────────────────────────────────────

async function pushSpendMoney(cost: CostRow): Promise<PushResult> {
  // Already in Xero → never create a second one, whatever state we're in.
  if (existsInXero(cost)) {
    return { pushed: false, skipped: `Already in Xero (${cost.xero_sync_state})` };
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
    `UPDATE costs SET xero_object_id=$1, xero_object_type='banktransaction',
            xero_sync_state='bill_created', xero_synced_at=NOW(), xero_error=NULL WHERE id=$2`,
    [bankTransactionID, cost.id]
  );

  // Document attach is non-fatal — the Spend Money is the important leg.
  if (hasDocuments(cost)) {
    try {
      await attachDocuments(cost, 'BankTransactions', bankTransactionID);
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
  const billExists = existsInXero(cost);

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
    const { seedTermsFromXeroIfMissing, resolveDueDateForCost } = await import('./supplier-terms');

    // Resolve the Xero contact FIRST so we can (a) persist its id back on the
    // cost — which is what lets Xero supplier terms seed + pull through on this
    // and future bills (the link was previously never saved) — and (b) create
    // the bill against the contact id directly. Skipped for reimburse_me, where
    // the "contact" is the staff member, not a supplier whose terms we'd want.
    let contactId: string | undefined;
    if (!isReimburse) {
      try {
        const contact = await xeroBroker.getOrCreateContact(contactName);
        contactId = contact.ContactID;
        if (contactId && contactId !== cost.xero_contact_id) {
          await query(`UPDATE costs SET xero_contact_id=$1 WHERE id=$2`, [contactId, cost.id]);
          cost.xero_contact_id = contactId;
        }
        await seedTermsFromXeroIfMissing(contactId, cost.supplier_name);
      } catch (err) {
        if (isScopeError(err)) { await recordAdvisory(cost.id, SCOPE_ADVISORY); return { pushed: false, skipped: 'Contacts scope not granted' }; }
        // Non-fatal — fall back to creating the bill by contact name.
        console.warn('[cost-xero-push] contact resolve failed, using name:', (err as Error).message);
      }
    }

    // Staff override → freelancer Friday terms → supplier/Xero terms. Same
    // engine as the costs list, so what staff saw is what Xero gets.
    const billDueDate = (await resolveDueDateForCost(cost)).dueDate
      ?? addDaysISO(dateOnly(cost.cost_date), 30);

    let invoiceID: string;
    try {
      const bill = await xeroBroker.createBill({
        contactName,
        contactId,
        date: dateOnly(cost.cost_date),
        dueDate: billDueDate,
        reference: xeroReference(cost),
        invoiceNumber: xeroInvoiceNumber(cost),
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
      `UPDATE costs SET xero_object_id=$1, xero_object_type='invoice',
              xero_sync_state='bill_created', xero_synced_at=NOW(), xero_error=NULL WHERE id=$2`,
      [invoiceID, cost.id]
    );
    cost.xero_object_id = invoiceID;
    cost.xero_sync_state = 'bill_created';

    if (hasDocuments(cost)) {
      try {
        await attachDocuments(cost, 'Invoices', invoiceID);
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
  // Keyed on the id ALONE: an errored cost still HAS its object, and falling
  // through to the create path here is what produced duplicate bills.
  if (!existsInXero(cost)) {
    return pushCostToXeroLocked(costId);
  }
  // Non-null past the guard; existsInXero() is exactly this check.
  const objectId = cost.xero_object_id as string;
  if (!cost.amount_gross || Number(cost.amount_gross) <= 0) {
    return { pushed: false, error: 'Gross amount required' };
  }
  if (!cost.xero_account_code) {
    return { pushed: false, error: MISSING_CATEGORY_MSG };
  }

  // What we CREATED, not what the current payment method implies — see
  // xeroEntity(). Changing the method after a push used to re-point the update
  // at the wrong Xero endpoint.
  const isBill = xeroEntity(cost) === 'Invoices';

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
      const { resolveDueDateForCost } = await import('./supplier-terms');
      const billDueDate = (await resolveDueDateForCost(cost)).dueDate
        ?? addDaysISO(dateOnly(cost.cost_date), 30);
      await xeroBroker.updateBill(objectId, {
        contactName,
        date: dateOnly(cost.cost_date),
        dueDate: billDueDate,
        reference: xeroReference(cost),
        invoiceNumber: xeroInvoiceNumber(cost),
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
      await xeroBroker.updateSpendMoney(objectId, {
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

  // Re-attach the document set. A supporting doc added after the original push
  // has no other route to Xero, and re-attaching is idempotent (same filenames
  // overwrite in place). Non-fatal — the figures are the important leg.
  let attachError: string | undefined;
  if (hasDocuments(cost)) {
    try {
      await attachDocuments(cost, isBill ? 'Invoices' : 'BankTransactions', objectId);
    } catch (err) {
      attachError = err instanceof XeroApiError ? `Document attach: ${err.message}`
        : err instanceof Error ? err.message : String(err);
    }
  }

  await query(
    `UPDATE costs SET xero_stale=FALSE, xero_synced_at=NOW(), xero_error=$2 WHERE id=$1`,
    [cost.id, attachError ? attachError.slice(0, 500) : null]
  );
  return { pushed: true, invoiceID: objectId, ...(attachError ? { error: attachError } : {}) };
}
