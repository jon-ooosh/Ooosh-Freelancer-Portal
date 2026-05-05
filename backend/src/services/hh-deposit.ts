/**
 * Shared HireHop deposit push helper.
 *
 * Centralises the two-step deposit creation flow (billing_deposit_save.php +
 * accounting/tasks.php Xero sync) used by:
 *   - POST /api/money/:jobId/record-payment       (Money tab top button)
 *   - POST /api/excess/:id/payment                (Insurance Excess Manage modal)
 *
 * Before this helper existed, only `record-payment` had the push wired in. The
 * excess `/payment` endpoint silently never pushed, so excesses recorded via
 * Manage > Record Payment never appeared in HireHop billing.
 *
 * Failures are returned in the result so callers can surface them to the UI
 * rather than silently logging "non-fatal" and pretending it worked.
 */

import { hhBroker } from './hirehop-broker';

// HireHop bank account labels (for emails / memos).
export const PAYMENT_METHODS_LABELS: Record<string, string> = {
  stripe_gbp: 'Stripe GBP',
  worldpay: 'Worldpay',
  amex: 'Amex',
  wise_bacs: 'bank transfer',
  till_cash: 'cash',
  paypal: 'PayPal',
  lloyds_bank: 'bank transfer',
  rolled_over: 'account balance',
};

/**
 * Map OP payment-method strings to HireHop bank account IDs.
 * Source-of-truth IDs (must match HH config exactly):
 *   165 = Amex
 *   168 = Till (Cash)
 *   169 = Worldpay (all cards EXCEPT AMEX)
 *   170 = Lloyds Bank
 *   173 = Paypal
 *   265 = Wise - Current Account (BACS) — bank transfers
 *   267 = Stripe GBP — online card payments via Payment Portal
 */
export function getHHBankId(paymentMethod: string): number {
  const mapping: Record<string, number> = {
    stripe_gbp: 267,
    worldpay: 169,
    amex: 165,
    wise_bacs: 265,
    till_cash: 168,
    paypal: 173,
    lloyds_bank: 170,
    rolled_over: 265,
  };
  return mapping[paymentMethod] || 169;
}

export interface PushDepositOpts {
  hhJobNumber: number;            // HH job ID (the integer, not the OP UUID)
  amount: number;                 // GBP, positive
  paymentMethod: string;          // OP method key (worldpay, stripe_gbp, etc.)
  paymentReference?: string | null;
  paymentType: 'deposit' | 'balance' | 'excess' | 'refund' | 'excess_refund' | 'other';
  notes?: string | null;
}

export interface PushDepositResult {
  hhDepositId: number | null;
  xeroSynced: boolean;
  error: string | null;           // human-readable; null on success
}

/**
 * Create a deposit in HireHop and trigger Xero sync.
 *
 * Returns a structured result rather than throwing; callers should pass `error`
 * back to the client so the UI can warn (rather than the historic silent-fail
 * behaviour where the response was 200 OK with hirehop_deposit_id: null and no
 * indication anything went wrong).
 */
