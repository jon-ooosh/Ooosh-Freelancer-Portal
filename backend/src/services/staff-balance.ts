/**
 * Staff balances — THE answer to "how much has this person got?"
 *
 * See docs/STAFF-CALENDAR-SPEC.md §0.2 and §4.1.
 *
 * Balances are DERIVED, never stored. This module is the only place that reads
 * v_staff_balances or SUMs staff_ledger_entries; every other file asks here.
 * A second place deriving the same number is how two screens end up disagreeing
 * with each other and neither can be shown to be wrong.
 *
 * The ledger is append-only (enforced by a DB trigger). Everything in here that
 * changes a balance does so by INSERTING, including corrections, which insert a
 * reversing entry rather than touching the original.
 *
 * ENTITLEMENT is the interesting calculation and the one worth reading twice.
 * It is NOT "5.6 × this week's hours". Someone's contracted hours can change
 * part-way through a leave year, and someone joining in June is owed a fraction
 * of a year. So entitlement accrues per PATTERN PERIOD: for each stretch of the
 * year during which one working pattern was in force (and the person was
 * employed), they earn weeks × that pattern's weekly minutes × the share of the
 * year that stretch represents. Sum the stretches. This falls out correctly for
 * mid-year starters, mid-year leavers and mid-year hours changes without any of
 * them being special-cased.
 */

import { query } from '../config/database';
import { DATE_RE, daysBetween } from './staff-day-status';

export type LedgerAccount = 'holiday' | 'overtime';

export const STATUTORY_WEEKS = 5.6;

