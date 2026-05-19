import { query } from '../config/database';

type DbClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * Single source of truth for `fleet_vehicles.hire_status`.
 *
 * The column itself is a CACHED projection of the assignment state — derived,
 * not authoritative. The authoritative truth is `vehicle_hire_assignments.status`.
 * This helper recomputes the projection from current assignment state and
 * applies it. Every code path that previously did a direct
 * `UPDATE fleet_vehicles SET hire_status = ...` should call this instead, so
 * the cache can never drift.
 *
 * Decision rules:
 *   - Sticky values ('Sold', 'Not Ready') are preserved. These are explicit
 *     manual overrides — vehicle out of service for damage repair, finance
 *     return, etc. The sync helper does not clobber them.
 *   - Any assignment in ('booked_out', 'active') → 'On Hire'.
 *     Rows whose linked job is `lost` or `cancelled` are excluded from this
 *     count — they're orphans from speculative allocations on dead jobs and
 *     shouldn't block legitimate state transitions. (May 2026 fix: vehicle
 *     RX22SWV was stuck on 'On Hire' for days because a `booked_out` row
 *     on a long-dead test job 15534 kept the count > 0.)
 *   - Otherwise, if the current value is 'On Hire' (the van WAS out, but now
 *     no active assignment exists — i.e. it just came back) → 'Prep Needed'.
 *   - 'Prep Needed' → 'Available' transition is NOT handled here. That happens
 *     when prep is completed (save-prep flow). Until prep complete, the van
 *     stays 'Prep Needed'.
 *   - All other cases: preserve current value.
 *
 * Pass `client` to run inside an existing transaction. Returns the value the
 * row now holds (whether changed or preserved). Returns null only if the
 * vehicle id doesn't exist.
 */
export async function syncFleetHireStatus(
  vehicleId: string,
  opts?: { client?: DbClient },
): Promise<string | null> {
  const run = opts?.client
    ? (text: string, params?: unknown[]) => opts.client!.query(text, params)
    : (text: string, params?: unknown[]) => query(text, params);

  const current = await run(
    `SELECT hire_status FROM fleet_vehicles WHERE id = $1`,
    [vehicleId],
  );
  if (current.rows.length === 0) return null;

  const currentStatus = (current.rows[0].hire_status as string) || 'Available';

  // Sticky — manual overrides not touched.
  if (currentStatus === 'Sold' || currentStatus === 'Not Ready') {
    return currentStatus;
  }

  // Any non-terminal assignment with this van in the field?
  // Defensive: ignore rows whose linked job is lost/cancelled — they're
  // orphans from speculative allocations on dead jobs and shouldn't block
  // legitimate state transitions. Dual job match handles V&D-style rows
  // that carry only `hirehop_job_id` (`job_id IS NULL`).
  const activeCount = await run(
    `SELECT COUNT(*)::int AS c
       FROM vehicle_hire_assignments vha
      WHERE vha.vehicle_id = $1
        AND vha.status IN ('booked_out', 'active')
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE ((vha.job_id IS NOT NULL AND j.id = vha.job_id)
                  OR (vha.job_id IS NULL AND j.hh_job_number = vha.hirehop_job_id))
             AND j.pipeline_status IN ('lost', 'cancelled')
        )`,
    [vehicleId],
  );
  const hasActive = activeCount.rows[0].c > 0;

  let nextStatus: string;
  if (hasActive) {
    nextStatus = 'On Hire';
  } else if (currentStatus === 'On Hire') {
    // Van WAS out, no active assignment now → just came back. Needs prep
    // before it goes out again.
    nextStatus = 'Prep Needed';
  } else {
    // Preserve — 'Available' / 'Prep Needed' / 'Collected' or any other
    // value stays put. The save-prep flow is what transitions
    // 'Prep Needed' → 'Available'.
    nextStatus = currentStatus;
  }

  if (nextStatus !== currentStatus) {
    await run(
      `UPDATE fleet_vehicles SET hire_status = $1, updated_at = NOW() WHERE id = $2`,
      [nextStatus, vehicleId],
    );
  }

  return nextStatus;
}

/**
 * Convenience: same as syncFleetHireStatus but takes a registration plate
 * instead of an ID. Used by save-event which works with regs.
 */
export async function syncFleetHireStatusByReg(
  reg: string,
  opts?: { client?: DbClient },
): Promise<string | null> {
  const run = opts?.client
    ? (text: string, params?: unknown[]) => opts.client!.query(text, params)
    : (text: string, params?: unknown[]) => query(text, params);

  const lookup = await run(
    `SELECT id FROM fleet_vehicles WHERE reg = $1`,
    [reg.toUpperCase()],
  );
  if (lookup.rows.length === 0) return null;
  return syncFleetHireStatus(lookup.rows[0].id, opts);
}
