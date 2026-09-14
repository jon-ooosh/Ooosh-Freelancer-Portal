/**
 * Overtime and the bank (Staff Calendar, Phase C).
 *
 * See docs/STAFF-CALENDAR-SPEC.md §6.
 *
 * THE BANK IS THE POINT. Approving overtime credits the 'overtime' ledger
 * account and decides nothing about what it becomes. Staff choose later —
 * time off (a TOIL leave request, already built in B2) or pay (a cash-out).
 * Both are debits against the same account, so the entry row is never mutated
 * and the decision is always a new ledger entry with its own date and reason.
 *
 * YEAR END IS A CASH-OUT, NOT AN EXPIRY (spec §6.3). Unused holiday above the
 * statutory minimum can lapse; hours already WORKED cannot simply be deleted,
 * because that is forfeiting earned pay. The 31 December sweep therefore pays
 * out whatever is left rather than zeroing it — same "doesn't roll over"
 * outcome, no forfeiture, and nobody has to remember the rule.
 */

import { query, getClient } from '../config/database';
import { DATE_RE } from './staff-day-status';
import { getBalance, postEntry } from './staff-balance';

export type OvertimeStatus = 'pending' | 'approved' | 'declined' | 'cancelled';

export interface OvertimeEntry {
  id: string;
  personId: string;
  personName: string;
  workDate: string;
  startTime: string | null;
  endTime: string | null;
  minutes: number;
  reason: string;
  status: OvertimeStatus;
  submittedAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
}

export const MIN_INCREMENT = 5;

/** Minutes between two HH:MM times. Exported so the route can validate early. */
export function minutesBetween(start: string, end: string): number {
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  return toMin(end) - toMin(start);
}

// ── Logging ─────────────────────────────────────────────────────────────────

export async function createEntry(input: {
  personId: string;
  workDate: string;
  minutes: number;
  startTime?: string | null;
  endTime?: string | null;
  reason: string;
}, userId: string): Promise<string> {
  if (!DATE_RE.test(input.workDate)) throw new Error('workDate must be YYYY-MM-DD');
  if (input.minutes <= 0) throw new Error('Overtime must be more than zero');
  if (input.minutes % MIN_INCREMENT !== 0) {
    throw new Error(`Overtime is logged in ${MIN_INCREMENT}-minute steps`);
  }
  // A day has 1,440 minutes; anything near that is a typo, not a shift.
  if (input.minutes > 960) throw new Error('That is more than 16 hours — check the figure');

  const r = await query(
    `INSERT INTO staff_overtime_entries
       (person_id, work_date, start_time, end_time, minutes, reason, submitted_by)
     VALUES ($1,$2::date,$3::time,$4::time,$5,$6,$7)
     RETURNING id`,
    [input.personId, input.workDate, input.startTime ?? null, input.endTime ?? null,
     input.minutes, input.reason, userId]
  );
  return r.rows[0].id as string;
}

/**
 * Approve, and credit the bank in the same transaction.
 *
 * If the ledger insert fails the approval must not stand, or someone is told
 * their overtime was approved while the bank never received it.
 */
