/**
 * THE deposit rule (jon, 4 Nov 2026 — docs/CASHFLOW-FORECAST-SPEC.md §1.15):
 * 25% of the hire (inc VAT) with a £100 floor; the full amount when the hire
 * is under £400. (25% of £400 is £100, so the floor only matters to anything
 * calling this with a figure under £400, which takes the full amount anyway.)
 *
 * Used by the Money tab summary, the Wise matcher and the cash forecast. The
 * frontend mirror is `frontend/src/lib/depositRule.ts` (Money tab quick
 * amounts) and the payment portal has its own copy (netlify-functions) —
 * change all three together.
 */
export function requiredDeposit(hireValueIncVat: number): number {
  if (hireValueIncVat < 400) return hireValueIncVat;
  return Math.max(hireValueIncVat * 0.25, 100);
}
