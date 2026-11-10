/**
 * Business figures — the pure maths (docs/BUSINESS-FIGURES-SPEC.md, step 2).
 * No database here: the loader (business-figures.ts) builds one EnquiryRow per
 * enquiry and these functions count, time and group them.
 */

/** What became of an enquiry. 'cancelled' booked and was then called off — it counts as booked. */
export type Outcome = 'booked' | 'cancelled' | 'lost' | 'not_followed_up' | 'open';

export interface EnquiryRow {
  jobId: string;
  /** UK month the enquiry arrived, 'YYYY-MM'. */
  month: string;
  outcome: Outcome;
  lostReason: string | null;
  channel: string | null;                 // jobs.enquiry_source
  likelihood: string | null;              // hot / warm / cold / null
  value: number | null;                   // jobs.job_value, inc VAT
  services: string[];                     // 'vans' | 'backline' | 'rehearsals'
  owner: string | null;                   // who took it (the job's Ooosh manager, else who created it)
  /** Office minutes from first contact to our first email to the client; null when none was seen. */
  replyMinutes: number | null;
  replyBy: string | null;                 // who sent that first email
  /** Office minutes from first contact to the first quote PDF sent; null when none was found. */
  quoteMinutes: number | null;
}

// ── Office time ─────────────────────────────────────────────────────────────

/** Office hours, UK time, every day (the same as scripts/email-response-times.ts). */
export const OFFICE_OPEN_MIN = 9 * 60;
export const OFFICE_CLOSE_MIN = 18 * 60;
/** One office day in minutes — the "over a day" line. */
export const OFFICE_DAY_MIN = OFFICE_CLOSE_MIN - OFFICE_OPEN_MIN;

const LONDON = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** The London wall-clock reading of an instant, as if it were UTC (for offset maths). */
function londonWallAsUtc(ms: number): number {
  const p = Object.fromEntries(LONDON.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}

/** The instant a London wall-clock time happens: `date` 'YYYY-MM-DD' at `minutes` past midnight. */
export function londonToUtcMs(date: string, minutes: number): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  return guess - (londonWallAsUtc(guess) - guess);
}

/** The London calendar date of an instant, 'YYYY-MM-DD'. */
export function londonDate(ms: number): string {
  return new Date(londonWallAsUtc(ms)).toISOString().slice(0, 10);
}

const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Minutes between two instants that fall inside office hours. An email at 22:00
 * answered at 09:30 the next morning waited 30 office minutes.
 */
export function officeMinutesBetween(fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return 0;
  let total = 0;
  let day = londonDate(fromMs);
  const last = londonDate(toMs);
  for (let i = 0; i < 800 && day <= last; i++, day = nextDay(day)) {
    const open = londonToUtcMs(day, OFFICE_OPEN_MIN);
    const close = londonToUtcMs(day, OFFICE_CLOSE_MIN);
    const a = Math.max(open, fromMs);
    const b = Math.min(close, toMs);
    if (b > a) total += (b - a) / 60_000;
  }
  return Math.round(total);
}

// ── Grouping ────────────────────────────────────────────────────────────────

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Job value bands (inc VAT) — jon, Nov 2026. */
export function valueBand(v: number | null): string {
  if (v === null || !(v > 0)) return 'No value yet';
  if (v < 500) return 'Under £500';
  if (v < 2000) return '£500–£2k';
  if (v < 5000) return '£2k–£5k';
  return '£5k+';
}
export const VALUE_BAND_ORDER = ['Under £500', '£500–£2k', '£2k–£5k', '£5k+', 'No value yet'];

/** How fast we first emailed back, in office time. */
export function replyBucket(mins: number | null): string | null {
  if (mins === null) return null;
  if (mins < 60) return 'Under 1 hour';
  if (mins < 240) return '1–4 hours';
  if (mins < OFFICE_DAY_MIN) return '4 hours – 1 day';
  return 'Over 1 day';
}
export const REPLY_BUCKET_ORDER = ['Under 1 hour', '1–4 hours', '4 hours – 1 day', 'Over 1 day'];

