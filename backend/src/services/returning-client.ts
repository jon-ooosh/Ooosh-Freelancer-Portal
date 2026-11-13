/**
 * Is this a returning client? (docs/BUSINESS-FIGURES-SPEC.md §7)
 *
 * Returning = the client organisation, OR anyone named on the enquiry as a contact,
 * has booked with us before (a booked job, or one booked and later cancelled — they
 * still found us and said yes). A lost or dud enquiry doesn't count.
 *
 * One rule for both places that ask: New Enquiry (is "Heard about us" required?) and
 * Business figures (new vs returning). Worked out from history, never asked.
 */
import { query } from '../config/database';
import { JOB_BOOKED_SQL, JOB_OUTCOME_SQL } from './job-outcomes';

/** A booked (or booked-then-cancelled) job, on the alias `p`. */
const BOOKED_P = `(${JOB_BOOKED_SQL} OR ${JOB_OUTCOME_SQL.cancelled})`.replace(/\bj\./g, 'p.');

/**
 * SQL, true when the job `jobAlias` is from a returning client: its organisation or
 * one of its contacts booked another job created before `beforeExpr`.
 */
export function returningClientSql(jobAlias: string, beforeExpr: string): string {
  return `EXISTS (
    SELECT 1 FROM jobs p
     WHERE p.id <> ${jobAlias}.id AND p.is_deleted = false
       AND LEAST(p.created_at, COALESCE(p.created_date, p.created_at)) < ${beforeExpr}
       AND ${BOOKED_P}
       AND ((${jobAlias}.client_id IS NOT NULL AND p.client_id = ${jobAlias}.client_id)
         OR EXISTS (SELECT 1 FROM job_contacts pc JOIN job_contacts jc ON jc.person_id = pc.person_id
                     WHERE pc.job_id = p.id AND jc.job_id = ${jobAlias}.id)))`;
}

export interface ReturningAnswer {
  returning: boolean;
  /** Which of them has booked before — the organisation, a contact, or neither. */
  because: 'client' | 'contact' | null;
}

/** The same rule, for an enquiry not saved yet (New Enquiry): the org and contacts picked so far. */
export async function isReturningClient(orgId: string | null, personIds: string[]): Promise<ReturningAnswer> {
  if (!orgId && personIds.length === 0) return { returning: false, because: null };
  const r = await query(
    `SELECT
       ($1::uuid IS NOT NULL AND EXISTS (
          SELECT 1 FROM jobs p WHERE p.client_id = $1::uuid AND p.is_deleted = false AND ${BOOKED_P})) AS by_client,
       EXISTS (
          SELECT 1 FROM jobs p JOIN job_contacts pc ON pc.job_id = p.id
           WHERE pc.person_id = ANY($2::uuid[]) AND p.is_deleted = false AND ${BOOKED_P}) AS by_contact`,
    [orgId, personIds],
  );
  const row = r.rows[0] as { by_client: boolean; by_contact: boolean };
  if (row.by_client) return { returning: true, because: 'client' };
  if (row.by_contact) return { returning: true, because: 'contact' };
  return { returning: false, because: null };
}
