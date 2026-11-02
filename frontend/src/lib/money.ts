/**
 * Money comparison tolerance — the single definition of "close enough to zero".
 *
 * WHY THIS EXISTS (the £0.00-in-red bug, Sep 2026):
 * HireHop gives us the job's ex-VAT accrued value and we derive VAT ourselves
 * (`hireValueExVat * 0.20` in routes/money.ts). On a job whose ex-VAT value
 * isn't a clean multiple of 5p that lands a sub-penny residue:
 *
 *     530.41 ex VAT  ->  VAT 106.082  ->  inc VAT 636.492
 *     client pays the invoiced 636.49
 *     balance = 0.002
 *
 * `toFixed(2)` then renders "£0.00" while every `> 0` test still fires. That
 * single residue produced THREE wrong things on one screen: a red
 * "Balance Outstanding: £0.00", a green "Deposit secured. Remaining balance:
 * £0.00" banner that should not have rendered at all, and a "Deposit secured"
 * pill sitting next to "100% paid" (because deposit_percent was 99.9997).
 *
 * The residue is real arithmetic, not float noise — HireHop invoices the
 * rounded figure while we carry the unrounded one — so rounding alone would not
 * be reliable across every shape of job. Compare with a tolerance instead.
 *
 * CONVENTION: never test a money figure against 0 directly. Any new surface
 * asking "is this settled / is anything outstanding / is this paid in full"
 * MUST go through these helpers, so the answer can't differ between two
 * components looking at the same number.
 */

/** Half a penny. Anything smaller than this is not money. */
export const MONEY_EPSILON = 0.005;

/** True when an outstanding balance is effectively zero (or negative). */
export function isSettled(amount: number | null | undefined): boolean {
  return !(Number(amount) > MONEY_EPSILON);
}

/** True when there is a real amount still outstanding. Inverse of isSettled. */
export function hasOutstanding(amount: number | null | undefined): boolean {
  return Number(amount) > MONEY_EPSILON;
}

/** True when a figure is a real, non-zero amount worth displaying. */
export function isNonZero(amount: number | null | undefined): boolean {
  return Math.abs(Number(amount) || 0) > MONEY_EPSILON;
}

/**
 * A cancellation fee inc VAT: one line at 20%, rounded per line as HireHop rounds it.
 * Mirrors the backend's `cancellationFeeGross()` (services/cancellation-close.ts), which
 * raises the fee invoice — the modal's estimate and the invoice must come to the same penny.
 */
export function cancellationFeeGross(feeExVat: number): number {
  const net = Math.round((Number(feeExVat) || 0) * 100) / 100;
  return Math.round((net + Math.round(net * 20) / 100) * 100) / 100;
}

/**
 * Where a cancelled job's money stands: what it is charged (the fee inc VAT, or the fee
 * invoice once raised) against what the client has paid towards the hire. One answer for
 * the cancellation modal (before) and the Money tab (after) — CANCELLATION-SPEC.md.
 */
export function cancellationBalance(chargeIncVat: number, hirePaid: number): { refundDue: number; feeOwing: number; square: boolean } {
  const diff = Math.round(((Number(hirePaid) || 0) - (Number(chargeIncVat) || 0)) * 100) / 100;
  return {
    refundDue: diff > MONEY_EPSILON ? diff : 0,
    feeOwing: diff < -MONEY_EPSILON ? -diff : 0,
    square: Math.abs(diff) <= MONEY_EPSILON,
  };
}
