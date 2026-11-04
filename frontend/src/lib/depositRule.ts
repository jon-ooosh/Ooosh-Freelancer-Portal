/**
 * THE deposit rule — mirror of `backend/src/services/deposit-rule.ts`: 25% of
 * the hire (inc VAT) with a £100 floor; the full amount under £400. Change
 * both (and the payment portal's copy) together.
 */
export function requiredDeposit(hireValueIncVat: number): number {
  if (hireValueIncVat < 400) return hireValueIncVat;
  return Math.max(hireValueIncVat * 0.25, 100);
}
