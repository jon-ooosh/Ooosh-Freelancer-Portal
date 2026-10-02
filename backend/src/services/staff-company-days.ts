/**
 * Company days — days the company grants that cost nobody any allowance.
 *
 * See docs/STAFF-CALENDAR-SPEC.md §20. One row grants a day to EVERYONE
 * (§20.4 Q1), resolved at read time rather than written per person, so a new
 * starter gets it without anyone remembering and changing it is one edit.
 *
 * A company day makes the date not-contracted. That is deliberately the same
 * outcome as a non-working day in someone's pattern, and it means three things
 * fall out for free rather than needing rules of their own:
 *
 *   - nobody can book holiday on it (buildDays only prices contracted days)
 *   - it does not count toward coverage or `min_headcount_by_weekday`
 *     (§20.4 Q3 — nobody is contracted, so the floor must not fire)
 *   - the ledger is untouched, because a day that costs nothing has no entry
 *
 * WHAT IT IS NOT: a leave type, an absence, or a pattern exception. See the
 * migration for why each of those was rejected.
 */

import { query, getClient } from '../config/database';
import { DATE_RE } from './staff-day-status';
import { postEntry } from './staff-balance';

export interface CompanyDay {
  id: string;
  dayDate: string;
  label: string;
  recurs: boolean;
  status: 'active' | 'cancelled';
  notes: string | null;
  createdAt: string;
  cancellationReason: string | null;
}

/** A company day as it lands on a specific date, recurrence already resolved. */
export interface CompanyDayOccurrence {
  date: string;
  label: string;
  companyDayId: string;
}

function mapRow(r: Record<string, any>): CompanyDay {
  return {
    id: r.id,
    dayDate: r.day_date_t,
    label: r.label,
    recurs: r.recurs,
    status: r.status,
    notes: r.notes,
    createdAt: new Date(r.created_at).toISOString(),
    cancellationReason: r.cancellation_reason,
  };
}

const SELECT = `
  SELECT c.*, c.day_date::text AS day_date_t
    FROM staff_company_days c`;

// ── Resolving recurrence ────────────────────────────────────────────────────

/**
 * Which dates a company day actually falls on inside a window.
 *
 * A one-off is itself. A recurring one is the same month and day in every year
 * the window touches — including years BEFORE it was first entered, because
 * "every Christmas Day" describes a rule rather than a start date, and a
 * calendar that showed it from 2027 but not 2026 would just look broken.
 *
 * 29 FEBRUARY IS SKIPPED in a non-leap year rather than slid to the 28th.
 * Sliding invents a day off nobody agreed to; skipping is visible in the
 * calendar and someone can add a one-off if they meant it.
 */
export function occurrencesInRange(
  day: { id: string; dayDate: string; label: string; recurs: boolean },
  from: string,
  to: string
): CompanyDayOccurrence[] {
  if (!day.recurs) {
    return day.dayDate >= from && day.dayDate <= to
      ? [{ date: day.dayDate, label: day.label, companyDayId: day.id }]
      : [];
  }

  const md = day.dayDate.slice(5); // 'MM-DD'
  const out: CompanyDayOccurrence[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    const date = `${y}-${md}`;
    // 29 Feb in a common year: Date rolls it to 1 March, which is how we spot it.
    const [yy, mm, dd] = date.split('-').map(Number);
    const probe = new Date(Date.UTC(yy, mm - 1, dd));
    if (probe.getUTCMonth() !== mm - 1) continue;
    if (date >= from && date <= to) {
      out.push({ date, label: day.label, companyDayId: day.id });
    }
  }
  return out;
}

/**
 * Every company day falling in a window, keyed by date.
 *
 * Called by staff-day-status.ts. A date carrying both a recurring day and a
 * one-off keeps the one-off's label, on the grounds that somebody typed it
 * deliberately and more recently.
 */
