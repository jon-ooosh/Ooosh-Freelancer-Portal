/**
 * "What's today?" in UK terms, for the freelancer portal. Mirrors OP's
 * services/uk-date.ts / frontend lib/ukDate.ts: never
 * `new Date().toISOString().slice(0, 10)`, which is the UTC date and between
 * 00:00 and 01:00 in British Summer Time is still yesterday.
 */

const UK_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
})

/** Today in the UK, as YYYY-MM-DD. */
export function ukToday(): string {
  const parts = UK_DAY.formatToParts(new Date())
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** A YYYY-MM-DD date as "Sun 26 Oct". Unparseable input comes back as-is. */
export function shortUkDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const date = new Date(Date.UTC(y, (m || 1) - 1, d || 1))
  if (Number.isNaN(date.getTime())) return ymd
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}
