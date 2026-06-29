import { RackStackItem } from './types';

export interface StackCell { item: RackStackItem; index: number }
export interface StackRow { heightU: number; cells: StackCell[] }

/**
 * Pack a flat ordered U-stack into rows. Two *consecutive* half-width items
 * share one U-band (left + right); everything else is its own row. This is the
 * single source of truth for both rendering and capacity (used-U) maths.
 */
export function packStackRows(items: RackStackItem[]): StackRow[] {
  const rows: StackRow[] = [];
  let i = 0;
  while (i < items.length) {
    const a = items[i];
    const ah = Math.max(1, a.rackheight || 1);
    if (a.half_width && i + 1 < items.length && items[i + 1].half_width) {
      const b = items[i + 1];
      rows.push({ heightU: Math.max(ah, Math.max(1, b.rackheight || 1)), cells: [{ item: a, index: i }, { item: b, index: i + 1 }] });
      i += 2;
    } else {
      rows.push({ heightU: ah, cells: [{ item: a, index: i }] });
      i += 1;
    }
  }
  return rows;
}

export function computeUsedU(items: RackStackItem[]): number {
  return packStackRows(items).reduce((s, r) => s + r.heightU, 0);
}
