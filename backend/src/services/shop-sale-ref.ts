/**
 * THE definition of how a shop sale is referred to: `OT-SHOP-00100`.
 *
 * SHOP-SALES-SPEC.md §2.10. Deliberately outside both existing sequences —
 * HireHop raises `OT-INV-#####` and Xero-direct raises `OT-#####` — so it can
 * never collide with either as they advance. A traceability reference carried
 * on the HireHop deposit memo (and, later, the receipt), NOT an accounting
 * invoice number.
 *
 * Its own file so the drain and the sales service can both use it without
 * importing each other.
 */
export function saleRef(saleNumber: number): string {
  return `OT-SHOP-${String(saleNumber).padStart(5, '0')}`;
}
