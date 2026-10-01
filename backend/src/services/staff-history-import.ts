/**
 * Backfilling 2026 from BrightHR — staff went live in October 2026, not on
 * 1 January, so the year's history has to be REAL rather than read-only
 * (STAFF-CALENDAR-SPEC §18, "Going live EARLY").
 *
 * Every row goes through the module's own write paths — createRequest /
 * approveRequest for time off, createEntry / approveEntry for overtime,
 * cashOut for overtime paid as money — so pricing, the ledger and the
 * per-account entry types are exactly what a normal booking would produce.
 * None of those service functions notify anybody; notifications live in the
 * routes. A backfill must not email six people about their own February.
 *
 * Two passes, same code: a PREVIEW that writes nothing and says what each row
 * would do, and a COMMIT that does it. Rows are independent — one bad row is
 * reported, not fatal — and a re-run skips what is already there, so fixing
 * a row in the CSV and running again is safe.
 */

import { query } from '../config/database';
import { buildDays, createRequest, approveRequest, type DaySpec, type DayPortion, type LeaveType } from './staff-leave';
import { createEntry, approveEntry, cashOut } from './staff-overtime';
import { getBreakdown } from './staff-balance';

export type ImportKind = 'holiday' | 'toil_taken' | 'unpaid' | 'overtime_earned' | 'toil_paid';

export interface ImportRow {
  person: string;
  kind: ImportKind;
  status: 'approved' | 'pending';
  date: string;
  endDate: string | null;
  startTime: string | null;   // HH:MM, or 'AM' / 'PM' for a half day
  endTime: string | null;
  minutes: number | null;     // overtime / paid-out minutes; informational for time off
  note: string | null;
}

export interface RowResult {
  index: number;
  person: string;
  personId: string | null;
  kind: ImportKind;
  date: string;
  outcome: 'ok' | 'skip' | 'error';
  message: string;
  /** Holiday minutes this row moves (negative = taken). */
  holidayMinutes: number;
  /** Overtime-bank minutes this row moves. */
  overtimeMinutes: number;
}

export interface PersonSummary {
  personId: string;
  name: string;
  holidayNow: number;
  overtimeNow: number;
  holidayAfter: number;
  overtimeAfter: number;
  nominalDayMinutes: number | null;
}

const IMPORT_NOTE = 'Imported from BrightHR';
const TIME_RE = /^\d{2}:\d{2}$/;

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/** Employed staff, keyed by every name they might appear under in BrightHR. */
async function staffByName(): Promise<Map<string, { id: string; name: string }>> {
  const r = await query(
    `SELECT p.id, p.first_name, p.last_name, p.preferred_name
       FROM staff_employment se JOIN people p ON p.id = se.person_id
      WHERE se.employment_status = 'employed'`
  );
  const map = new Map<string, { id: string; name: string }>();
  for (const p of r.rows as { id: string; first_name: string | null; last_name: string | null; preferred_name: string | null }[]) {
    const last = (p.last_name ?? '').trim();
    const name = `${(p.first_name ?? '').trim()} ${last}`.trim();
    for (const first of [p.first_name, p.preferred_name]) {
      if (first?.trim()) map.set(`${first.trim()} ${last}`.toLowerCase(), { id: p.id, name });
    }
  }
  return map;
}

/** The leave-request shape of a time-off row. */
function leaveSpec(row: ImportRow): { type: LeaveType; days: Record<string, DaySpec | DayPortion> } {
  const type: LeaveType = row.kind === 'holiday' ? 'holiday' : row.kind === 'unpaid' ? 'unpaid' : 'toil';
  const days: Record<string, DaySpec | DayPortion> = {};
  const st = row.startTime?.toUpperCase() ?? '';
  const single = !row.endDate || row.endDate === row.date;
  if (st === 'AM' || st === 'PM') {
    days[row.date] = st === 'AM' ? 'am' : 'pm';
  } else if (single && row.startTime && row.endTime && TIME_RE.test(row.startTime) && TIME_RE.test(row.endTime)
    && toMin(row.endTime) > toMin(row.startTime)) {
    days[row.date] = { portion: 'hours', startTime: row.startTime, endTime: row.endTime };
  }
  // Anything else — no times, or a multi-day span with 09:00–17:00 on it — is
  // whole days, priced from the pattern like any booking.
  return { type, days };
}

/** The minutes an overtime row's times cover, crossing midnight if they must. */
function spanMinutes(start: string, end: string): number {
  const s = toMin(start), e = toMin(end);
  return e > s ? e - s : e + 1440 - s;
}

/**
 * Work out what one row would do, without writing. Returns the effect and,
 * for a time-off row, the exact request it would create.
 */
