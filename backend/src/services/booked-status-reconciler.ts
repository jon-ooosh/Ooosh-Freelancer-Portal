// booked-status-reconciler.ts — heal the OP↔HireHop "Booked" split-brain.
//
// When a deposit confirms a job, OP sets pipeline_status='confirmed' (synchronously, always)
// AND pushes HireHop → status 2 (Booked). The HH push can fail transiently (a 327 rate-limit
// storm — job 16513), and the broker RESOLVES { success:false } rather than throwing. The
// callers now check that result and, on failure, leave jobs.status untouched rather than
// falsely mirroring "Booked" (which the 30-min sync would then revert). This reconciler is the
// backstop: it finds jobs OP believes are confirmed but HireHop never received, and re-pushes.
//
// Idempotent: HireHop honours the same status 2 repeatedly, and the local mirror is only
// written when the push actually succeeds. Bounded per run so a large backlog can't stall sync.

import { query } from '../config/database';
import { hhBroker } from './hirehop-broker';

const MAX_PER_RUN = 25;

export interface ReconcileResult {
  candidates: number;
  repushed: number;
  failed: number;
}

/**
 * Re-push HireHop status 2 for jobs that OP confirmed but HireHop never got.
 *
 * Candidate = pipeline_status 'confirmed' AND HH status < 2 (i.e. still Enquiry/Provisional)
 * AND has an hh_job_number. Excludes lost/cancelled (defence — a confirmed job shouldn't be
 * either, but never re-push a dead job).
 */
export async function reconcileBookedStatus(): Promise<ReconcileResult> {
  const result: ReconcileResult = { candidates: 0, repushed: 0, failed: 0 };

  const candidates = await query(
    `SELECT id, hh_job_number
       FROM jobs
      WHERE pipeline_status = 'confirmed'
        AND hh_job_number IS NOT NULL
        AND COALESCE(status, 0) < 2
        AND pipeline_status NOT IN ('lost', 'cancelled')
      ORDER BY updated_at DESC
      LIMIT $1`,
    [MAX_PER_RUN]
  );

  result.candidates = candidates.rows.length;

  for (const row of candidates.rows) {
    const hhNum = row.hh_job_number as number;
    try {
      const pushResult = await hhBroker.post('/frames/status_save.php', {
        job: hhNum,
        status: 2, // Booked
        no_webhook: 1,
      }, { priority: 'low' });

      if (pushResult.success) {
        await query(
          `UPDATE jobs SET status = 2, status_name = 'Booked', hh_status = 2 WHERE id = $1`,
          [row.id]
        );
        result.repushed++;
        console.log(`[reconciler] Re-pushed HH Booked for job ${hhNum} (was confirmed in OP, <2 in HH)`);
      } else {
        result.failed++;
        console.warn(`[reconciler] HH Booked re-push still failing for job ${hhNum}: ${pushResult.error} (will retry next cycle)`);
      }
    } catch (err) {
      result.failed++;
      console.error(`[reconciler] HH Booked re-push threw for job ${hhNum}:`, err);
    }
  }

  return result;
}