export async function pushDepositToHH(opts: PushDepositOpts): Promise<PushDepositResult> {
  const { hhJobNumber, amount, paymentMethod, paymentReference, paymentType, notes } = opts;

  try {
    // Look up CLIENT_ID for the HH job (cheap cached read)
    let hhClientId: number | null = null;
    try {
      const jobDataRes = await hhBroker.get<Record<string, any>>(
        '/api/job_data.php',
        { job: hhJobNumber },
        { priority: 'high', cacheTTL: 60 }
      );
      if (jobDataRes.success && jobDataRes.data) {
        hhClientId = (jobDataRes.data as any).CLIENT_ID || (jobDataRes.data as any).client_id || null;
      }
    } catch {
      // non-fatal — HH will reject if it really needs CLIENT_ID
    }

    const currentDate = new Date().toISOString().split('T')[0];
    const formattedDate = new Date().toLocaleDateString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });
    const methodLabel = PAYMENT_METHODS_LABELS[paymentMethod] || paymentMethod.replace(/_/g, ' ');
    const typeLabel = paymentType === 'excess'
      ? 'excess'
      : paymentType === 'deposit'
        ? 'deposit'
        : paymentType;
    const description = `${hhJobNumber} - ${typeLabel}`;
    const memo = `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} ${formattedDate} via ${methodLabel}${paymentReference ? ` (Ref: ${paymentReference})` : ''}${notes ? ` — ${notes}` : ''} (recorded via Ooosh OP)`;

    const hhBankId = getHHBankId(paymentMethod);
    const depositParams: Record<string, unknown> = {
      ID: 0, // 0 = create new
      DATE: currentDate,
      DESCRIPTION: description,
      AMOUNT: amount,
      MEMO: memo,
      ACC_ACCOUNT_ID: hhBankId,
      ACC_PACKAGE_ID: 3,   // 3 = Xero integration
      'CURRENCY[CODE]': 'GBP',
      'CURRENCY[NAME]': 'United Kingdom Pound',
      'CURRENCY[SYMBOL]': '£',
      'CURRENCY[DECIMALS]': 2,
      'CURRENCY[MULTIPLIER]': 1,
      'CURRENCY[NEGATIVE_FORMAT]': 1,
      'CURRENCY[SYMBOL_POSITION]': 0,
      'CURRENCY[DECIMAL_SEPARATOR]': '.',
      'CURRENCY[THOUSAND_SEPARATOR]': ',',
      JOB_ID: hhJobNumber,
      CLIENT_ID: hhClientId || '',
      local: new Date().toISOString().replace('T', ' ').substring(0, 19),
      tz: 'Europe/London',
      no_webhook: 1,
    };

    console.log('[hh-deposit] Creating HH deposit for job', hhJobNumber, '£' + amount);
    const hhResult = await hhBroker.post('/php_functions/billing_deposit_save.php', depositParams, { priority: 'high' });

    if (!hhResult.success || !hhResult.data) {
      const reason = hhResult.error || 'HireHop returned no data';
      console.error('[hh-deposit] HH deposit creation failed:', reason, hhResult.data);
      return { hhDepositId: null, xeroSynced: false, error: reason };
    }

    const data = hhResult.data as any;
    const hhDepositId = data.hh_id || data.id || data.ID || null;
    if (!hhDepositId) {
      // HH said "success" but we couldn't extract a deposit ID. Surface this —
      // it's the silent-failure case that bit job 15624 historically.
      const reason = `HireHop accepted the deposit but returned no ID (response keys: ${Object.keys(data).join(', ') || 'none'})`;
      console.error('[hh-deposit]', reason);
      return { hhDepositId: null, xeroSynced: false, error: reason };
    }

    console.log('[hh-deposit] HH deposit created:', hhDepositId);

    // STEP 2: Trigger Xero sync. Failure here is non-fatal — the deposit
    // exists in HH and Xero will pick it up on the next nightly sync.
    let xeroSynced = false;
    try {
      const syncResult = await hhBroker.post('/php_functions/accounting/tasks.php', {
        hh_package_type: 1,
        hh_acc_package_id: 3,  // Xero
        hh_task: 'post_deposit',
        hh_id: hhDepositId,
        hh_acc_id: '',
      }, { priority: 'high' });
      xeroSynced = syncResult.success;
      console.log('[hh-deposit] Xero sync triggered:', xeroSynced ? 'success' : 'failed');
    } catch (syncError) {
      console.error('[hh-deposit] Xero sync trigger failed (non-fatal):', syncError);
    }

    return { hhDepositId, xeroSynced, error: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[hh-deposit] HH deposit write-back failed:', reason);
    return { hhDepositId: null, xeroSynced: false, error: reason };
  }
}
