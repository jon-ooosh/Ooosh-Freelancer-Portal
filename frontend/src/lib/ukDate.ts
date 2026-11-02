/**
 * "What's the date?" in UK terms — THE frontend definition (backend twin:
 * services/uk-date.ts).
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date, which between 00:00
 * and 01:00 in British Summer Time is still YESTERDAY — so a date picker
 * defaulted to "today" after midnight pre-filled the wrong day. Pinned to
 * Europe/London so a laptop on another timezone (a show abroad) still files
 * things on the UK day.
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
