/**
 * Quote completion — leg-based, server-side.
 *
 * A portal D&C quote can have a VAN leg (book-out / check-in recorded on OP)
 * and/or an EQUIPMENT leg (portal /complete checklist). The /start wizard
 * declares which legs a job has (persisted to quotes.requires_van_leg /
 * requires_equipment_leg); each leg stamps its own *_leg_done_at as it
 * happens; and maybeCloseQuote() closes the quote when the last required leg
 * lands — INDEPENDENT of whether the freelancer's browser returns across the
 * OP↔portal domain boundary.
 *
 * This is the backbone that fixes the Tobi nag (HH 15669): a van-only delivery
 * book-out closes the quote directly, so the completion chaser stops the moment
 * the van leaves — no cross-domain return hop required. And a "both" job
 * survives a failed hop: each leg is stamped when it happens and the quote
 * closes when both are in, in any order.
 *
 * The completion chaser (services/completion-chaser.ts) already gates on
 * ops_status NOT IN ('completed','cancelled'), so closing the quote here stops
 * the nag for free — every leg-completion path just has to call maybeCloseQuote.
 */
import { query } from '../config/database';
import { autoDispatchJob } from './auto-dispatch';

export type QuoteLeg = 'van' | 'equipment';

/**
 * Record that a leg of the quote has completed. Idempotent — COALESCE keeps the
 * first-done timestamp if called again (e.g. a book-out re-submit).
 */
export async function stampQuoteLeg(quoteId: string, leg: QuoteLeg): Promise<void> {
  const col = leg === 'van' ? 'van_leg_done_at' : 'equipment_leg_done_at';
  await query(
    `UPDATE quotes SET ${col} = COALESCE(${col}, NOW()), updated_at = NOW() WHERE id = $1`,
    [quoteId]
  );
}

interface MaybeCloseOpts {
  /**
   * Which leg's completion triggered this call. Only used for LEGACY quotes
   * (requires_* undeclared): equipment (/complete) closes them as it always
   * did, van (book-out) does not — an undeclared quote might be a "both" whose
   * equipment leg is still outstanding, so we preserve the old return-hop
   * behaviour rather than risk a premature close.
   */
  triggeringLeg: QuoteLeg;
  /** Recorded as completed_by when this call is what closes the quote. */
  actorLabel?: string | null;
}

interface MaybeCloseResult {
  closed: boolean;
  reason?: 'already' | 'pending_legs' | 'not_found' | 'legacy_van_noop';
}

/**
 * Close the quote if every required leg is done. Idempotent + safe to call from
 * any leg-completion path. Fires the last-mover auto-dispatch in the background
 * when it closes a delivery quote (same behaviour that used to live inline in
 * the portal /complete handler).
 */
export async function maybeCloseQuote(quoteId: string, opts: MaybeCloseOpts): Promise<MaybeCloseResult> {
  const load = await query(
    `SELECT q.ops_status, q.job_id, q.job_type,
            q.requires_van_leg, q.requires_equipment_leg,
            q.van_leg_done_at, q.equipment_leg_done_at,
            j.hh_job_number
       FROM quotes q
       LEFT JOIN jobs j ON j.id = q.job_id
      WHERE q.id = $1 AND q.is_deleted = false`,
    [quoteId]
  );
  if (load.rows.length === 0) return { closed: false, reason: 'not_found' };
  const row = load.rows[0];

  if (row.ops_status === 'completed' || row.ops_status === 'cancelled') {
    return { closed: false, reason: 'already' };
  }

  const vanDeclared = row.requires_van_leg;             // true | false | null
  const equipDeclared = row.requires_equipment_leg;     // true | false | null
  const undeclared = vanDeclared === null && equipDeclared === null;

  let shouldClose: boolean;
  if (undeclared) {
    // Legacy quote (never hit the new /start). Preserve old behaviour: the
    // equipment /complete closes it; a van book-out does not (could be a
    // "both" whose equipment leg is still pending).
    if (opts.triggeringLeg !== 'equipment') {
      return { closed: false, reason: 'legacy_van_noop' };
    }
    shouldClose = true;
  } else {
    // Van leg is satisfied if it isn't required, OR it was stamped, OR the van
    // is physically out on this job (belt-and-braces for the uncommon case
    // where the van was booked out by staff on the desk rather than through the
    // freelancer's own session, so van_leg_done_at never stamped — we don't
    // want to nag a freelancer who's done their equipment part).
    let vanOk = vanDeclared !== true || row.van_leg_done_at != null;
    if (!vanOk && (row.job_id || row.hh_job_number)) {
      const out = await query(
        `SELECT 1
           FROM vehicle_hire_assignments vha
          WHERE (($1::uuid IS NOT NULL AND vha.job_id = $1)
                 OR ($2::int IS NOT NULL AND vha.hirehop_job_id = $2))
            AND vha.status IN ('booked_out', 'active', 'returned')
          LIMIT 1`,
        [row.job_id ?? null, row.hh_job_number ?? null]
      );
      if (out.rows.length > 0) vanOk = true;
    }
    const equipOk = equipDeclared !== true || row.equipment_leg_done_at != null;
    shouldClose = vanOk && equipOk;
  }

  if (!shouldClose) return { closed: false, reason: 'pending_legs' };

  // Conditional close — the WHERE guard makes concurrent/duplicate calls a
  // no-op (only one wins the transition out of a non-terminal ops_status).
  const closed = await query(
    `UPDATE quotes
        SET ops_status = 'completed',
            status = CASE WHEN status IN ('draft', 'confirmed') THEN 'completed' ELSE status END,
            completed_at = COALESCE(completed_at, NOW()),
            completed_by = COALESCE(completed_by, $2),
            updated_at = NOW()
      WHERE id = $1
        AND COALESCE(ops_status, 'todo') NOT IN ('completed', 'cancelled')
      RETURNING id`,
    [quoteId, opts.actorLabel ?? null]
  );
  if (closed.rows.length === 0) {
    // Lost the race — someone else just closed it.
    return { closed: false, reason: 'already' };
  }

  // Last-mover auto-dispatch (background, delivery quotes only). When the FINAL
  // outstanding delivery quote on a job completes, push the job to
  // pipeline_status='dispatched' + HH 5. Idempotent inside the helper (skips if
  // already dispatched, whitelisted pipeline statuses only). Fire-and-forget so
  // callers aren't blocked.
  if (row.job_id && row.job_type === 'delivery') {
    const jobId = row.job_id as string;
    const actor = opts.actorLabel || 'freelancer portal';
    setImmediate(() => {
      (async () => {
        const remaining = await query(
          `SELECT COUNT(*)::int AS remaining
             FROM quotes
            WHERE job_id = $1
              AND id != $2
              AND job_type = 'delivery'
              AND is_deleted = false
              AND COALESCE(ops_status, 'todo') NOT IN ('completed', 'cancelled')
              AND status NOT IN ('completed', 'cancelled')`,
          [jobId, quoteId]
        );
        if (remaining.rows[0].remaining === 0) {
          await autoDispatchJob({
            jobId,
            source: 'portal',
            actorLabel: actor,
            actorUserId: null,
            interactionContent: `🚚 Job dispatched — final delivery completed by ${actor}.`,
          });
        }
      })().catch((err) => {
        console.error(`[quote-completion] last-mover auto-dispatch failed for quote ${quoteId}:`, err);
      });
    });
  }

  console.log(`[quote-completion] Quote ${quoteId} closed (trigger: ${opts.triggeringLeg} leg)`);
  return { closed: true };
}
