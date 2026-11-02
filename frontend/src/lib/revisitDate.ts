// Default revisit date for a paused enquiry.
//
// Pausing an enquiry clears its chase date, so it drops out of the Chasing pile
// entirely (see the Pipeline Chase Model in CLAUDE.md — "Chasing" is derived from
// next_chase_date, not a stored status). A revisit date puts it back: the card
// resurfaces on the day it's due.
//
// For "Under 4-day window" that revisit is predictable — we can't take the job
// while it's a short hire in a busy period, but it's worth another swing once the
// diary is clearer, a couple of weeks out. So we pre-fill it rather than making
// staff do the arithmetic. Every other pause reason is a judgement call, so those
// stay blank and opt-in.

/** How far before the hire starts a short-window enquiry comes back into Chasing. */
export const REVISIT_LEAD_DAYS_UNDER_MINIMUM = 14;

/** Local-time yyyy-mm-dd. Never toISOString() on a "today" — that's UTC and slips a day under BST. */
function todayLocalISO(): string {
  const n = new Date();
  const p = (v: number) => String(v).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

/**
 * `hireStart` minus `leadDays`, as yyyy-mm-dd.
 *
 * Returns '' when there's no usable hire start, or when the computed date is
 * already today or in the past — a revisit date that's already due would drop the
 * job straight back into Chasing the moment it was paused, which is the opposite
 * of what pausing is for. In that case staff pick a date themselves (or don't).
 *
 * Date-only arithmetic in UTC deliberately: the stored timestamps carry a time
 * (typically 09:00) and we only care about the calendar day, so anchoring to
 * UTC midnight keeps this stable regardless of BST.
 */
export function defaultRevisitDate(
  hireStart: string | null | undefined,
  leadDays: number = REVISIT_LEAD_DAYS_UNDER_MINIMUM,
): string {
  if (!hireStart) return '';
  const day = String(hireStart).slice(0, 10);
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return '';
  const anchor = new Date(Date.UTC(y, m - 1, d));
  if (isNaN(anchor.getTime())) return '';
  anchor.setUTCDate(anchor.getUTCDate() - leadDays);
  const result = anchor.toISOString().slice(0, 10);
  return result > todayLocalISO() ? result : '';
}
