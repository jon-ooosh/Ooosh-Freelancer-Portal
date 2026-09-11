/**
 * Paying many bills with one payment.
 *
 * The garage sends twenty invoices a month and gets one bank transfer. Marking
 * those paid one at a time is the tedium; so is reconciling twenty separate
 * Xero payments against one bank line. So this creates a Xero BATCH PAYMENT —
 * one payment object covering N bills, which reconciles in a single click —
 * rather than looping the single-payment path.
 *
 * TWO RULES, both about not leaving a half-done payment run behind:
 *
 * 1. ALL OR NOTHING ON VALIDATION. Every selected bill is checked before
 *    anything is sent. One ineligible bill refuses the whole batch and says
 *    which — a batch that paid nineteen of twenty, with no record of which one
 *    it skipped, is worse than one that paid none.
 *
 * 2. XERO FIRST, THEN US. The batch is created in Xero before a single row is
 *    marked paid. If Xero rejects it, nothing in OP has moved and the user can
 *    fix and retry. The reverse order would leave bills marked paid in OP with
 *    no money recorded anywhere — the failure that is hardest to notice.
 *
 * There is deliberately no fallback to individual payments when the batch is
 * refused. It would work, but it would quietly deliver the reconciliation mess
 * the user chose a batch to avoid.
 */
import { query, getClient } from '../config/database';
import { xeroBroker, XeroApiError } from './xero-broker';
import { getSystemSetting } from '../routes/system-settings';

/** Pay-later methods — a bill in Xero, payable by batch. Mirrors BILL_METHODS. */
const BILL_METHODS = ['not_yet_paid', 'reimburse_me'];

export interface BatchPayInput {
  costIds: string[];
  /** The instrument the money left from — picks the Xero bank account. */
  paidMethod: string;
  /** Value date, YYYY-MM-DD. May be future for a scheduled payment. */
  paidDate?: string | null;
  reference?: string | null;
  userId: string;
}

export interface BatchPayResult {
  paid: number;
  total: number;
  batchPaymentId?: string;
  /** Staff-readable refusal. When set, NOTHING was paid. */
  error?: string;
}

interface Candidate {
  id: string;
  supplier_name: string | null;
  invoice_number: string | null;
  amount_gross: string | number | null;
  currency: string | null;
  payment_method: string | null;
  payment_status: string;
  approval_state: string | null;
  xero_object_id: string | null;
  xero_object_type: string | null;
  xero_payment_id: string | null;
}

const pence = (v: unknown) => Math.round((Number(v) || 0) * 100);
const name = (c: Candidate) =>
  `${c.supplier_name || 'Unknown supplier'}${c.invoice_number ? ` #${c.invoice_number}` : ''}`;

/**
 * Why a bill can't go in a batch, or null if it can.
 *
 * Split out so the reason can be quoted back verbatim — "3 of 20 can't be paid"
 * is useless; naming the three is what lets someone fix it.
 */
function ineligible(c: Candidate): string | null {
  if (!BILL_METHODS.includes(String(c.payment_method))) {
    return 'is a paid-now cost, not a bill — there is nothing outstanding to pay';
  }
  if (c.payment_status === 'paid' || c.xero_payment_id) {
    return 'is already marked paid';
  }
  if (!c.xero_object_id || c.xero_object_type === 'banktransaction') {
    return 'has no bill in Xero yet — approve it and let it sync first';
  }
  if (!['approved', 'paid'].includes(String(c.approval_state))) {
    return `is still ${c.approval_state || 'unapproved'} — only approved bills can be paid`;
  }
  if (pence(c.amount_gross) <= 0) return 'has no amount';
  if (c.currency && c.currency !== 'GBP') return `is in ${c.currency}, not GBP`;
  return null;
}

