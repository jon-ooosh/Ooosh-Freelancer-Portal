/**
 * Cost Capture → Xero push service.
 *
 * For a paid cost (any payment_method except `not_yet_paid`), creates a Spend
 * Money transaction in Xero on the mapped bank account, then attaches the
 * receipt. The bank-feed line that Codat brings in later auto-suggests our
 * Spend Money as the match — staff/accountant one-click reconcile.
 *
 * Driven from POST/PATCH /api/costs in a `setImmediate` (so the API response
 * isn't blocked on Xero) and from the manual `POST /api/costs/:id/sync-xero`
 * retry endpoint.
 *
 * State machine (costs.xero_sync_state):
 *   pending      → fresh / unsynced
 *   bill_created → Spend Money created in Xero
 *   attached     → + receipt attached
 *   reconciled   → bank line matched in Xero (future, set by webhook/sync)
 *   error        → push failed; xero_error has the message; manual retry surfaces
 *
 * ACCPAY bills are deliberately deferred until `accounting.invoices` is
 * granted. `not_yet_paid` costs hold in OP as payables and only push once the
 * staff flips them to paid (with a paid_method).
 *
 * Edits to already-pushed costs: this service is forward-only. It re-pushes if
 * the cost has no xero_object_id OR is in 'error' state; otherwise it skips.
 * A separate "re-push" affordance is the right home for edit-after-push.
 */
import { Readable } from 'stream';
import { query } from '../config/database';
import { getFromR2, isR2Configured } from '../config/r2';
import { isXeroConfigured } from '../config/xero';
import { xeroBroker, XeroApiError } from './xero-broker';
import { getSystemSetting } from '../routes/system-settings';

// Payment methods that can push as Spend Money (have a bank account on the
// other side of the transaction in Xero). 'not_yet_paid' is a bill, deferred
// for now; future: pushes as ACCPAY when `accounting.invoices` is granted.
const PUSHABLE_METHODS = ['cot_card', 'petty_cash', 'paypal', 'reimburse_me', 'other'] as const;

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

interface PushResult {
  pushed: boolean;
  skipped?: string;
  bankTransactionID?: string;
  error?: string;
}

/**
 * Push a single cost to Xero. Idempotent: a cost already in bill_created /
 * attached / reconciled state is a no-op. An 'error' or 'pending' cost gets
 * a fresh attempt.
 */