export interface LedgerEntry {
  id: string;
  account: LedgerAccount;
  leaveYear: number;
  entryType: string;
  minutes: number;
  effectiveDate: string;
  sourceType: string | null;
  sourceId: string | null;
  reversesEntryId: string | null;
  note: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface Balance {
  personId: string;
  account: LedgerAccount;
  leaveYear: number;
  balanceMinutes: number;
  creditedMinutes: number;
  debitedMinutes: number;
  /** This person's nominal day, for rendering a minutes figure as days. */
  nominalDayMinutes: number | null;
  entryCount: number;
}

// ── Pure calculation (exported for tests) ───────────────────────────────────

export interface PatternPeriod {
  effectiveFrom: string;
  effectiveTo: string | null;
  weeklyMinutes: number;
}

/** Inclusive day count of the overlap between two date ranges; 0 if disjoint. */
export function overlapDays(
  aStart: string, aEnd: string,
  bStart: string, bEnd: string
): number {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  if (end < start) return 0;
  return daysBetween(start, end) + 1;
}

/** Days in a calendar year — 366 in a leap year, and yes it matters. */
export function daysInYear(year: number): number {
  return daysBetween(`${year}-01-01`, `${year + 1}-01-01`);
}

/**
 * Round a PRO-RATED entitlement UP to the next half of a nominal day.
 *
 * Up, not nearest: rounding down can leave a mid-year starter below their
 * statutory minimum, which is a legal problem. Rounding up costs at most half a
 * day and removes the argument entirely (spec §5.1).
 *
 * Only ever applied to a part-year figure — see computeEntitlement. A full year
 * is exact (weeks × weekly minutes) and must NOT be rounded: 5.6 weeks of an
 * unequal four-day week is 22.4 of that person's days, which is not a whole
 * number of half-days, so rounding would silently gift them an extra hour every
 * year and contradict the figure the spec quotes.
 */
export function roundUpToHalfDay(minutes: number, nominalDayMinutes: number): number {
  if (!Number.isFinite(nominalDayMinutes) || nominalDayMinutes <= 0) return Math.ceil(minutes);
  const half = nominalDayMinutes / 2;
  return Math.ceil(Math.round(minutes) / half - 1e-9) * half;
}

export interface EntitlementSegment {
  from: string;
  to: string;
  days: number;
  weeklyMinutes: number;
  minutes: number;
}

/**
 * Entitlement for one leave year, segment by segment.
 *
 * Returns the working, not just the total, because the explainable balance is
 * the point: "22.4 days" is only trusted if you can see the two stretches and
 * the pro-rata that produced it.
 */
export function computeEntitlement(opts: {
  year: number;
  weeks: number;
  employedFrom: string;
  employedTo: string | null;
  patterns: PatternPeriod[];
  nominalDayMinutes: number | null;
}): { totalMinutes: number; rawMinutes: number; segments: EntitlementSegment[]; isPartYear: boolean } {
  const yearStart = `${opts.year}-01-01`;
  const yearEnd = `${opts.year}-12-31`;
  const yearDays = daysInYear(opts.year);

  const empFrom = opts.employedFrom > yearStart ? opts.employedFrom : yearStart;
  const empTo = opts.employedTo && opts.employedTo < yearEnd ? opts.employedTo : yearEnd;

  const segments: EntitlementSegment[] = [];
  for (const p of opts.patterns) {
    const from = p.effectiveFrom > empFrom ? p.effectiveFrom : empFrom;
    const to = p.effectiveTo && p.effectiveTo < empTo ? p.effectiveTo : empTo;
    const days = overlapDays(from, to, empFrom, empTo);
    if (days <= 0 || p.weeklyMinutes <= 0) continue;
    segments.push({
      from, to, days,
      weeklyMinutes: p.weeklyMinutes,
      minutes: opts.weeks * p.weeklyMinutes * (days / yearDays),
    });
  }

  const rawMinutes = segments.reduce((s, x) => s + x.minutes, 0);

  // Rounding applies to a PRO-RATED figure only — someone who started or left
  // part-way through the year. A full year is already exact and rounding it
  // would inflate it (see roundUpToHalfDay). A mid-year HOURS change is not
  // pro-rating either: the segment arithmetic is exact, so it stays exact.
  const isPartYear = empFrom > yearStart || empTo < yearEnd;
  const totalMinutes = isPartYear && opts.nominalDayMinutes
    ? roundUpToHalfDay(rawMinutes, opts.nominalDayMinutes)
    : Math.round(rawMinutes);

  return { totalMinutes, rawMinutes, segments, isPartYear };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** Weekly contracted minutes and nominal day for the pattern in force on a date. */
export async function getContractedWeek(
  personId: string, onDate: string
): Promise<{ weeklyMinutes: number; workingDays: number; nominalDayMinutes: number } | null> {
  const r = await query(
    `SELECT wp.cycle_weeks,
            SUM(d.minutes)                                  AS total_minutes,
            COUNT(*) FILTER (WHERE d.is_working)            AS working_days
       FROM staff_working_patterns wp
       JOIN staff_working_pattern_days d ON d.pattern_id = wp.id
      WHERE wp.person_id = $1
        AND wp.effective_from <= $2::date
        AND (wp.effective_to IS NULL OR wp.effective_to >= $2::date)
      GROUP BY wp.id, wp.cycle_weeks
      LIMIT 1`,
    [personId, onDate]
  );
  const row = r.rows[0];
  if (!row) return null;
  const cycles = Number(row.cycle_weeks) || 1;
  const weeklyMinutes = Math.round(Number(row.total_minutes) / cycles);
  const workingDays = Number(row.working_days) / cycles;
  return {
    weeklyMinutes,
    workingDays,
    nominalDayMinutes: workingDays > 0 ? Math.round(weeklyMinutes / workingDays) : 0,
  };
}

/** Every pattern touching a leave year, as periods for computeEntitlement. */
export async function getPatternPeriods(personId: string, year: number): Promise<PatternPeriod[]> {
  const r = await query(
    `SELECT wp.effective_from::text AS effective_from,
            wp.effective_to::text   AS effective_to,
            wp.cycle_weeks,
            SUM(d.minutes) AS total_minutes
       FROM staff_working_patterns wp
       JOIN staff_working_pattern_days d ON d.pattern_id = wp.id
      WHERE wp.person_id = $1
        AND wp.effective_from <= $3::date
        AND (wp.effective_to IS NULL OR wp.effective_to >= $2::date)
      GROUP BY wp.id, wp.effective_from, wp.effective_to, wp.cycle_weeks
      ORDER BY wp.effective_from`,
    [personId, `${year}-01-01`, `${year}-12-31`]
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    effectiveFrom: row.effective_from as string,
    effectiveTo: (row.effective_to as string) ?? null,
    weeklyMinutes: Math.round(Number(row.total_minutes) / (Number(row.cycle_weeks) || 1)),
  }));
}

/**
 * The balance, with the entries that produced it.
 *
 * `entries` is the explainability payload — the whole reason a derived balance
 * beats a stored one. Callers that only need the number can ignore it.
 */
export async function getBalance(
  personId: string, account: LedgerAccount, leaveYear: number
): Promise<Balance & { entries: LedgerEntry[] }> {
  const [totals, entries, week] = await Promise.all([
    query(
      `SELECT balance_minutes, credited_minutes, debited_minutes, entry_count
         FROM v_staff_balances
        WHERE person_id = $1 AND account = $2 AND leave_year = $3`,
      [personId, account, leaveYear]
    ),
    listEntries(personId, account, leaveYear),
    getContractedWeek(personId, `${leaveYear}-12-31`),
  ]);
  const t = totals.rows[0];
  return {
    personId, account, leaveYear,
    balanceMinutes: Number(t?.balance_minutes ?? 0),
    creditedMinutes: Number(t?.credited_minutes ?? 0),
    debitedMinutes: Number(t?.debited_minutes ?? 0),
    entryCount: Number(t?.entry_count ?? 0),
    nominalDayMinutes: week?.nominalDayMinutes ?? null,
    entries,
  };
}

