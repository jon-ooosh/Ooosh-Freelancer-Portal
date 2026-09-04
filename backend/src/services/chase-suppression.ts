/**
 * Auto-chase suppression checklist (Auto-Chase Phase 2/3, spec §10)
 *
 * Before any AUTOMATED chase (draft or send) fires, we run a pre-flight check
 * that the conversation hasn't moved on — the "auto-unenrol on reply" pattern
 * every serious sales-engagement tool uses, and the whole point of ingesting the
 * inbox first. A hit either SUPPRESSES the chase (hold, don't fire) or ESCALATES
 * it to a human (cold dead-end — stop chasing, ask someone to call or drop it).
 *
 * The manual "Draft chase" button does NOT run this — staff see the modal and
 * make the call themselves. This is only for the scheduler-driven path.
 *
 * This is the first cut. It covers the highest-value signals we can derive
 * cheaply + reliably from what we already store:
 *   - Client on Do Not Hire → suppress.
 *   - Cold dead-end (N silent auto-chases, N = auto_chase_max_silent) → escalate.
 *   - Client emailed since our last auto-chase → suppress (their move / awaiting
 *     our reply — the headline suppression signal).
 * Deferred (need mail-content parsing): OOO autoresponder detection, bounce
 * detection, hot-inbound emphasis. Pipeline-moved / deposit-taken is already
 * handled upstream — those clear next_chase_date, so the job isn't due.
 */
import { query } from '../config/database';
import { getSystemSetting } from '../routes/system-settings';

export interface ChaseSuppression {
  /** OK to draft/send a chase now. */
  proceed: boolean;
  /** Held back for a soft reason (activity / Do Not Hire) — re-check later. */
  suppressed: boolean;
  /** Cold dead-end — hand to a human and stop the automated cadence. */
  escalate: boolean;
  /** Human-readable reason (logged on the timeline / escalation notification). */
  reason: string;
}

const DEFAULT_MAX_SILENT = 3;
// When a job has never been auto-chased, treat a client email in the last few
// days as "just engaged, don't chase over the top".
const RECENT_INBOUND_DAYS = 3;

export async function evaluateChaseSuppression(jobId: string): Promise<ChaseSuppression> {
  const jr = await query(
    `SELECT j.id, j.client_id, j.pipeline_status,
            COALESCE(j.auto_chase_count, 0) AS auto_chase_count,
            j.last_auto_chase_at,
            COALESCE(j.is_internal, false) AS is_internal,
            o.do_not_hire AS org_dnh
       FROM jobs j
       LEFT JOIN organisations o ON o.id = j.client_id
      WHERE j.id = $1 AND j.is_deleted = false`,
    [jobId],
  );
  if (jr.rows.length === 0) {
    return { proceed: false, suppressed: true, escalate: false, reason: 'job not found' };
  }
  const j = jr.rows[0];

  // Internal jobs never get client-facing chases.
  if (j.is_internal) {
    return { proceed: false, suppressed: true, escalate: false, reason: 'internal job' };
  }

  // 1. Client flagged Do Not Hire → never auto-chase.
  if (j.org_dnh) {
    return { proceed: false, suppressed: true, escalate: false, reason: 'client flagged Do Not Hire' };
  }

  // 2. Cold dead-end → escalate to a human instead of firing chase #N+1.
  const maxSilent = parseInt((await getSystemSetting('auto_chase_max_silent')) || '', 10) || DEFAULT_MAX_SILENT;
  if (Number(j.auto_chase_count) >= maxSilent) {
    return {
      proceed: false,
      suppressed: false,
      escalate: true,
      reason: `${j.auto_chase_count} silent auto-chase${Number(j.auto_chase_count) === 1 ? '' : 's'} with no reply — needs a human (call them or drop it?)`,
    };
  }

  // 3. Client emailed since our last auto-chase (or very recently, if we've never
  //    auto-chased) → they've engaged / it's our move. Suppress.
  const inbound = await query(
    `SELECT MAX(created_at) AS last_in
       FROM interactions
      WHERE job_id = $1 AND type = 'email' AND email_direction = 'inbound'`,
    [jobId],
  );
  const lastIn = inbound.rows[0]?.last_in ? new Date(inbound.rows[0].last_in) : null;
  if (lastIn) {
    const threshold = j.last_auto_chase_at
      ? new Date(j.last_auto_chase_at)
      : new Date(Date.now() - RECENT_INBOUND_DAYS * 86_400_000);
    if (lastIn > threshold) {
      return {
        proceed: false,
        suppressed: true,
        escalate: false,
        reason: 'client emailed since our last chase — awaiting our reply, not chasing over the top',
      };
    }
  }

  return { proceed: true, suppressed: false, escalate: false, reason: 'ok' };
}
