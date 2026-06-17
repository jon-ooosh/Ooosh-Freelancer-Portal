/**
 * Focused reader for a HireHop job's HIRE deposits (kind=6, positive, non-excess).
 *
 * Used by the Combine-bookings flow to enumerate the deposits sitting on the
 * absorbed job so each can be reversed there and recreated on the survivor,
 * preserving the original bank account.
 *
 * Deliberately self-contained rather than reusing money.ts's full billing
 * reader — we only need the hire deposit rows + their bank IDs, and money.ts's
 * classification logic is entangled with VAT/invoice reconciliation we don't
 * want here. The excess keyword regex mirrors money.ts's isExcessPayment().
 */

import { hhBroker } from './hirehop-broker';

export interface HireDeposit {
  id: number;            // HH deposit row ID
  amount: number;        // GBP, positive
  bankId: number;        // HH ACC_ACCOUNT_ID
  bankName: string | null;
  description: string;
  date: string;
}

// Mirror of money.ts isExcessPayment — keep in sync.
function isExcessText(text: string): boolean {
  return /\bexcess\b|\binsurance\b|\bxs\b|\btop[- ]?up\b/.test(text.toLowerCase());
}

export interface JobBillingFacts {
  hireDeposits: HireDeposit[];     // positive non-excess deposits
  hireDepositTotal: number;        // sum of hireDeposits
  hasInvoices: boolean;            // any kind=1 invoice raised
}

/**
 * Single billing read returning the facts the Combine-bookings flow needs:
 * the hire deposits to re-attribute, and whether any invoice has been raised
 * (an absorbed job with invoices is blocked from combining — see endpoint).
 *
 * Throws on HH failure so the caller can abort before touching anything (we
 * never want to half-move money). Deposit legs are the POSITIVE non-excess
 * rows only — a deposit and its later reversal are separate rows, so a job
 * already part-reattributed won't double-move.
 */
export async function getJobBillingFacts(hhJobNumber: number): Promise<JobBillingFacts> {
  const res = await hhBroker.get<any>(
    '/php_functions/billing_list.php',
    { main_id: hhJobNumber, type: 1 },
    { priority: 'high', cacheTTL: 0 },   // no cache — we're about to mutate
  );
  if (!res.success || !res.data) {
    throw new Error(`Could not read HireHop billing for job ${hhJobNumber}: ${res.error || 'no data'}`);
  }

  const bl = res.data as any;
  const banks: Array<{ ID: number; NAME: string }> = bl?.banks || bl?.rows?.[0]?.data?.banks || [];
  const bankName = (accId: number | null) =>
    (accId ? banks.find(b => b.ID === accId)?.NAME ?? null : null);

  const hireDeposits: HireDeposit[] = [];
  let hasInvoices = false;
  if (Array.isArray(bl?.rows)) {
    for (const row of bl.rows) {
      const kind = parseInt(row.kind ?? '0');
      const data = row.data || {};
      if (kind === 1) { hasInvoices = true; continue; }
      if (kind !== 6) continue;
      const credit = parseFloat(row.credit || data.credit || '0');
      if (credit <= 0) continue;  // positive deposits only (skip reversals/refunds)
      const description = String(data.DESCRIPTION || row.desc || '');
      const memo = String(data.MEMO || '');
      if (isExcessText(description + ' ' + memo)) continue;  // hire deposits only
      const id = parseInt(data.ID || row.number || String(row.id).replace('e', '') || '0');
      const bankId = parseInt(data.ACC_ACCOUNT_ID || '0');
      hireDeposits.push({
        id, amount: credit, bankId, bankName: bankName(bankId),
        description, date: data.DATE || row.date || '',
      });
    }
  }
  const hireDepositTotal = hireDeposits.reduce((s, d) => s + d.amount, 0);
  return { hireDeposits, hireDepositTotal, hasInvoices };
}

/** Convenience wrapper — just the hire deposits. */
export async function getHireDeposits(hhJobNumber: number): Promise<HireDeposit[]> {
  return (await getJobBillingFacts(hhJobNumber)).hireDeposits;
}
