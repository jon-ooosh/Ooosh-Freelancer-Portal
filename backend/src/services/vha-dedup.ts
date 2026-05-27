import { query } from '../config/database';

type DbClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

/**
 * Cancel orphaned staff-allocation rows when a hire-form-driven assignment
 * books out onto the same (vehicle, job).
 *
 * The dual-row pattern: a self-drive hire can carry two
 * `vehicle_hire_assignments` rows for the same `(vehicle_id, job)`:
 *   - Staff-allocation row — created from AllocationsPage. `driver_id` NULL,
 *     `vehicle_id` set, status 'confirmed', no `booked_out_at`. Represents
 *     "this van is going to this hire".
 *   - Hire-form row — created by POST /api/hire-forms. `driver_id` set,
 *     progresses through `booked_out` → `returned`.
 *
 * When the hire-form row books out, the staff-allocation sibling is dead
 * weight: it still counts as 'occupying' in overlap checks, blocking future
 * allocations + swaps for that van. This is the root cause of the 15 May 2026
 * HLU/15613 incident — a stale `confirmed` orphan blocked a vehicle swap
 * because the overlap check treated it as a live commitment.
 *
 * The freelancer-bookout smart-resolve path already merges these rows; this
 * helper ports the same dedup to the staff book-out path.
 *
 * Tight guards to avoid collateral damage:
 *   - `driver_id IS NULL` — only PURE allocation rows. A second DRIVER sharing
 *     the same van on a multi-driver hire has `driver_id` set and is preserved.
 *   - `booked_out_at IS NULL` — never touch a row that physically went out.
 *   - `status IN ('soft', 'confirmed')` — terminal rows are already inert.
 *   - `id != keepAssignmentId` — never cancel the row that just booked out.
 *
 * Soft-cancel only (status='cancelled' + audit note) — never a physical DELETE,
 * per the platform convention (CLAUDE.md "vehicle_hire_assignments is soft-cancel only").
 *
 * Returns the count of rows cancelled.
 */
export async function cancelOrphanSiblingAllocations(opts: {
  keepAssignmentId: string;
  vehicleId: string;
  jobId?: string | null;
  hhJobNumber?: number | null;
  client?: DbClient;
}): Promise<number> {
  const { keepAssignmentId, vehicleId, jobId, hhJobNumber } = opts;
  if (!vehicleId || (!jobId && !hhJobNumber)) return 0;

  const run = opts.client
    ? (text: string, params?: unknown[]) => opts.client!.query(text, params)
    : (text: string, params?: unknown[]) => query(text, params);

  const result = await run(
    `UPDATE vehicle_hire_assignments
        SET status = 'cancelled',
            status_changed_at = NOW(),
            updated_at = NOW(),
            notes = COALESCE(notes, '') ||
                    CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE E'\n' END ||
                    $1
      WHERE vehicle_id = $2
        AND id != $3
        AND driver_id IS NULL
        AND booked_out_at IS NULL
        AND status IN ('soft', 'confirmed')
        AND (
          ($4::uuid IS NOT NULL AND job_id = $4::uuid)
          OR ($5::integer IS NOT NULL AND hirehop_job_id = $5::integer)
        )`,
    [
      `[Auto-cancelled: orphan staff-allocation row superseded by hire-form book-out ${keepAssignmentId} on ${new Date().toISOString()}]`,
      vehicleId,
      keepAssignmentId,
      jobId || null,
      hhJobNumber || null,
    ],
  );

  return result.rowCount || 0;
}

/**
 * Cancel stale van allocations when a hire returns (check-in).
 *
 * Once a van is physically checked in, the hire on that (vehicle, job) is
 * over. Any row still linked to that van for that job that NEVER booked out
 * (`booked_out_at IS NULL`, status soft/confirmed) is a planned driver/van
 * link that never physically happened — it's dead weight, and it keeps
 * "occupying" the van in overlap checks, blocking future allocations + swaps.
 *
 * This is DRIVER-AGNOSTIC on purpose (unlike `cancelOrphanSiblingAllocations`,
 * which only cancels pure staff-allocation rows at book-out time). At
 * book-out we can't safely cancel a driver-bearing sibling because it might
 * be a legitimate second driver pending their own book-out. At check-in
 * there's no such ambiguity: the van came back, so nothing un-booked-out on
 * it is going anywhere. This is what would have prevented the 15 May 2026
 * HLU/15613 incident — the blocking orphan had a `driver_id` set, so the
 * book-out dedup's `driver_id IS NULL` guard would have missed it.
 *
 * The rows being checked in are themselves excluded automatically: they have
 * `booked_out_at NOT NULL` (and status `returned` post-flip), so the
 * `booked_out_at IS NULL` + soft/confirmed guards never match them.
 *
 * Soft-cancel only. Returns the count of rows cancelled.
 */
export async function cancelStaleVanAllocationsOnReturn(opts: {
  vehicleId: string;
  jobId?: string | null;
  hhJobNumber?: number | null;
  client?: DbClient;
}): Promise<number> {
  const { vehicleId, jobId, hhJobNumber } = opts;
  if (!vehicleId || (!jobId && !hhJobNumber)) return 0;

  const run = opts.client
    ? (text: string, params?: unknown[]) => opts.client!.query(text, params)
    : (text: string, params?: unknown[]) => query(text, params);

  const result = await run(
    `UPDATE vehicle_hire_assignments
        SET status = 'cancelled',
            status_changed_at = NOW(),
            updated_at = NOW(),
            notes = COALESCE(notes, '') ||
                    CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE E'\n' END ||
                    $1
      WHERE vehicle_id = $2
        AND booked_out_at IS NULL
        AND status IN ('soft', 'confirmed')
        AND (
          ($3::uuid IS NOT NULL AND job_id = $3::uuid)
          OR ($4::integer IS NOT NULL AND hirehop_job_id = $4::integer)
        )`,
    [
      `[Auto-cancelled: stale van allocation — never booked out, hire returned on ${new Date().toISOString()}]`,
      vehicleId,
      jobId || null,
      hhJobNumber || null,
    ],
  );

  return result.rowCount || 0;
}

