/**
 * Working from home — THE definition (spec §19, built Oct 2026).
 *
 * A location is an attribute of a WORKING day, not a kind of leave: nothing
 * here touches the ledger, a balance or an absence. It changes one thing — who
 * is physically in the building — and that is the number it exists for.
 *
 * Two sources, merged into StaffDay.location by getStaffCalendar():
 *   * the working pattern's `at_home` flag — a REGULAR agreed home day, set by
 *     an admin on the pattern, effective-dated with it (no request needed);
 *   * an APPROVED request here — a one-off home day, asked for and approved
 *     like holiday (same approvers, same emails).
 * A PENDING request is shown as asked-for, never as home: until somebody says
 * yes they are expected in.
 *
 * Whole days only (jon, Oct 2026). Location is not special-category data, so
 * it reaches every viewer.
 */

import { query } from '../config/database';
import { DATE_RE } from './staff-day-status';

export type WfhStatus = 'pending' | 'approved' | 'declined' | 'withdrawn' | 'cancelled';

export interface WfhRequest {
  id: string;
  personId: string;
  personName: string;
  startDate: string;
  endDate: string;
  status: WfhStatus;
  requestNote: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
}

export interface WfhOverlay { start: string; end: string; status: 'pending' | 'approved' }

/** A month is plenty for one request; anything longer is a contract change. */
const MAX_DAYS = 31;

function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1;
}

export async function createWfhRequest(input: {
  personId: string; startDate: string; endDate: string; note?: string | null;
}, userId: string): Promise<string> {
  const { personId, startDate, endDate } = input;
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) throw new Error('Dates must be YYYY-MM-DD');
  if (endDate < startDate) throw new Error('The end date must be on or after the start date');
  if (daysBetween(startDate, endDate) > MAX_DAYS) {
    throw new Error(`One request covers up to ${MAX_DAYS} days — a regular arrangement belongs on the working pattern`);
  }

  // Only contracted working days can be worked from home. Same refusal leave
  // makes for the same reason: a home day on a day off means nothing.
  const { getStaffCalendar } = await import('./staff-day-status');
  const [cal] = await getStaffCalendar(startDate, endDate,
    { isAdmin: true, personId, includeLeave: false, includeAbsence: false });
  if (!cal) throw new Error('No staff record for this person');
  if (!cal.days.some(d => d.status === 'working')) {
    throw new Error('None of those dates are days you are contracted to work');
  }

  // One live request per date — two would make "is she home on Tuesday?"
  // depend on which row you read.
  const clash = await query(
    `SELECT 1 FROM staff_wfh_requests
      WHERE person_id = $1 AND status IN ('pending','approved')
        AND start_date <= $3::date AND end_date >= $2::date LIMIT 1`,
    [personId, startDate, endDate]);
  if (clash.rows.length) throw new Error('There is already a working-from-home request covering some of those dates');

  const r = await query(
    `INSERT INTO staff_wfh_requests (person_id, start_date, end_date, request_note, requested_by)
     VALUES ($1, $2::date, $3::date, $4, $5) RETURNING id`,
    [personId, startDate, endDate, input.note?.trim() || null, userId]);
  return r.rows[0].id as string;
}