async function planRow(row: ImportRow, personId: string, dryRun: boolean, userId: string): Promise<{
  outcome: RowResult['outcome']; message: string; holidayMinutes: number; overtimeMinutes: number;
}> {
  const endDate = row.endDate || row.date;
  const note = row.note?.trim() || null;

  if (row.kind === 'holiday' || row.kind === 'toil_taken' || row.kind === 'unpaid') {
    const { type, days: overrides } = leaveSpec(row);
    let days;
    let fellBackToFullDay = false;
    try {
      days = await buildDays(personId, row.date, endDate, overrides);
    } catch (err) {
      // BrightHR books a whole day as 09:00–17:00 = 8h; OP's contract for that
      // day may be 7h with an unpaid lunch, and a timed period longer than the
      // day is refused. That is a whole day, so book it as one — and say so.
      const msg = err instanceof Error ? err.message : String(err);
      if (Object.keys(overrides).length && /longer than the/.test(msg)) {
        days = await buildDays(personId, row.date, endDate, {});
        fellBackToFullDay = true;
      } else {
        return { outcome: 'error', message: msg, holidayMinutes: 0, overtimeMinutes: 0 };
      }
    }
    if (!days.length) {
      return { outcome: 'error', message: 'None of those dates are contracted working days in OP — check the working pattern covers them', holidayMinutes: 0, overtimeMinutes: 0 };
    }
    const total = days.reduce((s, d) => s + d.minutes, 0);

    // Already there? A live request on exactly these dates and type.
    const dup = await query(
      `SELECT 1 FROM staff_leave_requests
        WHERE person_id = $1 AND leave_type = $2 AND start_date = $3::date AND end_date = $4::date
          AND status IN ('pending','approved') LIMIT 1`,
      [personId, type, row.date, endDate]);
    if (dup.rows.length) return { outcome: 'skip', message: 'Already imported', holidayMinutes: 0, overtimeMinutes: 0 };

    // Any of these days already off under ANOTHER request? createRequest's
    // unique index would refuse it at commit — say so in the preview instead.
    const clash = await query(
      `SELECT to_char(leave_date, 'YYYY-MM-DD') AS d FROM staff_leave_request_days
        WHERE person_id = $1 AND is_live AND leave_date = ANY($2::date[]) ORDER BY leave_date LIMIT 3`,
      [personId, days.map(d => d.date)]);
    if (clash.rows.length) {
      return { outcome: 'error', message: `Already booked off in OP on ${clash.rows.map((c: { d: string }) => c.d).join(', ')}`, holidayMinutes: 0, overtimeMinutes: 0 };
    }

    const effect = row.status === 'approved' ? -total : 0;
    const label = `${days.length} day${days.length === 1 ? '' : 's'} in OP, ${fmt(total)}`
      + (fellBackToFullDay ? ` — booked as a whole day (BrightHR's times ran longer than the contracted day)` : '')
      + (row.kind === 'toil_taken' && row.minutes && row.minutes !== total ? ` · BrightHR charged ${fmt(row.minutes)}` : '')
      + (row.status === 'pending' ? ' · goes in as PENDING — approve it in OP' : '');

    if (!dryRun) {
      const id = await createRequest({
        personId, leaveType: type, startDate: row.date, endDate,
        halfDays: fellBackToFullDay ? {} : overrides, note,
      }, userId);
      if (row.status === 'approved') await approveRequest(id, IMPORT_NOTE, userId);
    }
    return {
      outcome: 'ok', message: label,
      holidayMinutes: type === 'holiday' ? effect : 0,
      overtimeMinutes: type === 'toil' ? effect : 0,
    };
  }

  if (row.kind === 'overtime_earned') {
    const times = row.startTime && row.endTime && TIME_RE.test(row.startTime) && TIME_RE.test(row.endTime);
    const minutes = row.minutes ?? (times ? spanMinutes(row.startTime!, row.endTime!) : 0);
    if (!minutes || minutes <= 0) return { outcome: 'error', message: 'No minutes and no times', holidayMinutes: 0, overtimeMinutes: 0 };
    if (minutes % 5 !== 0) return { outcome: 'error', message: `${minutes} minutes is not a 5-minute step`, holidayMinutes: 0, overtimeMinutes: 0 };
    if (minutes > 960) return { outcome: 'error', message: `${fmt(minutes)} in one entry — split it by day (the limit is 16h)`, holidayMinutes: 0, overtimeMinutes: 0 };

    const dup = await query(
      `SELECT 1 FROM staff_overtime_entries
        WHERE person_id = $1 AND work_date = $2::date AND minutes = $3
          AND start_time IS NOT DISTINCT FROM $4::time
          AND status IN ('pending','approved') LIMIT 1`,
      [personId, row.date, minutes, times ? row.startTime : null]);
    if (dup.rows.length) return { outcome: 'skip', message: 'Already imported', holidayMinutes: 0, overtimeMinutes: 0 };

    if (!dryRun) {
      const id = await createEntry({
        personId, workDate: row.date, minutes,
        startTime: times ? row.startTime : null, endTime: times ? row.endTime : null,
        reason: note ?? IMPORT_NOTE,
      }, userId);
      if (row.status === 'approved') await approveEntry(id, IMPORT_NOTE, userId);
    }
    return {
      outcome: 'ok',
      message: `${fmt(minutes)} overtime${times && toMin(row.endTime!) <= toMin(row.startTime!) ? ' (past midnight)' : ''}`
        + (row.status === 'pending' ? ' · PENDING' : ''),
      holidayMinutes: 0, overtimeMinutes: row.status === 'approved' ? minutes : 0,
    };
  }

  // toil_paid — overtime paid as money rather than taken as time.
  const minutes = row.minutes ?? 0;
  if (minutes <= 0) return { outcome: 'error', message: 'Paid-out row needs minutes', holidayMinutes: 0, overtimeMinutes: 0 };
  const dup = await query(
    `SELECT 1 FROM staff_ledger_entries
      WHERE person_id = $1 AND account = 'overtime' AND entry_type = 'spend_paid'
        AND minutes = $2 AND effective_date = $3::date LIMIT 1`,
    [personId, -minutes, row.date]);
  if (dup.rows.length) return { outcome: 'skip', message: 'Already imported', holidayMinutes: 0, overtimeMinutes: 0 };
  if (!dryRun) {
    // cashOut refuses to pay more than is banked — rows run in date order so
    // the accruals before it are already in.
    await cashOut(personId, minutes, row.date, `${IMPORT_NOTE}${note ? ` — ${note}` : ''}`, userId);
  }
  return { outcome: 'ok', message: `${fmt(minutes)} paid out`, holidayMinutes: 0, overtimeMinutes: -minutes };
}

