/**
 * Personal read-only calendar feed — THE definition of what leaves the
 * building in it (staff calendar spec §10, built Oct 2026).
 *
 * A person subscribes their phone's calendar to a secret URL and sees their
 * OWN time: approved and requested time off, home days, and company days.
 * jon's decisions, Oct 2026:
 *   * nobody else's time — not a colleague's leave, not the team's in/out.
 *     A calendar app shares and syncs well beyond this platform; anything
 *     wider is looked up in OP, behind a login;
 *   * no overtime — it is not a day anyone is "off". A day off TAKEN from
 *     banked overtime is time off (TOIL) and does appear;
 *   * no absence — sickness is recorded FOR somebody, and its type is
 *     special-category data. A sick day simply does not show as a home day.
 *
 * The token is the credential: a calendar app cannot log in. It is long and
 * random, and resetting it kills the old URL at once.
 */

import crypto from 'crypto';
import { query } from '../config/database';
import { addDaysYmd } from './staff-day-status';

/** How far the feed reaches. Calendar apps hold what they were last sent. */
const MONTHS_BACK = 3;
const MONTHS_AHEAD = 12;

const LEAVE_LABEL: Record<string, string> = {
  holiday: 'Holiday', toil: 'Time off (TOIL)', unpaid: 'Unpaid leave',
};
const PORTION_LABEL: Record<string, string> = { am: 'morning', pm: 'afternoon' };

// ── Tokens ──────────────────────────────────────────────────────────────────

function newToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** The person's feed token, made on first ask. */
export async function getOrCreateFeedToken(personId: string): Promise<string> {
  const existing = await query('SELECT token FROM staff_calendar_feeds WHERE person_id = $1', [personId]);
  if (existing.rows[0]) return existing.rows[0].token as string;
  const r = await query(
    `INSERT INTO staff_calendar_feeds (person_id, token) VALUES ($1, $2)
     ON CONFLICT (person_id) DO UPDATE SET person_id = EXCLUDED.person_id
     RETURNING token`,
    [personId, newToken()]);
  return r.rows[0].token as string;
}

/** A new token — every app subscribed to the old URL stops getting updates. */
export async function resetFeedToken(personId: string): Promise<string> {
  const token = newToken();
  await query(
    `INSERT INTO staff_calendar_feeds (person_id, token) VALUES ($1, $2)
     ON CONFLICT (person_id) DO UPDATE SET token = EXCLUDED.token, created_at = NOW(), last_fetched_at = NULL`,
    [personId, token]);
  return token;
}

/**
 * Whose feed a token opens — or null. Only somebody still employed: a feed
 * outliving the job would keep publishing a leaver's company days.
 */
export async function resolveFeedToken(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const r = await query(
    `SELECT f.person_id
       FROM staff_calendar_feeds f
       JOIN staff_employment se ON se.person_id = f.person_id AND se.employment_status = 'employed'
      WHERE f.token = $1`,
    [token]);
  const personId = (r.rows[0]?.person_id as string | undefined) ?? null;
  if (personId) {
    await query('UPDATE staff_calendar_feeds SET last_fetched_at = NOW() WHERE person_id = $1', [personId]);
  }
  return personId;
}

// ── The feed ────────────────────────────────────────────────────────────────

interface FeedEvent {
  uid: string;
  summary: string;
  description?: string;
  /** All-day: start date and the date AFTER the last day (iCal's DTEND is exclusive). */
  allDay?: { start: string; endExclusive: string };
  /** Timed, in floating local time — everybody here is on UK time. */
  timed?: { date: string; start: string; end: string };
  /** Free rather than busy — a home day is still a working day. */
  transparent?: boolean;
}

