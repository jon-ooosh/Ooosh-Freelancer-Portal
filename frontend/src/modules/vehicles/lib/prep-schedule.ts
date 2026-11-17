/**
 * Periodic prep checks — THE rule for "is this check due on this van?"
 *
 * Most prep items are asked every prep. A periodic one (Premium wifi settings,
 * lubing the deadlocks, peeling off last year's toll stickers) is asked only
 * when it falls due, judged per van from the last prep that answered it
 * (`GET /get-periodic-checks`, kept by save-prep). Any answer counts as done,
 * "Problem" included — the problem goes to the Problems register as usual and
 * the clock restarts (jon, Nov 2026).
 *
 * Two kinds:
 *   - interval: every N weeks / months since it was last done on this van.
 *     Never done on this van = due now.
 *   - yearly:   once per calendar year, from a date (toll stickers: 1 Jan).
 *     Due once that date has passed and it hasn't been done since. A yearly
 *     check added in November first falls due on the NEXT date (`addedOn`),
 *     so nobody peels this year's stickers off in November.
 *
 * Dates are UK calendar days as `YYYY-MM-DD` (lib/ukDate.ts). Pure — no I/O.
 */

export type PrepSchedule =
  | { kind: 'interval'; every: number; unit: 'weeks' | 'months' }
  | { kind: 'yearly'; month: number; day: number; addedOn?: string }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number)
  return [y!, m!, d!]
}

function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** A valid `YYYY-MM-DD`? Anything else is treated as "never done". */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = parts(v)
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)
}

/** A schedule that can actually be used (a stored one may be half-filled). */
export function isValidSchedule(s: unknown): s is PrepSchedule {
  if (!s || typeof s !== 'object') return false
  const x = s as Record<string, unknown>
  if (x.kind === 'interval') {
    return Number.isInteger(x.every) && (x.every as number) >= 1 && (x.unit === 'weeks' || x.unit === 'months')
  }
  if (x.kind === 'yearly') {
    return Number.isInteger(x.month) && (x.month as number) >= 1 && (x.month as number) <= 12
      && Number.isInteger(x.day) && (x.day as number) >= 1 && (x.day as number) <= 31
  }
  return false
}

/** `date` plus the interval. Month steps keep the day, clamped (31 Jan + 1 month = 28/29 Feb). */
function addInterval(date: string, every: number, unit: 'weeks' | 'months'): string {
  const [y, m, d] = parts(date)
  if (unit === 'weeks') {
    return new Date(Date.UTC(y, m - 1, d + every * 7)).toISOString().slice(0, 10)
  }
  const total = (m - 1) + every
  const ny = y + Math.floor(total / 12)
  const nm = (total % 12) + 1
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)))
}

/** The yearly date in year `y` (29 Feb falls back to 28 Feb in other years). */
function anchorIn(y: number, month: number, day: number): string {
  return fmt(y, month, Math.min(day, daysInMonth(y, month)))
}

/** The most recent yearly date on or before `today`. */
function lastAnchor(month: number, day: number, today: string): string {
  const [y] = parts(today)
  const thisYear = anchorIn(y, month, day)
  return thisYear <= today ? thisYear : anchorIn(y - 1, month, day)
}

/**
 * When the check is next due on this van. `null` = due now.
 * `lastDone` is the van's last answer date, or null if never done here.
 */
export function nextDue(schedule: PrepSchedule, lastDone: string | null, today: string): string | null {
  const done = isIsoDate(lastDone) ? lastDone : null
  if (schedule.kind === 'interval') {
    if (!done) return null
    const next = addInterval(done, schedule.every, schedule.unit)
    return next <= today ? null : next
  }
  const anchor = lastAnchor(schedule.month, schedule.day, today)
  const doneThisYear = done !== null && done >= anchor
  // Added after this year's date: it isn't owed until the next one.
  const addedAfter = done === null && isIsoDate(schedule.addedOn) && schedule.addedOn > anchor
  if (!doneThisYear && !addedAfter) return null
  const [y] = parts(anchor)
  return anchorIn(y + 1, schedule.month, schedule.day)
}

export function isDue(schedule: PrepSchedule, lastDone: string | null, today: string): boolean {
  return nextDue(schedule, lastDone, today) === null
}

/** "12 Aug 2026" */
export function formatDay(date: string): string {
  if (!isIsoDate(date)) return date
  const [y, m, d] = parts(date)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/** "Every 3 months" / "Once a year, from 1 Jan" */
export function scheduleLabel(schedule: PrepSchedule): string {
  if (schedule.kind === 'interval') {
    const unit = schedule.every === 1 ? schedule.unit.replace(/s$/, '') : schedule.unit
    return schedule.every === 1 ? `Every ${unit}` : `Every ${schedule.every} ${unit}`
  }
  return `Once a year, from ${schedule.day} ${MONTHS[schedule.month - 1]}`
}

/** The line shown under a periodic item on the prep form. */
export function scheduleStatus(schedule: PrepSchedule, lastDone: string | null, today: string): string {
  const next = nextDue(schedule, lastDone, today)
  const done = isIsoDate(lastDone) ? `last done ${formatDay(lastDone)}` : 'not done on this van yet'
  return next === null
    ? `${scheduleLabel(schedule)} · due now · ${done}`
    : `${scheduleLabel(schedule)} · ${done} · next due ${formatDay(next)}`
}