export async function listEntries(
  personId: string, account: LedgerAccount, leaveYear: number
): Promise<LedgerEntry[]> {
  const r = await query(
    `SELECT e.id, e.account, e.leave_year, e.entry_type, e.minutes,
            e.effective_date::text AS effective_date,
            e.source_type, e.source_id, e.reverses_entry_id, e.note,
            e.created_by, e.created_at,
            (p.first_name || ' ' || p.last_name) AS created_by_name
       FROM staff_ledger_entries e
       LEFT JOIN users u ON u.id = e.created_by
       LEFT JOIN people p ON p.id = u.person_id
      WHERE e.person_id = $1 AND e.account = $2 AND e.leave_year = $3
      ORDER BY e.effective_date, e.created_at`,
    [personId, account, leaveYear]
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    account: row.account as LedgerAccount,
    leaveYear: Number(row.leave_year),
    entryType: row.entry_type as string,
    minutes: Number(row.minutes),
    effectiveDate: row.effective_date as string,
    sourceType: (row.source_type as string) ?? null,
    sourceId: (row.source_id as string) ?? null,
    reversesEntryId: (row.reverses_entry_id as string) ?? null,
    note: (row.note as string) ?? null,
    createdBy: (row.created_by as string) ?? null,
    createdByName: (row.created_by_name as string) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
  }));
}

// ── Writes (inserts only — the table refuses anything else) ─────────────────

export interface PostEntryInput {
  personId: string;
  account: LedgerAccount;
  leaveYear: number;
  entryType: string;
  minutes: number;
  effectiveDate: string;
  sourceType?: string | null;
  sourceId?: string | null;
  reversesEntryId?: string | null;
  note?: string | null;
}