function todayLondon(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

function addMonths(date: string, n: number): string {
  const [y, m] = date.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}

/** Runs of consecutive dates sharing a label, as [first, last] pairs. */
function runs(dates: { date: string; label: string }[]): { label: string; first: string; last: string }[] {
  const out: { label: string; first: string; last: string }[] = [];
  for (const d of [...dates].sort((a, b) => a.date.localeCompare(b.date))) {
    const prev = out[out.length - 1];
    if (prev && prev.label === d.label && addDaysYmd(prev.last, 1) === d.date) prev.last = d.date;
    else out.push({ label: d.label, first: d.date, last: d.date });
  }
  return out;
}

export async function buildFeedEvents(personId: string): Promise<FeedEvent[]> {
  const today = todayLondon();
  const from = addMonths(today, -MONTHS_BACK);
  const to = addDaysYmd(addMonths(today, MONTHS_AHEAD + 1), -1);
  const events: FeedEvent[] = [];

  // Time off — the person's own requests, approved or waiting.
  const { listRequests } = await import('./staff-leave');
  const requests = (await listRequests({ personId, from, to, limit: 500 }))
    .filter(r => r.status === 'approved' || r.status === 'pending');
  for (const r of requests) {
    const waiting = r.status === 'pending';
    const base = LEAVE_LABEL[r.leaveType] ?? 'Time off';
    const summaryFor = (extra?: string) =>
      `${waiting ? 'Requested: ' : ''}${base}${extra ? ` (${extra})` : ''}`;
    const description = waiting ? 'Waiting for approval' : undefined;
    const days = [...r.days].sort((a, b) => a.date.localeCompare(b.date));
    if (days.length === 0) continue;

    // The common case — whole days — is one event across the lot, the way
    // anybody would write "on holiday" in their own diary.
    if (days.every(d => d.portion === 'full')) {
      events.push({
        uid: `leave-${r.id}`, summary: summaryFor(), description,
        allDay: { start: days[0].date, endExclusive: addDaysYmd(days[days.length - 1].date, 1) },
      });
      continue;
    }
    for (const d of days) {
      if (d.portion === 'hours' && d.startTime && d.endTime) {
        events.push({
          uid: `leave-${r.id}-${d.date}`, summary: summaryFor(), description,
          timed: { date: d.date, start: d.startTime.slice(0, 5), end: d.endTime.slice(0, 5) },
        });
      } else {
        events.push({
          uid: `leave-${r.id}-${d.date}`, summary: summaryFor(PORTION_LABEL[d.portion]), description,
          allDay: { start: d.date, endExclusive: addDaysYmd(d.date, 1) },
        });
      }
    }
  }

  // Home days — from the calendar, so a regular pattern day and an approved
  // one-off land the same way and a day off sick or on leave drops out.
  const { getStaffCalendar } = await import('./staff-day-status');
  const [cal] = await getStaffCalendar(from, to, { isAdmin: false, personId });
  const homeDays: { date: string; label: string }[] = [];
  for (const d of cal?.days ?? []) {
    if (d.location === 'home') homeDays.push({ date: d.date, label: 'Working from home' });
    else if (d.homePending) homeDays.push({ date: d.date, label: 'Requested: working from home' });
  }
  for (const run of runs(homeDays)) {
    events.push({
      uid: `home-${run.label.startsWith('Requested') ? 'asked-' : ''}${run.first}`,
      summary: run.label, transparent: true,
      description: run.label.startsWith('Requested') ? 'Waiting for approval' : undefined,
      allDay: { start: run.first, endExclusive: addDaysYmd(run.last, 1) },
    });
  }

  // Company days — the office is shut for everybody.
  const { getCompanyDayOverlay } = await import('./staff-company-days');
  for (const [date, occ] of await getCompanyDayOverlay(from, to)) {
    events.push({
      uid: `company-${date}`, summary: `Office closed — ${occ.label}`,
      allDay: { start: date, endExclusive: addDaysYmd(date, 1) },
    });
  }

  return events;
}

// ── iCalendar text (RFC 5545) ───────────────────────────────────────────────

function esc(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Lines over 75 octets are folded: CRLF then a single space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (size + n > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += n;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const ymd = (date: string) => date.replace(/-/g, '');

export function renderIcs(events: FeedEvent[], calendarName: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const host = 'staff.oooshtours.co.uk';
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ooosh Tours//Staff time//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(calendarName)}`,
    'X-WR-TIMEZONE:Europe/London',
    // A hint, honoured by Apple and Outlook. Google polls on its own clock
    // (often several hours) and ignores both.
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@${host}`, `DTSTAMP:${stamp}`);
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${ymd(e.allDay.start)}`, `DTEND;VALUE=DATE:${ymd(e.allDay.endExclusive)}`);
    } else if (e.timed) {
      const t = (hm: string) => `${hm.replace(':', '')}00`;
      lines.push(`DTSTART:${ymd(e.timed.date)}T${t(e.timed.start)}`, `DTEND:${ymd(e.timed.date)}T${t(e.timed.end)}`);
    }
    lines.push(`SUMMARY:${esc(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    lines.push(`TRANSP:${e.transparent ? 'TRANSPARENT' : 'OPAQUE'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
