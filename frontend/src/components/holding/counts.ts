/**
 * Held-item count vocabulary — ONE source of truth for how box counts read.
 *
 * Three words, used identically on every surface:
 *   Expected    = box_count      (what the client said they'd send)
 *   Here        = received_count (what actually turned up)
 *   Outstanding = expected − here
 *
 * The `description` says WHAT the thing is, never HOW MANY — baking the count
 * into the description froze it at declaration time ("5 box(es) of merch"),
 * so correcting the counts changed nothing anyone could see. Render counts
 * from the columns, here, everywhere.
 *
 * The backend mirrors this wording in services/holding-requirement-sync.ts
 * (the merch pip notes) — the backend can't import shared/ at runtime, so the
 * two are mirrored by hand. Keep them in step.
 */
import type { HeldItem } from '../../../../shared/types';

export type HeldCountTone = 'none' | 'partial' | 'complete';

export interface HeldCountSummary {
  expected: number | null;
  here: number | null;
  outstanding: number;   // 0 when nothing is outstanding / unknowable
  text: string;          // e.g. "3 of 5 here · 2 outstanding"
  short: string;         // e.g. "3/5" — for tight table cells
  tone: HeldCountTone;
}

const TONE_CLASS: Record<HeldCountTone, string> = {
  none: 'text-slate-500',
  partial: 'text-amber-700',
  complete: 'text-green-700',
};

export const heldCountClass = (tone: HeldCountTone) => TONE_CLASS[tone];

/**
 * Null when the item has no declared quantity at all (most lost property), so
 * callers can simply skip rendering.
 */
export function describeHeldCounts(item: Pick<HeldItem, 'box_count' | 'received_count'>): HeldCountSummary | null {
  const expected = item.box_count ?? null;
  const here = item.received_count ?? null;
  if (expected == null && here == null) return null;

  // Expected but nothing booked in yet.
  if (here == null) {
    return {
      expected, here: null, outstanding: expected ?? 0,
      text: `${expected} expected`, short: `0/${expected}`, tone: 'none',
    };
  }
  // Arrived with no declared total — count is simply what's here.
  if (expected == null) {
    return { expected: null, here, outstanding: 0, text: `${here} here`, short: String(here), tone: 'complete' };
  }

  const outstanding = Math.max(0, expected - here);
  const tone: HeldCountTone = outstanding > 0 ? 'partial' : 'complete';
  return {
    expected, here, outstanding,
    text: outstanding > 0 ? `${here} of ${expected} here · ${outstanding} outstanding` : `${here} of ${expected} here`,
    short: `${here}/${expected}`,
    tone,
  };
}

/** True when some (but not all) of a declared delivery has turned up. */
export function isPartiallyArrived(item: Pick<HeldItem, 'box_count' | 'received_count'>): boolean {
  const s = describeHeldCounts(item);
  return !!s && s.here != null && s.here > 0 && s.outstanding > 0;
}
