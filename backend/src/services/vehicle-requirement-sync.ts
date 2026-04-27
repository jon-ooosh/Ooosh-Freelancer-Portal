import { query } from '../config/database';

type DbClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

type DerivedFlags = {
  vehicle_slots?: Array<unknown>;
  self_drive_count?: number;
  van_and_driver_count?: number;
  delivery_count?: number;
  collection_count?: number;
};

/**
 * Single source of truth for the pre-hire `vehicle` requirement status.
 *
 * The requirement is auto-derived from HireHop line items at sync time
 * (`hh-requirement-derivation.ts`) — the row is created and its quantity
 * implied by `jobs.hh_derived_flags.vehicle_slots`. What's NOT derived
 * automatically is whether enough vehicles have actually been allocated
 * to the job; that depends on `vehicle_hire_assignments` which evolves
 * after the requirement was first created.
 *
 * This helper computes the status from current state every time it's
 * called and updates the requirement row. Bidirectional — un-allocating
 * a vehicle correctly walks the status back from 'done' to 'in_progress'
 * or 'not_started'.
 *
 * Decision rules:
 *   - Read total vehicles needed from hh_derived_flags.vehicle_slots.length
 *     (fallback to 1 if missing — covers OP-native jobs without HH derivation)
 *   - Count distinct vehicle_id on this job's non-terminal assignments
 *     (status IN soft/confirmed/booked_out/active)
 *   - assigned >= total → 'done'
 *   - assigned > 0      → 'in_progress'
 *   - assigned = 0      → 'not_started'
 *
 * Wired into every assignment write path that adds, removes, or swaps a
 * vehicle. `blocked` is preserved if set manually — the helper only
 * touches not_started / in_progress / done.
 */
export async function syncVehicleRequirementStatus(
  jobId: string,
  opts?: { client?: DbClient },
): Promise<'not_started' | 'in_progress' | 'done' | 'unchanged'> {
  const run = opts?.client
    ? (text: string, params?: unknown[]) => opts.client!.query(text, params)
    : (text: string, params?: unknown[]) => query(text, params);

  // Read job + requirement in parallel-ish. The requirement may not exist
  // (job has no vehicle line items on HH yet) — in that case there's
  // nothing to update.
  const reqResult = await run(
    `SELECT id, status FROM job_requirements
      WHERE job_id = $1 AND requirement_type = 'vehicle' AND phase = 'pre_hire'
      LIMIT 1`,
    [jobId],
  );
  if (reqResult.rows.length === 0) return 'unchanged';

  const requirementId = reqResult.rows[0].id as string;
  const currentStatus = reqResult.rows[0].status as string;

  // Manual 'blocked' is sticky — staff explicitly flagged this requirement
  // as held up by something the auto-rule can't see. Don't clobber.
  if (currentStatus === 'blocked') return 'unchanged';

  const jobResult = await run(
    `SELECT hh_derived_flags FROM jobs WHERE id = $1`,
    [jobId],
  );
  const flags: DerivedFlags = (jobResult.rows[0]?.hh_derived_flags as DerivedFlags) || {};
  const totalNeeded = Math.max(
    flags.vehicle_slots?.length ?? 1,
    1,
  );

  // Count DISTINCT vehicles assigned (multi-driver-on-one-van counts as one).
  const assignedResult = await run(
    `SELECT COUNT(DISTINCT vehicle_id) AS c
       FROM vehicle_hire_assignments
      WHERE job_id = $1
        AND vehicle_id IS NOT NULL
        AND status IN ('soft', 'confirmed', 'booked_out', 'active')`,
    [jobId],
  );
  const assignedCount = parseInt(assignedResult.rows[0].c as string, 10) || 0;

  let nextStatus: 'not_started' | 'in_progress' | 'done';
  if (assignedCount >= totalNeeded) nextStatus = 'done';
  else if (assignedCount > 0) nextStatus = 'in_progress';
  else nextStatus = 'not_started';

  if (nextStatus === currentStatus) return 'unchanged';

  await run(
    `UPDATE job_requirements
        SET status = $1, updated_at = NOW()
      WHERE id = $2`,
    [nextStatus, requirementId],
  );

  return nextStatus;
}