export async function postEntry(input: PostEntryInput, userId: string | null): Promise<LedgerEntry> {
  if (!DATE_RE.test(input.effectiveDate)) throw new Error('effectiveDate must be YYYY-MM-DD');
  if (!Number.isInteger(input.minutes)) throw new Error('minutes must be a whole number');

  const r = await query(
    `INSERT INTO staff_ledger_entries
       (person_id, account, leave_year, entry_type, minutes, effective_date,
        source_type, source_id, reverses_entry_id, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11)
     RETURNING id, account, leave_year, entry_type, minutes,
               effective_date::text AS effective_date, source_type, source_id,
               reverses_entry_id, note, created_by, created_at`,
    [input.personId, input.account, input.leaveYear, input.entryType, input.minutes,
     input.effectiveDate, input.sourceType ?? null, input.sourceId ?? null,
     input.reversesEntryId ?? null, input.note ?? null, userId]
  );
  const row = r.rows[0];
  return {
    id: row.id, account: row.account, leaveYear: Number(row.leave_year),
    entryType: row.entry_type, minutes: Number(row.minutes),
    effectiveDate: row.effective_date, sourceType: row.source_type,
    sourceId: row.source_id, reversesEntryId: row.reverses_entry_id,
    note: row.note, createdBy: row.created_by, createdByName: null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Reverse an entry, in full.
 *
 * The correction mechanism (spec §0.4). The original is untouched and both rows
 * stay visible, so the ledger reads as what happened rather than as what we
 * wish had happened.
 */
export async function reverseEntry(entryId: string, note: string, userId: string): Promise<LedgerEntry> {
  const r = await query(
    `SELECT person_id, account, leave_year, entry_type, minutes,
            effective_date::text AS effective_date
       FROM staff_ledger_entries WHERE id = $1`,
    [entryId]
  );
  const e = r.rows[0];
  if (!e) throw new Error('Ledger entry not found');

  const already = await query(
    `SELECT 1 FROM staff_ledger_entries WHERE reverses_entry_id = $1`, [entryId]);
  if (already.rows.length > 0) throw new Error('That entry has already been reversed');

  return postEntry({
    personId: e.person_id,
    account: e.account,
    leaveYear: Number(e.leave_year),
    // 'correction' is valid for both accounts, so a reversal never trips the
    // per-account entry-type constraint whatever it is undoing.
    entryType: 'correction',
    minutes: -Number(e.minutes),
    effectiveDate: e.effective_date,
    reversesEntryId: entryId,
    sourceType: 'manual',
    note,
  }, userId);
}

/**
 * Bring a person's granted entitlement in line with what they have earned.
 *
 * IDEMPOTENT, and that is the point. It posts the DIFFERENCE between the
 * computed entitlement and the 'entitlement' rows already on the ledger, so:
 *   * running it twice does nothing the second time;
 *   * running it after an hours change tops up (or claws back) exactly the
 *     delta, with the reason recorded;
 *   * the 1 Jan scheduled task and a manual recalculation are the same code.
 *
 * Manual admin grants use entry_type 'adjustment' and are deliberately NOT
 * counted here, so a goodwill day is never quietly swallowed by the next
 * recalculation.
 */
export async function syncEntitlement(
  personId: string, year: number, userId: string | null
): Promise<{ targetMinutes: number; postedMinutes: number; segments: EntitlementSegment[]; reason: string }> {
  const emp = await query(
    `SELECT start_date::text AS start_date, end_date::text AS end_date,
            entitlement_weeks, employment_status
       FROM staff_employment WHERE person_id = $1`,
    [personId]
  );
  const e = emp.rows[0];
  if (!e) throw new Error('No employment record for this person');

  const weeks = e.entitlement_weeks != null ? Number(e.entitlement_weeks) : STATUTORY_WEEKS;
  const patterns = await getPatternPeriods(personId, year);
  const week = await getContractedWeek(personId, `${year}-12-31`)
    ?? await getContractedWeek(personId, `${year}-01-01`);

  const { totalMinutes, segments } = computeEntitlement({
    year, weeks,
    employedFrom: e.start_date,
    employedTo: e.end_date,
    patterns,
    nominalDayMinutes: week?.nominalDayMinutes ?? null,
  });

  // Everything THIS function has ever posted, identified by source_type
  // 'system' — not by entry_type. A reduction has to be posted as a
  // 'correction' (an entitlement row cannot be negative), so counting
  // entry_type = 'entitlement' alone would miss it and re-post the same
  // claw-back on every run, draining the balance a little further each time.
  // Manual admin grants carry source_type 'manual' and are deliberately
  // excluded, so a goodwill day is never swallowed by a recalculation.
  const granted = await query(
    `SELECT COALESCE(SUM(minutes), 0) AS total
       FROM staff_ledger_entries
      WHERE person_id = $1 AND account = 'holiday'
        AND leave_year = $2 AND source_type = 'system'`,
    [personId, year]
  );
  const alreadyGranted = Number(granted.rows[0].total);
  const delta = Math.round(totalMinutes) - alreadyGranted;

  if (delta === 0) {
    return { targetMinutes: Math.round(totalMinutes), postedMinutes: 0, segments, reason: 'Already up to date' };
  }

  // An entitlement row cannot be negative (DB constraint), so a claw-back —
  // hours reduced mid-year — is posted as a correction instead.
  const isClawback = delta < 0;
  await postEntry({
    personId,
    account: 'holiday',
    leaveYear: year,
    entryType: isClawback ? 'correction' : 'entitlement',
    minutes: delta,
    effectiveDate: `${year}-01-01`,
    sourceType: 'system',
    note: alreadyGranted === 0
      ? `${weeks} weeks entitlement for ${year}`
      : isClawback
        ? `Entitlement recalculated after an hours change — reduced for ${year}`
        : `Entitlement recalculated after an hours change — topped up for ${year}`,
  }, userId);

  return {
    targetMinutes: Math.round(totalMinutes),
    postedMinutes: delta,
    segments,
    reason: alreadyGranted === 0 ? 'Initial grant' : 'Recalculated',
  };
}

/** Balances for everyone employed, for the admin overview. */
export async function getTeamBalances(leaveYear: number) {
  const r = await query(
    `SELECT se.person_id,
            (p.first_name || ' ' || p.last_name) AS name,
            p.preferred_name,
            COALESCE(h.balance_minutes, 0) AS holiday_minutes,
            COALESCE(o.balance_minutes, 0) AS overtime_minutes
       FROM staff_employment se
       JOIN people p ON p.id = se.person_id
       LEFT JOIN v_staff_balances h
              ON h.person_id = se.person_id AND h.account = 'holiday'  AND h.leave_year = $1
       LEFT JOIN v_staff_balances o
              ON o.person_id = se.person_id AND o.account = 'overtime' AND o.leave_year = $1
      WHERE se.employment_status = 'employed' AND p.is_deleted = false
      ORDER BY p.first_name, p.last_name`,
    [leaveYear]
  );

  return Promise.all(r.rows.map(async (row: Record<string, unknown>) => {
    const week = await getContractedWeek(row.person_id as string, `${leaveYear}-12-31`);
    return {
      personId: row.person_id as string,
      name: (row.preferred_name as string) || (row.name as string),
      holidayMinutes: Number(row.holiday_minutes),
      overtimeMinutes: Number(row.overtime_minutes),
      nominalDayMinutes: week?.nominalDayMinutes ?? null,
      weeklyMinutes: week?.weeklyMinutes ?? null,
    };
  }));
}