function fmt(min: number): string {
  const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60;
  return `${min < 0 ? '-' : ''}${h ? `${h}h` : ''}${h && m ? ' ' : ''}${m || !h ? `${m}m` : ''}`;
}

/**
 * Preview (dryRun) or commit a batch. Rows run in date order, accruals before
 * spends on the same day, so a paid-out or time-off row finds the overtime it
 * draws on already banked.
 */
export async function runHistoryImport(rows: ImportRow[], userId: string, dryRun: boolean) {
  // The admin running the import is recorded as approving what BrightHR approved.
  const staff = await staffByName();
  const order: Record<ImportKind, number> = { overtime_earned: 0, holiday: 1, unpaid: 1, toil_taken: 2, toil_paid: 3 };
  const indexed = rows.map((r, index) => ({ r, index }))
    .sort((a, b) => a.r.date.localeCompare(b.r.date) || order[a.r.kind] - order[b.r.kind]);

  const results: RowResult[] = [];
  for (const { r, index } of indexed) {
    const who = staff.get(r.person.trim().toLowerCase());
    const base = { index, person: r.person, kind: r.kind, date: r.date };
    if (!who) {
      results.push({ ...base, personId: null, outcome: 'error', message: 'No employed staff member by that name', holidayMinutes: 0, overtimeMinutes: 0 });
      continue;
    }
    if (!r.date.startsWith('2026-') || (r.endDate && !r.endDate.startsWith('2026-'))) {
      results.push({ ...base, personId: who.id, outcome: 'error', message: '2026 only — the backfill is this leave year', holidayMinutes: 0, overtimeMinutes: 0 });
      continue;
    }
    // The transcriber's "I couldn't read this" marker — the word in capitals,
    // so a note like "Checking in to make room…" is not mistaken for it.
    if ([r.startTime, r.endTime, r.note].some(v => v != null && /\bCHECK\b/.test(v))) {
      results.push({ ...base, personId: who.id, outcome: 'error', message: 'Marked CHECK — confirm it in BrightHR and fix the row', holidayMinutes: 0, overtimeMinutes: 0 });
      continue;
    }
    try {
      const p = await planRow(r, who.id, dryRun, userId);
      results.push({ ...base, personId: who.id, ...p });
    } catch (err) {
      results.push({ ...base, personId: who.id, outcome: 'error', message: err instanceof Error ? err.message : String(err), holidayMinutes: 0, overtimeMinutes: 0 });
    }
  }
  results.sort((a, b) => a.index - b.index);

  // Per person: where they stand now, and where this batch leaves them.
  const people = new Map<string, string>();
  for (const r of results) if (r.personId) people.set(r.personId, staffNameFor(staff, r.personId));
  const summaries: PersonSummary[] = [];
  for (const [personId, name] of people) {
    const [hol, ot] = await Promise.all([getBreakdown(personId, 'holiday', 2026), getBreakdown(personId, 'overtime', 2026)]);
    const mine = results.filter(r => r.personId === personId && r.outcome === 'ok');
    // After a commit the ledger already includes this batch.
    const dh = dryRun ? mine.reduce((s, r) => s + r.holidayMinutes, 0) : 0;
    const dot = dryRun ? mine.reduce((s, r) => s + r.overtimeMinutes, 0) : 0;
    summaries.push({
      personId, name,
      holidayNow: hol.availableMinutes - (dryRun ? 0 : mine.reduce((s, r) => s + r.holidayMinutes, 0)),
      overtimeNow: ot.availableMinutes - (dryRun ? 0 : mine.reduce((s, r) => s + r.overtimeMinutes, 0)),
      holidayAfter: hol.availableMinutes + dh,
      overtimeAfter: ot.availableMinutes + dot,
      nominalDayMinutes: hol.nominalDayMinutes,
    });
  }
  return { results, people: summaries };
}

function staffNameFor(staff: Map<string, { id: string; name: string }>, id: string): string {
  for (const v of staff.values()) if (v.id === id) return v.name;
  return id;
}
