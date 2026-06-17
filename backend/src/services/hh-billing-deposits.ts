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

/**
 * NET hire deposits currently held on a job — gross kind=6 deposits MINUS the
 * kind=3 refund applications booked against them. Used by the Combine-bookings
 * read-back to assert the absorbed job's deposits actually cleared after a move
 * (a refund is a separate kind=3 row, so getHireDeposits' gross figure would
 * still show the original deposit and false-positive).
 *
 * Mirrors money.ts's hire-deposit netting: a deposit refund is a kind=3 row with
 * OWNER_DEPOSIT set, OWNER=0 (not applied to an invoice), negative credit. Excess
 * deposits + their applications are excluded (handled by the excess flows).
 *
 * Throws on HH failure. Read with no cache (we're verifying a just-made change).
 */
export async function getNetHireDepositTotal(hhJobNumber: number): Promise<number> {
  const res = await hhBroker.get<any>(
    '/php_functions/billing_list.php',
    { main_id: hhJobNumber, type: 1 },
    { priority: 'high', cacheTTL: 0 },
  );
  if (!res.success || !res.data) {
    throw new Error(`Could not read HireHop billing for job ${hhJobNumber}: ${res.error || 'no data'}`);
  }
  const bl = res.data as any;
  const rows: any[] = Array.isArray(bl?.rows) ? bl.rows : [];

  // Pre-pass: which kind=6 deposits are excess (to exclude their kind=3 apps).
  const excessDepositIds = new Set<string>();
  for (const row of rows) {
    if (parseInt(row.kind ?? '0') !== 6) continue;
    const data = row.data || {};
    if (parseFloat(row.credit || data.credit || '0') <= 0) continue;
    if (isExcessText(String(data.DESCRIPTION || row.desc || '') + ' ' + String(data.MEMO || ''))) {
      const id = parseInt(data.ID || row.number || '0');
      if (id > 0) excessDepositIds.add(String(id));
    }
  }

  const seen = new Set<number>();
  let net = 0;
  for (const row of rows) {
    const kind = parseInt(row.kind ?? '0');
    const data = row.data || {};
    if (kind === 6) {
      const credit = parseFloat(row.credit || data.credit || '0');
      if (!isExcessText(String(data.DESCRIPTION || row.desc || '') + ' ' + String(data.MEMO || ''))) {
        net += credit; // signed (positive deposit in)
      }
    } else if (kind === 3) {
      const credit = parseFloat(row.credit || data.credit || '0');
      const absA = Math.abs(credit);
      if (absA <= 0) continue;
      const dedupId = parseInt(data.ID || '0');
      if (dedupId > 0) { if (seen.has(dedupId)) continue; seen.add(dedupId); }
      const ownerDepositId = data.OWNER_DEPOSIT;
      const appliedToInvoice = data.OWNER != null && parseInt(String(data.OWNER)) > 0;
      const isExcess = isExcessText(String(data.DESCRIPTION || row.desc || '') + ' ' + String(data.MEMO || ''));
      if (ownerDepositId) {
        const fromExcess = excessDepositIds.has(String(ownerDepositId));
        if (!fromExcess && credit < 0 && !appliedToInvoice) net -= absA; // deposit refund out
        // applied-to-invoice or excess apps: not a held hire deposit — ignore
      } else if (credit < 0 && !isExcess) {
        net -= absA; // standalone refund
      }
      // positive direct invoice payment without OWNER_DEPOSIT: not a held deposit
    }
  }
  return net;
}