export async function getCompanyDayOverlay(from: string, to: string): Promise<Map<string, CompanyDayOccurrence>> {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error('Dates must be YYYY-MM-DD');

  // Recurring rows are fetched whatever their own date, since they apply to
  // every year; one-offs are narrowed to the window.
  const r = await query(
    `${SELECT}
      WHERE c.status = 'active'
        AND (c.recurs OR c.day_date BETWEEN $1::date AND $2::date)`,
    [from, to]
  );

  const out = new Map<string, CompanyDayOccurrence>();
  for (const row of r.rows) {
    const day = { id: row.id, dayDate: row.day_date_t, label: row.label, recurs: row.recurs };
    for (const occ of occurrencesInRange(day, from, to)) {
      const existing = out.get(occ.date);
      if (!existing || row.recurs === false) out.set(occ.date, occ);
    }
  }
  return out;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function listCompanyDays(opts: { includeCancelled?: boolean } = {}): Promise<CompanyDay[]> {
  const r = await query(
    `${SELECT}
      ${opts.includeCancelled ? '' : `WHERE c.status = 'active'`}
      ORDER BY c.recurs DESC, c.day_date`
  );
  return r.rows.map(mapRow);
}

export async function getCompanyDay(id: string): Promise<CompanyDay | null> {
  const r = await query(`${SELECT} WHERE c.id = $1`, [id]);
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

/** What a year actually looks like once recurrence is resolved. */
export async function listOccurrences(year: number): Promise<CompanyDayOccurrence[]> {
  const map = await getCompanyDayOverlay(`${year}-01-01`, `${year}-12-31`);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ── Writes ──────────────────────────────────────────────────────────────────

export async function createCompanyDay(input: {
  dayDate: string; label: string; recurs?: boolean; notes?: string | null;
}, userId: string): Promise<CompanyDay> {
  if (!DATE_RE.test(input.dayDate)) throw new Error('The date must be YYYY-MM-DD');
  if (!input.label.trim()) throw new Error('Give it a name — it shows on everyone\'s calendar');

  try {
    const r = await query(
      `INSERT INTO staff_company_days (day_date, label, recurs, notes, created_by)
       VALUES ($1::date, $2, $3, $4, $5) RETURNING id`,
      [input.dayDate, input.label.trim(), input.recurs ?? false, input.notes ?? null, userId]
    );
    const day = await getCompanyDay(r.rows[0].id);
    if (!day) throw new Error('Company day vanished immediately after being created');
    return day;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('idx_company_day_one_off')) {
      throw new Error('That date is already a company day');
    }
    if (msg.includes('idx_company_day_recurring')) {
      throw new Error('That day of the year is already a recurring company day');
    }
    throw e;
  }
}

/**
 * Soft-cancel. Any holiday reclaimed because of it is NOT re-debited.
 *
 * Taking the day back does not retroactively re-charge someone for a holiday
 * they did not take — by the time it is cancelled they have either worked the
 * day or not. If the grant was a mistake and the allowance genuinely needs
 * re-debiting, that is a manual ledger adjustment a human decides on, which is
 * the whole posture of this module.
 */
export async function cancelCompanyDay(id: string, reason: string, userId: string): Promise<void> {
  const cur = await getCompanyDay(id);
  if (!cur) throw new Error('Company day not found');
  if (cur.status === 'cancelled') throw new Error('That company day is already cancelled');

  await query(
    `UPDATE staff_company_days
        SET status = 'cancelled', cancelled_by = $2, cancelled_at = NOW(),
            cancellation_reason = $3, updated_at = NOW()
      WHERE id = $1`,
    [id, userId, reason]
  );
}

// ── Reclaiming holiday the company day overtook (§20.3) ─────────────────────

export interface CompanyReclaimCandidate {
  dayId: string;
  personId: string;
  personName: string;
  date: string;
  minutes: number;
  leaveType: string;
}

/**
 * Approved leave that this company day has landed on top of.
 *
 * Same shape as the sickness reclaim in staff-absence.ts and for the same
 * reason: the person has paid for a day they are now being given. Only
 * 'holiday' and 'toil' — unpaid leave cost nothing, so there is nothing to
 * hand back.
 */
export async function getCompanyReclaimCandidates(id: string): Promise<CompanyReclaimCandidate[]> {
  const day = await getCompanyDay(id);
  if (!day || day.status !== 'active') return [];

  // Look forward from today only for a recurring day: reclaiming somebody's
  // holiday from three Christmases ago would rewrite a settled year.
  const today = new Date().toISOString().slice(0, 10);
  const from = day.recurs ? today : day.dayDate;
  const to = day.recurs ? `${Number(today.slice(0, 4)) + 2}-12-31` : day.dayDate;
  const dates = [...(await getCompanyDayOverlay(from, to)).values()]
    .filter(o => o.companyDayId === id)
    .map(o => o.date);
  if (dates.length === 0) return [];

  const r = await query(
    `SELECT d.id, d.person_id, d.leave_date::text AS leave_date, d.minutes,
            r.leave_type, (p.first_name || ' ' || p.last_name) AS name
       FROM staff_leave_request_days d
       JOIN staff_leave_requests r ON r.id = d.request_id
       JOIN people p ON p.id = d.person_id
      WHERE d.is_live
        AND d.leave_date = ANY($1::date[])
        AND d.reclaimed_absence_id IS NULL
        AND d.reclaimed_company_day_id IS NULL
        AND r.status = 'approved'
        AND r.leave_type IN ('holiday','toil')
      ORDER BY d.leave_date, p.first_name`,
    [dates]
  );

  return r.rows.map(row => ({
    dayId: row.id,
    personId: row.person_id,
    personName: row.name,
    date: row.leave_date,
    minutes: Number(row.minutes),
    leaveType: row.leave_type,
  }));
}

/**
 * Give those days back.
 *
 * A 'correction' credit per day, exactly as §7.4's sickness reclaim does, and
 * a stamp so the same day cannot be credited twice. TOIL goes back to the
 * overtime bank, not to holiday — sending it to holiday would quietly convert
 * banked overtime into annual leave.
 *
 * Offered, never automatic: giving allowance back is a decision, and the
 * platform rule is that a recomputed figure gets surfaced for a human.
 */
export async function reclaimForCompanyDay(
  id: string, leaveDayIds: string[], userId: string
): Promise<{ reclaimed: number; minutes: number }> {
  if (leaveDayIds.length === 0) return { reclaimed: 0, minutes: 0 };

  const day = await getCompanyDay(id);
  if (!day) throw new Error('Company day not found');

  const candidates = await getCompanyReclaimCandidates(id);
  const wanted = candidates.filter(c => leaveDayIds.includes(c.dayId));
  if (wanted.length === 0) throw new Error('None of those days can be reclaimed');

  const client = await getClient();
  let minutes = 0;
  try {
    await client.query('BEGIN');
    for (const c of wanted) {
      await client.query(
        `UPDATE staff_leave_request_days SET reclaimed_company_day_id = $2 WHERE id = $1`,
        [c.dayId, id]
      );
      minutes += c.minutes;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Ledger writes go through postEntry, outside the transaction above, because
  // staff_ledger_entries is append-only and a failure here leaves a stamped day
  // with no credit — which the candidate query then reports as already
  // reclaimed. Post after the stamp so the worst case is a missing credit that
  // is visible, rather than a credit with nothing recording why.
  for (const c of wanted) {
    await postEntry({
      personId: c.personId,
      account: c.leaveType === 'toil' ? 'overtime' : 'holiday',
      leaveYear: Number(c.date.slice(0, 4)),
      entryType: 'correction',
      minutes: c.minutes,
      effectiveDate: c.date,
      sourceType: 'manual',
      note: `Reclaimed — ${day.label} became a company day`,
    }, userId);
  }

  return { reclaimed: wanted.length, minutes };
}
