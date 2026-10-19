/**
 * Driver hire progress — "started the hire form for this hire, not yet signed".
 *
 * THE ONE DERIVATION behind every "is this driver joined to the hire yet"
 * surface: the cockpit Signature stage, the /drivers status pill, the greyed
 * "started, not signed" card on Job Detail, and the unsigned-form nudge.
 *
 * WHY A DERIVATION AND NOT A STATUS
 * ---------------------------------
 * A signature does not expire. `drivers.signature_date` records the LAST time
 * the driver signed — for whichever hire that was — so "has a signature date"
 * says nothing about the hire they are filling a form in for today. The thing
 * that joins a driver to a hire is the `vehicle_hire_assignments` row, created
 * at exactly one moment: the signature step of the hire form. Every earlier
 * step (iDenfy, POA, DVLA) writes only to the driver record.
 *
 * So the honest question is not "have they signed?" but "have they signed FOR
 * THIS HIRE?", and it is answerable from two facts we already hold:
 *
 *   1. `drivers.current_job_number` — the HH job whose form they are in
 *      (written at code verification by the hire-form app), and
 *   2. no live assignment row exists for (this driver, that job).
 *
 * Cameron Williams-Hill / job 16618 (Sep 2026): re-verified every document,
 * closed the tab on the DVLA "validated" screen without pressing Continue,
 * and every surface in OP read green — "Approved", "Signed 24 Apr 2026",
 * Signature stage ✓ — because all of them keyed off the April signature.
 *
 * The job must still be LIVE: once a hire is returned/completed/lost/
 * cancelled the unsigned form is history, not a to-do.
 */

import { query } from '../config/database';

/** Pipeline statuses under which an unsigned form is still worth chasing. */
const CLOSED_PIPELINE_STATUSES = ['lost', 'cancelled', 'returned_incomplete', 'returned', 'completed'];
/** HH status codes that mean the same thing when pipeline_status is stale/NULL. */
const CLOSED_HH_STATUSES = [9, 10, 11];

/**
 * SQL scalar: the driver's `current_job_number` when they have NOT signed for
 * it and the job is live, else NULL. `alias` is the `drivers` table alias.
 *
 * Kept as one fragment so the list SELECT, the status CASE, the detail read
 * and the per-job lookup cannot drift from each other.
 */
export function unsignedJobNumberSql(alias = 'd'): string {
  return `(CASE
    WHEN ${alias}.current_job_number IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM jobs lj
        WHERE lj.hh_job_number = ${alias}.current_job_number
          AND lj.is_deleted = false
          AND (lj.pipeline_status IS NULL OR lj.pipeline_status NOT IN (${CLOSED_PIPELINE_STATUSES.map(s => `'${s}'`).join(', ')}))
          AND (lj.status IS NULL OR lj.status NOT IN (${CLOSED_HH_STATUSES.join(', ')}))
      )
      AND NOT EXISTS (
        SELECT 1 FROM vehicle_hire_assignments uva
        LEFT JOIN jobs uj ON uj.id = uva.job_id
        WHERE uva.driver_id = ${alias}.id
          AND uva.status <> 'cancelled'
          AND (uva.hirehop_job_id = ${alias}.current_job_number
               OR uj.hh_job_number = ${alias}.current_job_number)
      )
    THEN ${alias}.current_job_number
    ELSE NULL
  END)`;
}

export interface UnsignedDriver {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  signature_date: string | null;
  current_job_number: number;
  current_job_started_at: string | null;
  updated_at: string | null;
}

/** Drivers who have started, but not signed, the hire form for this HH job. */
export async function findUnsignedDriversForJob(hhJobNumber: number): Promise<UnsignedDriver[]> {
  const result = await query(
    `SELECT d.id, d.full_name, d.email, d.phone, d.signature_date,
            d.current_job_number, d.current_job_started_at, d.updated_at
     FROM drivers d
     WHERE d.is_active = true
       AND d.current_job_number = $1
       AND ${unsignedJobNumberSql('d')} IS NOT NULL
     ORDER BY d.updated_at DESC`,
    [hhJobNumber]
  );
  return result.rows as UnsignedDriver[];
}
