/**
 * When a quote's work ends, for completion. THE definition (Oct 2026), shared by
 * the completion chaser (SQL) and the freelancer portal (TS), so "you can
 * complete this from…" and "we start chasing at…" can never disagree.
 *
 * OP stores no finish TIME for crew or People work (the calculator works one out
 * and throws it away), only the start date and, for multi-day work, the last
 * day. So completion keys off the LAST DAY (jon, Oct 2026):
 *   - the freelancer can complete from the start of the last day (a single-day
 *     job: all day on the day — a "9am to 9am" booking is still one day here,
 *     because the quote's date is the working day);
 *   - the chaser starts at 09:00 UK the day after the last day.
 * Ordinary deliveries and collections keep chasing from their arrival time.
 *
 * A People job is a delivery/collection quote with `what_is_it = 'people'`
 * (driver and van with passengers); a crew job is `job_type = 'crewed'`.
 */
import { dateOnly } from './leads/dates';

/** Work keyed to its END (crew, People), not its arrival. */
export function isEndKeyed(row: { job_type?: unknown; what_is_it?: unknown }): boolean {
  return row.job_type === 'crewed' || row.what_is_it === 'people';
}

/**
 * The last day of the work as SQL (a DATE), on a quotes row aliased `q`.
 * A finish date before the start is ignored (a typo shouldn't pull the end
 * earlier). A day-rate crew quote with Days > 1 but no multi-day finish date
 * runs that many consecutive days.
 */
export const LAST_WORK_DAY_SQL = `(CASE
    WHEN q.job_finish_date IS NOT NULL AND q.job_finish_date >= q.job_date THEN q.job_finish_date
    WHEN q.job_type = 'crewed' AND COALESCE(q.num_days, 1) > 1 THEN q.job_date + (q.num_days - 1)
    ELSE q.job_date
  END)`;

/**
 * When the completion chase clock starts, as SQL (a TIMESTAMPTZ), on `q`.
 * Built in UK time (the server runs in UTC: a plain JS Date.setHours ran the
 * chaser an hour late all summer). The arrival-time cast is guarded by a regex
 * so a malformed value falls back to midday instead of failing the whole scan.
 */
export const CHASE_FROM_SQL = `(CASE
    WHEN q.job_type = 'crewed' OR q.what_is_it = 'people'
      THEN ((${LAST_WORK_DAY_SQL} + 1) + TIME '09:00') AT TIME ZONE 'Europe/London'
    ELSE (q.job_date + CASE
            WHEN q.arrival_time ~ '^(?:[01]?[0-9]|2[0-3]):[0-5][0-9]'
              THEN substring(q.arrival_time from '^(?:[01]?[0-9]|2[0-3]):[0-5][0-9]')::time
            ELSE TIME '12:00'
          END) AT TIME ZONE 'Europe/London'
  END)`;

/** Add whole days to a YYYY-MM-DD date. */
function plusDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The last day of the work as YYYY-MM-DD (same rule as LAST_WORK_DAY_SQL), or null. */
export function lastWorkDay(row: {
  job_type?: unknown; job_date?: unknown; job_finish_date?: unknown; num_days?: unknown;
}): string | null {
  const start = dateOnly(row.job_date);
  if (!start) return null;
  const finish = dateOnly(row.job_finish_date);
  if (finish && finish >= start) return finish;
  const days = Number(row.num_days) || 1;
  if (row.job_type === 'crewed' && days > 1) return plusDays(start, days - 1);
  return start;
}
