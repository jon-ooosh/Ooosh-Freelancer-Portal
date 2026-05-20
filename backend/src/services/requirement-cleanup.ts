/**
 * Lost / Cancelled requirement cleanup — reactivation helper.
 *
 * The Lost / Cancelled cleanup pattern (see CLAUDE.md → "Lost / Cancelled
 * cleanup pattern") auto-cancels open job requirements when a job moves to
 * `lost` or `cancelled`, annotating their notes with a marker.
 *
 * When a job is resurrected (moved back out of lost/cancelled), this helper
 * reverses the sweep: rows that were auto-cancelled by the pattern are flipped
 * back to `not_started` and the marker is stripped from notes.
 *
 * Marker-gated by design — staff-cancelled rows (no marker) stay cancelled.
 * The two markers in current use:
 *   - `[Auto-cancelled: job marked lost]`  — set by routes/pipeline.ts
 *   - `[Cancelled]`                        — set by routes/cancellations.ts
 */
import { query } from '../config/database';

export const LOST_REQUIREMENT_MARKER = '[Auto-cancelled: job marked lost]';
export const CANCELLED_REQUIREMENT_MARKER = '[Cancelled]';

export interface ReactivationResult {
  reactivatedCount: number;
  ids: string[];
}

/**
 * Reactivate auto-cancelled requirements on a resurrected job.
 *
 * Returns the ids reactivated so the caller can log a count. Safe to call
 * unconditionally on any transition out of lost/cancelled — if nothing
 * matches the marker predicate, it's a no-op.
 */
export async function reactivateAutoCancelledRequirements(
  jobId: string,
): Promise<ReactivationResult> {
  const result = await query(
    `UPDATE job_requirements
     SET status = 'not_started',
         notes = NULLIF(
           TRIM(
             REPLACE(
               REPLACE(notes, E'\n[Auto-cancelled: job marked lost]', ''),
               ' [Cancelled]', ''
             )
           ),
           ''
         ),
         updated_at = NOW()
     WHERE job_id = $1
       AND status = 'cancelled'
       AND (notes LIKE '%[Auto-cancelled: job marked lost]%'
            OR notes LIKE '%[Cancelled]%')
     RETURNING id`,
    [jobId],
  );
  return {
    reactivatedCount: result.rows.length,
    ids: result.rows.map((r: { id: string }) => r.id),
  };
}