export async function pushCostToXero(costId: string): Promise<PushResult> {
  if (!isXeroConfigured()) return { pushed: false, skipped: 'Xero not configured' };

  const result = await query('SELECT * FROM costs WHERE id = $1', [costId]);
  const cost = result.rows[0];
  if (!cost) return { pushed: false, skipped: 'Cost not found' };

  // Already pushed?
  if (cost.xero_object_id && ['bill_created', 'attached', 'reconciled'].includes(cost.xero_sync_state)) {
    return { pushed: false, skipped: `Already at state ${cost.xero_sync_state}` };
  }

  // Push gates
  if (cost.payment_status !== 'paid') {
    return { pushed: false, skipped: `Payment status is ${cost.payment_status} — not yet pushable` };
  }
  if (!PUSHABLE_METHODS.includes(cost.payment_method)) {
    return { pushed: false, skipped: `Payment method ${cost.payment_method} is not pushable yet` };
  }
  if (!cost.amount_gross || Number(cost.amount_gross) <= 0) {
    await recordError(costId, 'Gross amount required to push');
    return { pushed: false, error: 'Gross amount required' };
  }
  if (!cost.xero_account_code) {
    await recordError(costId, 'No Xero account code on the cost — pick a category and retry');
    return { pushed: false, error: 'Missing xero_account_code' };
  }

  // Bank account mapping (system_settings)
  const bankSettingKey = `xero_bank_${cost.payment_method}`;
  const bankAccountId = await getSystemSetting(bankSettingKey);
  if (!bankAccountId) {
    // Soft skip — staff have deliberately left this method unmapped (or just
    // haven't configured it yet). Keep state='pending' so the UI shows a calm
    // "Not synced" badge rather than a red "Failed"; advisory text in
    // xero_error explains why a retry wouldn't help.
    await query(
      `UPDATE costs SET xero_error = $1 WHERE id = $2`,
      [`No Xero bank account mapped for "${cost.payment_method}" — set it in Settings → Xero Bank Accounts to enable sync`, costId],
    );
    return { pushed: false, skipped: 'Bank account mapping missing' };
  }

  // Build line item. Xero auto-applies the account's default tax rate when
  // TaxType isn't supplied — fine for MVP. Inclusive amounts.
  const description = (cost.description || cost.category || cost.supplier_name || 'Cost').toString().slice(0, 4000);
  const lineItem = {
    Description: description,
    Quantity: 1,
    UnitAmount: Number(cost.amount_gross),
    AccountCode: String(cost.xero_account_code),
  };

  // Create Spend Money
  let bankTransactionID: string;
  try {
    const supplier = (cost.supplier_name || 'Unknown supplier').toString().slice(0, 500);
    const txn = await xeroBroker.createSpendMoney({
      bankAccountId,
      contactName: supplier,
      date: cost.cost_date ? new Date(cost.cost_date).toISOString().slice(0, 10) : undefined,
      reference: (cost.supplier_name || '').toString().slice(0, 255) || undefined,
      lineItems: [lineItem],
      lineAmountTypes: 'Inclusive',
    });
    bankTransactionID = txn.BankTransactionID;
  } catch (err) {
    const msg = err instanceof XeroApiError ? `Xero: ${err.message}` : err instanceof Error ? err.message : String(err);
    await recordError(costId, msg);
    return { pushed: false, error: msg };
  }

  // Persist the link before the receipt attach so a partial failure doesn't
  // strand an orphan Xero transaction without us knowing about it.
  await query(
    `UPDATE costs SET xero_object_id=$1, xero_sync_state='bill_created',
       xero_synced_at=NOW(), xero_error=NULL
     WHERE id=$2`,
    [bankTransactionID, costId]
  );

  // Attach receipt if present and R2 is up. Receipt-attach failure is
  // non-fatal — the Spend Money record is the more important leg; staff can
  // re-attach later via retry.
  if (cost.receipt_r2_key && cost.receipt_filename && isR2Configured()) {
    try {
      const r2obj = await getFromR2(cost.receipt_r2_key);
      const body = r2obj.Body as Readable | undefined;
      if (!body) throw new Error('Receipt body unavailable from R2');
      const buffer = await streamToBuffer(body);
      const contentType = guessContentType(cost.receipt_filename);
      await xeroBroker.attachReceipt('BankTransactions', bankTransactionID, cost.receipt_filename, buffer, contentType);
      await query(
        `UPDATE costs SET xero_sync_state='attached', xero_synced_at=NOW() WHERE id=$1`,
        [costId]
      );
    } catch (err) {
      const msg = err instanceof XeroApiError ? `Receipt attach: ${err.message}` : err instanceof Error ? err.message : String(err);
      // Keep state='bill_created' so the Xero transaction is recognised; flag
      // the partial failure so staff can retry just the attach.
      await query(`UPDATE costs SET xero_error=$1 WHERE id=$2`, [msg.slice(0, 500), costId]);
      return { pushed: true, bankTransactionID, error: msg };
    }
  }

  return { pushed: true, bankTransactionID };
}

/**
 * Fire-and-forget wrapper used from route handlers. Logs failures but doesn't
 * surface them (the cost row itself carries xero_sync_state + xero_error for
 * the UI to render).
 */
export function pushCostToXeroBackground(costId: string): void {
  setImmediate(() => {
    pushCostToXero(costId).catch((err) => {
      console.error('[cost-xero-push] background push failed:', costId, err);
    });
  });
}
