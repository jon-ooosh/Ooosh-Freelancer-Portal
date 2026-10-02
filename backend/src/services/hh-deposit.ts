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
import { syncSavedRowToXero, sendXeroSyncFailedAlert } from './hh-xero-sync';

// HireHop bank account IDs — shared by money.ts (deposit pushes), excess.ts
// (reimburse + refund payment applications), and any future hire-side refund
// flow. Sourced from HH's Bank Accounts settings; see CLAUDE.md "HireHop bank
// account IDs" table. Don't duplicate this mapping in callers.
export const HH_BANK_IDS: Record<string, number> = {
  stripe_gbp: 267, worldpay: 169, amex: 165, wise_bacs: 265,
  till_cash: 168, paypal: 173, lloyds_bank: 170, rolled_over: 265,
};

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
  // 'shop_sale' labels a till sale ("16750 - shop sale") — it used to go as
  // 'other', which is what reached HireHop and Xero and told nobody anything.
  paymentType: 'deposit' | 'balance' | 'excess' | 'refund' | 'excess_refund' | 'shop_sale' | 'other';
  notes?: string | null;
  // When set, this exact HireHop bank account ID is used instead of mapping from
  // paymentMethod. Used by the Combine-bookings reallocation so the recreated
  // deposit lands on the SAME bank as the original (clean Xero wash). Falls back
  // to getHHBankId(paymentMethod) when omitted.
  bankId?: number;
}

export interface PushDepositResult {
  hhDepositId: number | null;
  xeroSynced: boolean;
  /** Why Xero refused, when xeroSynced is false. Null when it succeeded. */
  xeroError: string | null;
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
        : paymentType === 'shop_sale'
          ? 'shop sale'
          : paymentType;
    const description = `${hhJobNumber} - ${typeLabel}`;
    const memo = `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} ${formattedDate} via ${methodLabel}${paymentReference ? ` (Ref: ${paymentReference})` : ''}${notes ? ` — ${notes}` : ''} (recorded via Ooosh OP)`;

    const hhBankId = opts.bankId ?? getHHBankId(paymentMethod);
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
      return { hhDepositId: null, xeroSynced: false, xeroError: null, error: reason };
    }

    const data = hhResult.data as any;
    const hhDepositId = data.hh_id || data.id || data.ID || null;
    if (!hhDepositId) {
      // HH said "success" but we couldn't extract a deposit ID. Surface this —
      // it's the silent-failure case that bit job 15624 historically.
      const reason = `HireHop accepted the deposit but returned no ID (response keys: ${Object.keys(data).join(', ') || 'none'})`;
      console.error('[hh-deposit]', reason);
      return { hhDepositId: null, xeroSynced: false, xeroError: null, error: reason };
    }

    console.log('[hh-deposit] HH deposit created:', hhDepositId);

    // STEP 2: Push to Xero. Non-fatal — the deposit exists in HH either way —
    // but `xeroError` now comes back with it so callers can say WHY rather than
    // just showing a false `xeroSynced` and moving on.
    //
    // `post_deposit` is the default here, not `post_payment`: a deposit is a new
    // document in Xero, not a payment against one. syncSavedRowToXero prefers
    // whatever HireHop names in the save response and only falls back to this.
    const sync = await syncSavedRowToXero(
      `deposit ${hhDepositId} on job ${hhJobNumber}`,
      { hh_task: 'post_deposit', ...(hhResult.data as Record<string, unknown>), hh_id: hhDepositId },
    );
    if (!sync.ok) {
      void sendXeroSyncFailedAlert({
        jobId: null, hhJobNumber, what: `${typeLabel} deposit`, amount,
        hhRowId: hhDepositId, moneyMoved: true, error: sync.error || 'Unknown error',
      });
    }

    return { hhDepositId, xeroSynced: sync.ok, xeroError: sync.error, error: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[hh-deposit] HH deposit write-back failed:', reason);
    return { hhDepositId: null, xeroSynced: false, xeroError: null, error: reason };
  }
}

export interface ReverseDepositOpts {
  hhJobNumber: number;            // HH job the deposit currently sits on
  hhDepositId: number;            // the original HH deposit ID to refund against
  amount: number;                 // GBP, positive
  bankId: number;                 // exact HH bank account the original used
  movedToHhJob: number;           // survivor HH job (for the memo)
  notes?: string | null;
}

/**
 * Re-attribute a deposit AWAY from a job — the "out" leg of a Combine-bookings
 * deposit move. The matching "in" leg is a normal pushDepositToHH on the
 * survivor with the same bankId. Net cash is zero; this just moves which
 * HireHop job (and Xero job tracking) the deposit is recognised against.
 *
 * Uses billing_payments_save.php — a refund payment application against the
 * specific deposit — NOT a negative deposit (HireHop rejects negative deposits,
 * and the rejected row never syncs to Xero). This is the exact mechanic the
 * excess-reimburse flow uses. Xero sync is post_payment (a payment application),
 * NOT post_deposit.
 *
 * Same bank, same day, paired with an equal positive deposit on the survivor —
 * an accountant sees a refund-out + receipt-in wash that nets to zero on the
 * bank. No client email fires (HH/Xero accounting only).
 */
