/**
 * "What's the date?" — THE definition, in UK terms.
 *
 * The server runs in UTC (Hetzner). `new Date().toISOString().slice(0, 10)` is
 * therefore the UTC date, which between 00:00 and 01:00 in British Summer Time
 * is still YESTERDAY — a late-night check-in, payment or deposit stamped with
 * the wrong day. Every "today" in OP means the UK day staff are living in, so
 * it comes from here (date audit, Oct 2026 — TOUR-FINDER-SPEC §20).
 *
 * NB this is about "now". DATE columns read from Postgres are a separate case:
 * node-postgres turns them into midnight in the SERVER's zone, which on a UTC
 * server round-trips through toISOString() correctly. Don't set TZ on the
 * server without auditing those (services/leads/dates.ts has the safe form).
 */

const UK_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** The UK calendar date of an instant, as YYYY-MM-DD. */
export function ukDateOf(d: Date): string {
  const parts = UK_DAY.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Today in the UK, as YYYY-MM-DD. */
export function ukToday(): string {
  return ukDateOf(new Date());
}

/** The UK date `days` after today (negative for before), as YYYY-MM-DD. */
export function ukDatePlus(days: number): string {
  const [y, m, d] = ukToday().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