/** pending → approved | declined. Admin only (the route says so). */
export async function decideWfhRequest(
  id: string, outcome: 'approved' | 'declined', note: string | null, userId: string
): Promise<WfhRequest> {
  const r = await query(
    `UPDATE staff_wfh_requests
        SET status = $2, decided_by = $3, decided_at = NOW(), decision_note = $4, updated_at = NOW()
      WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id, outcome, userId, note]);
  if (!r.rows.length) throw new Error('That request is no longer waiting for a decision');
  return (await getWfhRequest(id))!;
}

/** The person takes back their own pending request. */
export async function withdrawWfhRequest(id: string, personId: string): Promise<void> {
  const r = await query(
    `UPDATE staff_wfh_requests SET status = 'withdrawn', updated_at = NOW()
      WHERE id = $1 AND person_id = $2 AND status = 'pending' RETURNING id`,
    [id, personId]);
  if (!r.rows.length) throw new Error('That request is no longer pending');
}

/** An admin calls off an approved home day — they are expected in after all. */
export async function cancelWfhRequest(id: string, reason: string, userId: string): Promise<WfhRequest> {
  const r = await query(
    `UPDATE staff_wfh_requests
        SET status = 'cancelled', decided_by = $2, decided_at = NOW(), decision_note = $3, updated_at = NOW()
      WHERE id = $1 AND status = 'approved' RETURNING id`,
    [id, userId, reason]);
  if (!r.rows.length) throw new Error('Only an approved request can be cancelled');
  return (await getWfhRequest(id))!;
}

const SELECT = `
  SELECT w.id, w.person_id, w.start_date::text AS start_date, w.end_date::text AS end_date,
         w.status, w.request_note, w.requested_at, w.decided_at, w.decision_note,
         (p.first_name || ' ' || p.last_name) AS person_name,
         (dp.first_name || ' ' || dp.last_name) AS decided_by_name
    FROM staff_wfh_requests w
    JOIN people p ON p.id = w.person_id
    LEFT JOIN users du ON du.id = w.decided_by
    LEFT JOIN people dp ON dp.id = du.person_id`;

function map(row: Record<string, unknown>): WfhRequest {
  return {
    id: row.id as string,
    personId: row.person_id as string,
    personName: row.person_name as string,
    startDate: row.start_date as string,
    endDate: row.end_date as string,
    status: row.status as WfhStatus,
    requestNote: (row.request_note as string | null) ?? null,
    requestedAt: String(row.requested_at),
    decidedAt: row.decided_at ? String(row.decided_at) : null,
    decidedByName: (row.decided_by_name as string | null) ?? null,
    decisionNote: (row.decision_note as string | null) ?? null,
  };
}

export async function getWfhRequest(id: string): Promise<WfhRequest | null> {
  const r = await query(`${SELECT} WHERE w.id = $1`, [id]);
  return r.rows[0] ? map(r.rows[0]) : null;
}

export async function listWfhRequests(opts: {
  personId?: string; status?: WfhStatus; from?: string; to?: string;
}): Promise<WfhRequest[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.personId) { params.push(opts.personId); where.push(`w.person_id = $${params.length}`); }
  if (opts.status)   { params.push(opts.status);   where.push(`w.status = $${params.length}`); }
  if (opts.from)     { params.push(opts.from);     where.push(`w.end_date >= $${params.length}::date`); }
  if (opts.to)       { params.push(opts.to);       where.push(`w.start_date <= $${params.length}::date`); }
  const r = await query(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY w.status = 'pending' DESC, w.start_date DESC LIMIT 300`,
    params);
  return r.rows.map(map);
}

export async function countPendingWfh(): Promise<number> {
  const r = await query(`SELECT COUNT(*)::int AS n FROM staff_wfh_requests WHERE status = 'pending'`);
  return r.rows[0]?.n ?? 0;
}

/** Live requests per person overlapping a range — for the calendar overlay. */
export async function getWfhOverlay(
  personIds: string[], from: string, to: string
): Promise<Map<string, WfhOverlay[]>> {
  const out = new Map<string, WfhOverlay[]>();
  if (personIds.length === 0) return out;
  const r = await query(
    `SELECT person_id, start_date::text AS start_date, end_date::text AS end_date, status
       FROM staff_wfh_requests
      WHERE person_id = ANY($1::uuid[]) AND status IN ('pending','approved')
        AND start_date <= $3::date AND end_date >= $2::date`,
    [personIds, from, to]);
  for (const row of r.rows as { person_id: string; start_date: string; end_date: string; status: 'pending' | 'approved' }[]) {
    const list = out.get(row.person_id) ?? [];
    list.push({ start: row.start_date, end: row.end_date, status: row.status });
    out.set(row.person_id, list);
  }
  return out;
}
