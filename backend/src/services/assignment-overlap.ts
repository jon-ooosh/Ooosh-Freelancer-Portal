import { query } from '../config/database';

/**
 * Allocation overlap detection.
 *
 * A van is considered "occupied" for a hire from its start date up to and
 * including Job Finish (`jobs.job_end`). The +1-day turnaround buffer
 * encoded in `jobs.return_date` is deliberately ignored here — per product
 * decision, overlap checks use the real end-of-charge date. The buffer may
 * become a configurable setting in future (see CLAUDE.md).
 *
 * Statuses that DO occupy a van (block further overlapping allocations):
 *   soft, confirmed, booked_out, active
 * Statuses that do NOT occupy a van (available):
 *   returned, cancelled, swapped
 *
 * Multi-driver on one van: assignments on the same job share a van slot, so
 * overlap checks exclude the target job from the search. Passing both the
 * OP job UUID (`jobId`) and the HireHop job number (`hirehopJobId`) catches
 * both linkage styles.
 *
 * Job linkage on the JOIN: V&D staff-allocation rows carry only
 * `hirehop_job_id` (their `job_id` stays NULL because no hire form ever
 * lands), so the JOIN matches on job_id when set, otherwise falls back to
 * hh_job_number. Without this dual match the COALESCE on `j.job_date` /
 * `j.job_end` returns NULL for V&D rows and the date predicate filters them
 * out — making them invisible to overlap checks. (May 2026 fix.)
 */

const OCCUPYING_STATUSES = ['soft', 'confirmed', 'booked_out', 'active'] as const;

export type OverlapTarget = {
  vehicleId: string;
  hireStart?: string | Date | null;
  hireEnd?: string | Date | null;
  jobId?: string | null;
  hirehopJobId?: number | null;
  excludeAssignmentId?: string | null;
};

export type OverlappingAssignment = {
  id: string;
  status: string;
  jobId: string | null;
  hirehopJobId: number | null;
  jobName: string | null;
  hhJobNumber: number | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  driverName: string | null;
  vehicleReg: string | null;
};

export type ResolvedDates = {
  hireStart: Date | null;
  hireEnd: Date | null;
};

/**
 * Resolve effective hire dates, falling back to the linked job's
 * job_date / job_end when the assignment's own dates are null.
 * Returns nulls only if neither the assignment nor the job has dates.
 */
export async function resolveJobDates(
  jobId?: string | null,
  hirehopJobId?: number | null,
): Promise<ResolvedDates> {
  if (!jobId && !hirehopJobId) {
    return { hireStart: null, hireEnd: null };
  }

  const result = await query(
    `SELECT job_date, job_end
     FROM jobs
     WHERE ($1::uuid IS NOT NULL AND id = $1::uuid)
        OR ($2::integer IS NOT NULL AND hh_job_number = $2::integer)
     LIMIT 1`,
    [jobId || null, hirehopJobId || null],
  );

  const row = result.rows[0];
  if (!row) return { hireStart: null, hireEnd: null };
  return {
    hireStart: row.job_date ? new Date(row.job_date) : null,
    hireEnd: row.job_end ? new Date(row.job_end) : null,
  };
}

/**
 * Find assignments that would conflict with the target hire window.
 * Returns empty array if the target has no resolvable date range —
 * callers that want to block on missing dates should check explicitly.
 */
export async function findOverlappingAssignments(
  target: OverlapTarget,
): Promise<OverlappingAssignment[]> {
  // Resolve target dates — explicit values win, fall back to job dates.
  let start = target.hireStart ? new Date(target.hireStart) : null;
  let end = target.hireEnd ? new Date(target.hireEnd) : null;

  if (!start || !end) {
    const jobDates = await resolveJobDates(target.jobId, target.hirehopJobId);
    if (!start) start = jobDates.hireStart;
    if (!end) end = jobDates.hireEnd;
  }

  // If we still can't establish a date window, we can't check — let it through.
  if (!start || !end) return [];

  // The overlap predicate uses effective dates (vha dates, falling back to
  // the linked job's job_date/job_end). Self-job assignments are excluded
  // so multi-driver single-van rows don't self-conflict. `excludeAssignmentId`
  // handles the PATCH case where we're updating an existing row.
  const result = await query(
    `SELECT
       vha.id,
       vha.status,
       vha.job_id,
       vha.hirehop_job_id,
       vha.driver_id,
       j.job_name,
       j.hh_job_number,
       fv.reg AS vehicle_reg,
       d.full_name AS driver_name,
       COALESCE(vha.hire_start, j.job_date::DATE) AS effective_start,
       COALESCE(vha.hire_end, j.job_end::DATE) AS effective_end
     FROM vehicle_hire_assignments vha
     LEFT JOIN jobs j ON (vha.job_id IS NOT NULL AND j.id = vha.job_id)
                      OR (vha.job_id IS NULL AND j.hh_job_number = vha.hirehop_job_id)
     LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
     LEFT JOIN drivers d ON d.id = vha.driver_id
     WHERE vha.vehicle_id = $1
       AND vha.status = ANY($2::text[])
       AND ($3::uuid IS NULL OR vha.id != $3::uuid)
       AND NOT (
         ($4::uuid IS NOT NULL AND vha.job_id = $4::uuid)
         OR
         ($5::integer IS NOT NULL AND vha.hirehop_job_id = $5::integer)
       )
       AND COALESCE(vha.hire_start, j.job_date::DATE) <= $7::DATE
       AND COALESCE(vha.hire_end, j.job_end::DATE) >= $6::DATE`,
    [
      target.vehicleId,
      OCCUPYING_STATUSES,
      target.excludeAssignmentId || null,
      target.jobId || null,
      target.hirehopJobId || null,
      start,
      end,
    ],
  );

  return result.rows.map((r: any) => ({
    id: r.id,
    status: r.status,
    jobId: r.job_id,
    hirehopJobId: r.hirehop_job_id,
    jobName: r.job_name,
    hhJobNumber: r.hh_job_number,
    effectiveStart: r.effective_start ? toIsoDate(r.effective_start) : null,
    effectiveEnd: r.effective_end ? toIsoDate(r.effective_end) : null,
    driverName: r.driver_name,
    vehicleReg: r.vehicle_reg,
  }));
}

/**
 * Shorthand: is the vehicle available for this window?
 * True = no conflicts found. False = conflicts exist (inspect via
 * findOverlappingAssignments for details).
 */
export async function isVehicleAvailable(target: OverlapTarget): Promise<boolean> {
  const conflicts = await findOverlappingAssignments(target);
  return conflicts.length === 0;
}

/**
 * Build a user-facing error payload for a conflict response (HTTP 409).
 * Callers return this as the JSON body when blocking an allocation.
 */
export function buildConflictPayload(
  conflicts: OverlappingAssignment[],
  vehicleReg?: string | null,
): { error: string; code: 'vehicle_overlap'; conflicts: OverlappingAssignment[] } {
  const reg = vehicleReg || conflicts[0]?.vehicleReg || 'vehicle';
  const first = conflicts[0];
  const jobRef = first?.hhJobNumber
    ? `job #${first.hhJobNumber}`
    : first?.jobName || 'another hire';
  const when =
    first?.effectiveStart && first?.effectiveEnd
      ? ` (${first.effectiveStart} → ${first.effectiveEnd})`
      : '';
  return {
    error: `${reg} is already allocated to ${jobRef}${when}`,
    code: 'vehicle_overlap',
    conflicts,
  };
}

function toIsoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}