export async function approveEntry(entryId: string, note: string | null, userId: string) {
  const e = await getEntry(entryId);
  if (!e) throw new Error('Entry not found');
  if (e.status !== 'pending') throw new Error(`That entry is already ${e.status}`);

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE staff_overtime_entries
          SET status='approved', decided_by=$2, decided_at=NOW(), decision_note=$3, updated_at=NOW()
        WHERE id=$1 AND status='pending'`,
      [entryId, userId, note]
    );
    await client.query(
      `INSERT INTO staff_ledger_entries
         (person_id, account, leave_year, entry_type, minutes, effective_date,
          source_type, source_id, note, created_by)
       VALUES ($1,'overtime',$2,'accrual',$3,$4::date,'overtime_entry',$5,$6,$7)`,
      [e.personId, Number(e.workDate.slice(0, 4)), e.minutes, e.workDate, entryId, e.reason, userId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function declineEntry(entryId: string, note: string, userId: string) {
  const r = await query(
    `UPDATE staff_overtime_entries
        SET status='declined', decided_by=$2, decided_at=NOW(), decision_note=$3, updated_at=NOW()
      WHERE id=$1 AND status='pending' RETURNING id`,
    [entryId, userId, note]
  );
  if (r.rows.length === 0) throw new Error('That entry is no longer pending');
}

/** Withdraw your own entry before it has been looked at. */
export async function cancelEntry(entryId: string, personId: string) {
  const r = await query(
    `UPDATE staff_overtime_entries
        SET status='cancelled', updated_at=NOW()
      WHERE id=$1 AND person_id=$2 AND status='pending' RETURNING id`,
    [entryId, personId]
  );
  if (r.rows.length === 0) throw new Error('That entry is no longer pending');
}

// ── Cash-out ────────────────────────────────────────────────────────────────

/**
 * Pay out banked overtime.
 *
 * Debits the bank with a 'spend_paid' entry, which the payroll report then
 * picks up by date range. Refuses to pay out more than is banked: this is the
 * one place in the module that is a hard limit rather than a warning, because
 * the consequence is paying someone for hours they never worked.
 */
export async function cashOut(
  personId: string, minutes: number, effectiveDate: string, note: string | null, userId: string
) {
  if (!DATE_RE.test(effectiveDate)) throw new Error('effectiveDate must be YYYY-MM-DD');
  if (minutes <= 0) throw new Error('Cash-out must be more than zero');

  const year = Number(effectiveDate.slice(0, 4));
  const bal = await getBalance(personId, 'overtime', year);
  if (minutes > bal.balanceMinutes) {
    throw new Error(
      `Only ${Math.floor(bal.balanceMinutes / 60)}h ${bal.balanceMinutes % 60}m is banked — cannot pay out more than that`
    );
  }

  return postEntry({
    personId, account: 'overtime', leaveYear: year,
    entryType: 'spend_paid', minutes: -minutes, effectiveDate,
    sourceType: 'manual',
    note: note ?? 'Paid out with payroll',
  }, userId);
}

/**
 * The 31 December sweep: pay out every remaining positive balance.
 *
 * Idempotent by construction — it reads the balance and pays exactly that, so
 * a second run finds zero and does nothing. Returns what it did so the caller
 * can report rather than guess.
 */
export async function yearEndCashOut(year: number, userId: string | null) {
  const people = await query(
    `SELECT DISTINCT se.person_id,
            (p.first_name || ' ' || p.last_name) AS name
       FROM staff_employment se
       JOIN people p ON p.id = se.person_id
      WHERE se.employment_status = 'employed'`
  );

  const results: { personId: string; name: string; minutes: number }[] = [];
  for (const row of people.rows) {
    const bal = await getBalance(row.person_id, 'overtime', year);
    if (bal.balanceMinutes <= 0) continue;
    await postEntry({
      personId: row.person_id, account: 'overtime', leaveYear: year,
      entryType: 'year_end_cashout', minutes: -bal.balanceMinutes,
      effectiveDate: `${year}-12-31`, sourceType: 'system',
      note: `Year-end cash-out — banked overtime does not carry into ${year + 1}`,
    }, userId);
    results.push({ personId: row.person_id, name: row.name, minutes: bal.balanceMinutes });
  }
  return results;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function getEntry(entryId: string): Promise<OvertimeEntry | null> {
  const r = await query(`${SELECT_ENTRY} WHERE e.id = $1`, [entryId]);
  return r.rows[0] ? mapEntry(r.rows[0]) : null;
}

export async function listEntries(opts: {
  personId?: string; status?: OvertimeStatus; from?: string; to?: string; limit?: number;
}): Promise<OvertimeEntry[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.personId) { params.push(opts.personId); where.push(`e.person_id = $${params.length}`); }
  if (opts.status)   { params.push(opts.status);   where.push(`e.status = $${params.length}`); }
  if (opts.from)     { params.push(opts.from);     where.push(`e.work_date >= $${params.length}::date`); }
  if (opts.to)       { params.push(opts.to);       where.push(`e.work_date <= $${params.length}::date`); }
  params.push(Math.min(opts.limit ?? 100, 500));

  const r = await query(
    `${SELECT_ENTRY}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY e.status = 'pending' DESC, e.work_date DESC
     LIMIT $${params.length}`,
    params
  );
  return r.rows.map(mapEntry);
}

export async function countPendingOvertime(): Promise<number> {
  const r = await query(`SELECT COUNT(*)::int AS n FROM staff_overtime_entries WHERE status='pending'`);
  return r.rows[0].n as number;
}

const SELECT_ENTRY = `
  SELECT e.id, e.person_id, e.work_date::text AS work_date,
         e.start_time::text AS start_time, e.end_time::text AS end_time,
         e.minutes, e.reason, e.status, e.submitted_at, e.decided_at, e.decision_note,
         (p.first_name || ' ' || p.last_name) AS person_name,
         (dp.first_name || ' ' || dp.last_name) AS decided_by_name
    FROM staff_overtime_entries e
    JOIN people p ON p.id = e.person_id
    LEFT JOIN users du ON du.id = e.decided_by
    LEFT JOIN people dp ON dp.id = du.person_id`;

function mapEntry(row: Record<string, unknown>): OvertimeEntry {
  return {
    id: row.id as string,
    personId: row.person_id as string,
    personName: row.person_name as string,
    workDate: row.work_date as string,
    startTime: (row.start_time as string) ?? null,
    endTime: (row.end_time as string) ?? null,
    minutes: Number(row.minutes),
    reason: row.reason as string,
    status: row.status as OvertimeStatus,
    submittedAt: new Date(row.submitted_at as string).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at as string).toISOString() : null,
    decidedByName: (row.decided_by_name as string) ?? null,
    decisionNote: (row.decision_note as string) ?? null,
  };
}

// ── Payroll report (spec §12.1) ─────────────────────────────────────────────

export interface PayrollRow {
  personId: string;
  name: string;
  paidOvertimeMinutes: number;
  unpaidLeaveMinutes: number;
  unpaidLeaveDays: number;
  nominalDayMinutes: number | null;
}

/**
 * What changed this period, for the accountants.
 *
 * Derived purely from the date range, so re-running the same period produces
 * the same numbers — the batch table records what was generated and when it
 * went, and never stamps the append-only ledger.
 *
 * Sickness and other absence join this in Phase D; the shape is deliberately
 * additive so the accountants see the same columns in the same order.
 */
export async function getPayrollReport(from: string, to: string): Promise<PayrollRow[]> {
  const r = await query(
    `SELECT se.person_id,
            (p.first_name || ' ' || p.last_name) AS name,
            COALESCE((
              SELECT -SUM(l.minutes) FROM staff_ledger_entries l
               WHERE l.person_id = se.person_id
                 AND l.account = 'overtime'
                 AND l.entry_type IN ('spend_paid','year_end_cashout')
                 AND l.effective_date BETWEEN $1::date AND $2::date
            ), 0) AS paid_overtime_minutes,
            COALESCE((
              SELECT SUM(d.minutes) FROM staff_leave_request_days d
               JOIN staff_leave_requests req ON req.id = d.request_id
               WHERE req.person_id = se.person_id
                 AND req.leave_type = 'unpaid'
                 AND req.status = 'approved'
                 AND d.leave_date BETWEEN $1::date AND $2::date
            ), 0) AS unpaid_leave_minutes
       FROM staff_employment se
       JOIN people p ON p.id = se.person_id
      WHERE p.is_deleted = false
      ORDER BY p.first_name, p.last_name`,
    [from, to]
  );

  const { getContractedWeek } = await import('./staff-balance');
  return Promise.all(r.rows.map(async (row: Record<string, unknown>) => {
    const week = await getContractedWeek(row.person_id as string, to);
    const unpaid = Number(row.unpaid_leave_minutes);
    return {
      personId: row.person_id as string,
      name: row.name as string,
      paidOvertimeMinutes: Number(row.paid_overtime_minutes),
      unpaidLeaveMinutes: unpaid,
      unpaidLeaveDays: week?.nominalDayMinutes
        ? Math.round((unpaid / week.nominalDayMinutes) * 100) / 100 : 0,
      nominalDayMinutes: week?.nominalDayMinutes ?? null,
    };
  }));
}

export function payrollCsv(rows: PayrollRow[], from: string, to: string): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    `Ooosh Tours payroll changes,${from} to ${to}`,
    '',
    'Name,Paid overtime (hours),Paid overtime (h:mm),Unpaid leave (days),Unpaid leave (hours)',
    ...rows.map(r => [
      esc(r.name),
      (r.paidOvertimeMinutes / 60).toFixed(2),
      `${Math.floor(r.paidOvertimeMinutes / 60)}:${String(r.paidOvertimeMinutes % 60).padStart(2, '0')}`,
      r.unpaidLeaveDays.toFixed(2),
      (r.unpaidLeaveMinutes / 60).toFixed(2),
    ].join(',')),
  ];
  return lines.join('\n');
}

export async function recordBatch(from: string, to: string, userId: string) {
  const r = await query(
    `INSERT INTO staff_payroll_batches (period_start, period_end, generated_by)
     VALUES ($1::date,$2::date,$3) RETURNING id, generated_at`,
    [from, to, userId]
  );
  return r.rows[0];
}
