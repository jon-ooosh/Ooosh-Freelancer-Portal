/**
 * "Add to Calendar" for a job: builds a standard .ics file and hands it to the
 * phone, which offers to add it to the calendar (it replaced an alert that said
 * "Calendar export coming soon!", Oct 2026). No server involved.
 *
 * Times are written as "floating" local times (no time zone), so 10:00 means
 * 10:00 on the freelancer's own phone, which for a UK job is UK time.
 */

export interface CalendarEvent {
  /** Stable id for the event, so adding it twice updates rather than duplicates. */
  uid: string
  title: string
  /** YYYY-MM-DD */
  date: string
  /** "HH:MM", or null for an all-day entry. */
  time?: string | null
  /** Length in hours for a timed entry (default 1). */
  durationHours?: number | null
  /** YYYY-MM-DD, inclusive: a multi-day job becomes an all-day span. */
  endDate?: string | null
  location?: string | null
  description?: string | null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Escape text for an .ics value (RFC 5545 §3.3.11). */
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/** Fold lines longer than 75 characters (RFC 5545 §3.1). */
function fold(line: string): string {
  if (line.length <= 75) return line
  const parts: string[] = []
  for (let i = 0; i < line.length; i += 74) parts.push((i === 0 ? '' : ' ') + line.slice(i, i + 74))
  return parts.join('\r\n')
}

function ymd(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
}

/** Parse YYYY-MM-DD as a UTC midnight Date, or null. */
function parseDay(v: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || '')
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return Number.isNaN(d.getTime()) ? null : d
}

/** The .ics text for one event, or null if the date is unusable. */
export function buildIcs(ev: CalendarEvent): string | null {
  const start = parseDay(ev.date)
  if (!start) return null
  const end = parseDay(ev.endDate)
  const time = /^(\d{1,2}):(\d{2})/.exec(ev.time || '')

  const dates: string[] = []
  if (end && end > start) {
    // Multi-day: an all-day span; DTEND is exclusive, so the day after the last.
    const after = new Date(end.getTime() + 86400000)
    dates.push(`DTSTART;VALUE=DATE:${ymd(start)}`, `DTEND;VALUE=DATE:${ymd(after)}`)
  } else if (time) {
    const h = Number(time[1])
    const min = Number(time[2])
    const startAt = new Date(start.getTime() + (h * 60 + min) * 60000)
    const hours = ev.durationHours && ev.durationHours > 0 ? ev.durationHours : 1
    const endAt = new Date(startAt.getTime() + hours * 3600000)
    const local = (d: Date) => `${ymd(d)}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`
    dates.push(`DTSTART:${local(startAt)}`, `DTEND:${local(endAt)}`)
  } else {
    const after = new Date(start.getTime() + 86400000)
    dates.push(`DTSTART;VALUE=DATE:${ymd(start)}`, `DTEND;VALUE=DATE:${ymd(after)}`)
  }

  const now = new Date()
  const stamp = `${ymd(now)}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ooosh Tours//Freelancer Portal//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${esc(ev.uid)}@freelancer.oooshtours.co.uk`,
    `DTSTAMP:${stamp}`,
    ...dates,
    `SUMMARY:${esc(ev.title)}`,
    ...(ev.location ? [`LOCATION:${esc(ev.location)}`] : []),
    ...(ev.description ? [`DESCRIPTION:${esc(ev.description)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.map(fold).join('\r\n') + '\r\n'
}

/** Download the event as an .ics file. Returns false if the date was unusable. */
export function downloadIcs(ev: CalendarEvent, filename = 'ooosh-job.ics'): boolean {
  const text = buildIcs(ev)
  if (!text) return false
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return true
}