export async function reverseDepositOnHH(opts: ReverseDepositOpts): Promise<PushDepositResult> {
  const { hhJobNumber, hhDepositId, amount, bankId, movedToHhJob, notes } = opts;
  console.log('[hh-deposit] Reattributing £' + amount, 'from HH job', hhJobNumber, '(deposit', hhDepositId + ') →', movedToHhJob);
  return refundDepositOnHH({
    hhJobNumber,
    hhDepositId,
    amount,
    bankId,
    description: `${hhJobNumber} - deposit reallocated to job ${movedToHhJob}`,
    memo: `Deposit reallocated to job #${movedToHhJob} (bookings combined)${notes ? ` — ${notes}` : ''} (via Ooosh OP)`,
    what: `deposit reattribution to job ${movedToHhJob}`,
  });
}

export interface RefundDepositOpts {
  hhJobNumber: number;            // HH job the deposit sits on
  hhDepositId: number;            // the original HH deposit ID to refund against
  amount: number;                 // GBP, positive
  bankId: number;                 // exact HH bank account the original used
  description: string;
  memo: string;
  /** For logs and the Xero-failure alert, e.g. "shop refund OT-SHOP-00101". */
  what: string;
}

/**
 * Take money back OUT of a deposit — a refund payment application against it.
 *
 * The general form of the combine-bookings "out" leg above, which is now a thin
 * wrapper round this. Also used by shop reversals (Window B,
 * SHOP-SALES-SPEC.md §8), where the deposit was a till sale and the customer is
 * getting their money back.
 *
 * `billing_payments_save.php` with `OWNER: 0, deposit: <id>` — NOT a negative
 * deposit (HireHop rejects those, and the rejected row never syncs to Xero).
 * Xero sync is post_payment, not post_deposit. HireHop answers error 370 when
 * the deposit has already been applied to an invoice; that is surfaced as the
 * error rather than worked round here.
 *
 * `hhDepositId` in the result is the PAYMENT-APPLICATION id HireHop created.
 */
export async function refundDepositOnHH(opts: RefundDepositOpts): Promise<PushDepositResult> {
  const { hhJobNumber, hhDepositId, amount, bankId, description, memo, what } = opts;

  try {
    const currentDate = new Date().toISOString().split('T')[0];

    const hhResult = await hhBroker.post('/php_functions/billing_payments_save.php', {
      id: 0,
      date: currentDate,
      desc: description,
      paid: Math.abs(amount),     // refund this much of the deposit
      memo,
      bank: bankId,
      OWNER: 0,
      deposit: hhDepositId,
      no_webhook: 1,
    }, { priority: 'high' });

    if (!hhResult.success || !hhResult.data) {
      const reason = hhResult.error || 'HireHop returned no data';
      console.error(`[hh-deposit] ${what} failed:`, reason, hhResult.data);
      return { hhDepositId: null, xeroSynced: false, xeroError: null, error: reason };
    }

    const data = hhResult.data as any;
    const paymentAppId = data.hh_id || data.id || data.ID || null;
    if (!paymentAppId) {
      const reason = `HireHop accepted the ${what} but returned no ID (response keys: ${Object.keys(data).join(', ') || 'none'})`;
      console.error('[hh-deposit]', reason);
      return { hhDepositId: null, xeroSynced: false, xeroError: null, error: reason };
    }

    // Xero sync — post_payment (a payment application, NOT post_deposit).
    const sync = await syncSavedRowToXero(
      `${what} against deposit ${hhDepositId} on job ${hhJobNumber}`,
      hhResult.data as Record<string, unknown>,
    );
    if (!sync.ok) {
      void sendXeroSyncFailedAlert({
        jobId: null, hhJobNumber, what,
        amount, hhRowId: paymentAppId, hhDepositId, error: sync.error || 'Unknown error',
      });
    }

    return { hhDepositId: paymentAppId, xeroSynced: sync.ok, xeroError: sync.error, error: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[hh-deposit] ${what} failed:`, reason);
    return { hhDepositId: null, xeroSynced: false, xeroError: null, error: reason };
  }
}

// Inverse of HH_BANK_IDS — pick a canonical OP method key for a given HH bank
// account ID, so a deposit read back from HH billing (which only carries the
// bank ID) can be recreated/labelled. Where several methods share a bank
// (wise_bacs/rolled_over → 265), the canonical "real payment" method wins.
export function getMethodForBankId(bankId: number): string {
  const map: Record<number, string> = {
    267: 'stripe_gbp', 169: 'worldpay', 165: 'amex', 265: 'wise_bacs',
    168: 'till_cash', 173: 'paypal', 170: 'lloyds_bank',
  };
  return map[bankId] || 'worldpay';
}
