/**
 * How far back the portal shows finished work (FREELANCER-PORTAL-SPEC §10,
 * jon, Oct 2026). One rule for every kind of work: deliveries and collections,
 * crew, studio nights and yard days alike. Until then each had its own (30
 * days, 14 days, the last 10) and the Completed page only knew about jobs, so a
 * sitter's nights vanished after a fortnight.
 *
 * By default this month and last, so the oldest month on screen is always a
 * whole one: someone writing last month's invoice sees all of it. "Show older"
 * on the Completed page goes to six months in all. Earnings (§5) is where
 * anything longer will live.
 *
 * The dashboard's Completed and Cancelled counts use the same start, so the
 * number on each row matches the list behind it.
 */

import { ukMonthStart } from '@/lib/ukDate'

/** The default: the 1st of last month. */
export function historyStart(): string {
  return ukMonthStart(1)
}

/** "Show older": six months in all, this one and the five before it. */
export function historyStartOlder(): string {
  return ukMonthStart(5)
}

/** A `?since=` value fit to pass on to OP, else undefined. OP clamps the range itself. */
export function readSince(value: string | null): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}