export async function payCostsAsBatch(input: BatchPayInput): Promise<BatchPayResult> {
  const ids = [...new Set(input.costIds)].filter(Boolean);
  if (!ids.length) return { paid: 0, total: 0, error: 'Nothing selected.' };

  const r = await query(
    `SELECT id, supplier_name, invoice_number, amount_gross, currency, payment_method,
            payment_status, approval_state, xero_object_id, xero_object_type, xero_payment_id
       FROM costs WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const rows = r.rows as Candidate[];

  if (rows.length !== ids.length) {
    return { paid: 0, total: 0, error: 'Some of those costs no longer exist — refresh and try again.' };
  }

  // Rule 1: everything is checked before anything is sent.
  const problems = rows.map((c) => { const why = ineligible(c); return why ? `${name(c)} ${why}` : null; })
    .filter(Boolean) as string[];
  if (problems.length) {
    const shown = problems.slice(0, 3).join('; ');
    return {
      paid: 0, total: 0,
      error: `Nothing was paid. ${shown}${problems.length > 3 ? `; and ${problems.length - 3} more` : ''}. Deselect those and try again.`,
    };
  }

  const bankAccountId = await getSystemSetting(`xero_bank_${input.paidMethod}`);
  if (!bankAccountId) {
    return {
      paid: 0, total: 0,
      error: `No Xero bank account is mapped for "${input.paidMethod}". Set it in Settings → Xero Bank Accounts, then try again.`,
    };
  }

  const totalPence = rows.reduce((t, c) => t + pence(c.amount_gross), 0);

  // Rule 2: Xero first. Nothing in OP moves until the money is recorded there.
  let batch: Awaited<ReturnType<typeof xeroBroker.createBatchPayment>>;
  try {
    batch = await xeroBroker.createBatchPayment({
      accountId: bankAccountId,
      date: input.paidDate || undefined,
      reference: (input.reference || '').trim().slice(0, 255) || undefined,
      payments: rows.map((c) => ({
        invoiceId: c.xero_object_id as string,
        amount: pence(c.amount_gross) / 100,
      })),
    });
  } catch (err) {
    const msg = err instanceof XeroApiError ? `Xero: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    return { paid: 0, total: totalPence / 100, error: `Nothing was paid — Xero rejected the batch. ${msg}` };
  }

  // Xero returns the constituent payments; prefer each invoice's own PaymentID
  // and fall back to the batch id, which still traces the row to its payment.
  const byInvoice = new Map<string, string>();
  for (const p of batch.Payments ?? []) {
    if (p.Invoice?.InvoiceID && p.PaymentID) byInvoice.set(p.Invoice.InvoiceID, p.PaymentID);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    for (const c of rows) {
      await client.query(
        `UPDATE costs
            SET approval_state = 'paid', payment_status = 'paid',
                paid_by = $1, paid_at = NOW(), paid_method = $2,
                paid_value_date = COALESCE($3::date, CURRENT_DATE),
                xero_payment_id = $4, xero_synced_at = NOW(), xero_error = NULL
          WHERE id = $5`,
        [
          input.userId, input.paidMethod, input.paidDate || null,
          byInvoice.get(c.xero_object_id as string) ?? batch.BatchPaymentID ?? null,
          c.id,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* nothing left to salvage */ });
    // The money IS recorded in Xero at this point — surfacing the batch id is
    // what lets someone reconcile by hand rather than paying twice.
    throw new Error(
      `Xero recorded batch payment ${batch.BatchPaymentID ?? '(id unknown)'} but OP failed to mark the bills paid: ${
        err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    client.release();
  }

  // Audit AFTER the commit, best-effort. Inside the transaction a failed audit
  // insert would roll back bills whose money is already recorded in Xero —
  // trading a missing log line for a real accounting discrepancy.
  for (const c of rows) {
    await query(
      `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
       VALUES ($1, 'cost', $2, 'cost_paid_batch', $3, $4)`,
      [input.userId, c.id,
       JSON.stringify({ payment_status: c.payment_status, approval_state: c.approval_state }),
       JSON.stringify({
         payment_status: 'paid', approval_state: 'paid',
         paid_method: input.paidMethod, paid_date: input.paidDate || null,
         batch_payment_id: batch.BatchPaymentID ?? null, batch_size: rows.length,
       })],
    ).catch((err) => console.warn('[cost-batch-pay] audit log failed (non-fatal):', (err as Error).message));
  }

  return { paid: rows.length, total: totalPence / 100, batchPaymentId: batch.BatchPaymentID };
}