export interface Tally {
  key: string;
  enquiries: number;
  booked: number;              // booked, including booked-then-cancelled
  cancelled: number;           // of those, called off later
  lost: number;
  notFollowedUp: number;
  open: number;
  /** booked ÷ (booked + lost + not followed up); null until something is decided. */
  rate: number | null;
  bookedValue: number;
  medianReplyMins: number | null;
  replies: number;
  medianQuoteMins: number | null;
  quotes: number;
}

export function tally(key: string, rows: EnquiryRow[]): Tally {
  let booked = 0, cancelled = 0, lost = 0, nfu = 0, open = 0, bookedValue = 0;
  const replies: number[] = [];
  const quotes: number[] = [];
  for (const r of rows) {
    if (r.outcome === 'booked' || r.outcome === 'cancelled') {
      booked++;
      if (r.outcome === 'cancelled') cancelled++;
      else if (r.value && r.value > 0) bookedValue += r.value;
    } else if (r.outcome === 'lost') lost++;
    else if (r.outcome === 'not_followed_up') nfu++;
    else open++;
    if (r.replyMinutes !== null) replies.push(r.replyMinutes);
    if (r.quoteMinutes !== null) quotes.push(r.quoteMinutes);
  }
  const decided = booked + lost + nfu;
  return {
    key, enquiries: rows.length, booked, cancelled, lost, notFollowedUp: nfu, open,
    rate: decided > 0 ? Math.round((booked / decided) * 1000) / 1000 : null,
    bookedValue: Math.round(bookedValue * 100) / 100,
    medianReplyMins: median(replies), replies: replies.length,
    medianQuoteMins: median(quotes), quotes: quotes.length,
  };
}

/** Tally rows by a key (a row can sit under several keys, e.g. a van + backline hire). */
export function groupBy(rows: EnquiryRow[], keysOf: (r: EnquiryRow) => string[], order?: string[]): Tally[] {
  const buckets = new Map<string, EnquiryRow[]>();
  for (const r of rows) {
    for (const k of keysOf(r)) {
      const list = buckets.get(k) ?? [];
      list.push(r);
      buckets.set(k, list);
    }
  }
  const out = [...buckets.entries()].map(([k, list]) => tally(k, list));
  if (order) return out.sort((a, b) => (order.indexOf(a.key) + 1 || 999) - (order.indexOf(b.key) + 1 || 999));
  return out.sort((a, b) => b.enquiries - a.enquiries);
}

export interface FiguresSummary {
  total: Tally;
  byMonth: Tally[];
  byChannel: Tally[];
  byLikelihood: Tally[];
  byValue: Tally[];
  byService: Tally[];
  byOwner: Tally[];
  byReplier: Tally[];
  byReplySpeed: Tally[];
  lostReasons: Array<{ reason: string; count: number }>;
}

export function summarise(rows: EnquiryRow[]): FiguresSummary {
  const lostReasons = new Map<string, number>();
  for (const r of rows) {
    if (r.outcome !== 'lost') continue;
    const k = r.lostReason || 'No reason given';
    lostReasons.set(k, (lostReasons.get(k) || 0) + 1);
  }
  return {
    total: tally('All', rows),
    byMonth: groupBy(rows, (r) => [r.month]).sort((a, b) => a.key.localeCompare(b.key)),
    byChannel: groupBy(rows, (r) => [r.channel || 'unknown']),
    byLikelihood: groupBy(rows, (r) => [r.likelihood || 'unset'], ['hot', 'warm', 'cold', 'unset']),
    byValue: groupBy(rows, (r) => [valueBand(r.value)], VALUE_BAND_ORDER),
    byService: groupBy(rows, (r) => (r.services.length ? r.services : ['other']), ['vans', 'backline', 'rehearsals', 'other']),
    byOwner: groupBy(rows, (r) => [r.owner || 'Not recorded']),
    byReplier: groupBy(rows.filter((r) => r.replyBy), (r) => [r.replyBy as string]),
    byReplySpeed: groupBy(rows.filter((r) => r.replyMinutes !== null), (r) => [replyBucket(r.replyMinutes) as string], REPLY_BUCKET_ORDER),
    lostReasons: [...lostReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}
