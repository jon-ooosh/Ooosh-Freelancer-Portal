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

/** The UK date `days` after today (negative for before), as YYYY-MM-DD. */
export function ukDatePlus(days: number): string {
  const [y, m, d] = ukToday().split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** The hour of the day in the UK, 0-23. */
export function ukHour(): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' }).format(new Date()))
}

/** A YYYY-MM-DD date as "Sun 26 Oct". Unparseable input comes back as-is. */
export function shortUkDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const date = new Date(Date.UTC(y, (m || 1) - 1, d || 1))
  if (Number.isNaN(date.getTime())) return ymd
  // Built by hand: some browsers put a comma after the weekday ("Wed, 21 Oct").
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
}
