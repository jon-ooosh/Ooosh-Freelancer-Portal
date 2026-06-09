/**
 * Derived merch (incoming-delivery) requirement status.
 *
 * The pre-hire `merch` requirement is NOT hand-ticked — it's a reflection of the
 * actual `held_items` on the job (same model as excess_resolve). This kills the
 * staleness problem: the pip can't drift from reality because it's recomputed
 * from the items every time one changes.
 *
 * The pip answers one question: "is there anything we're holding or still
 * awaiting for this client that we haven't handed over yet?"
 *   - grey  (not_started): no incoming items logged
 *   - amber (in_progress): anything still `expected` (awaited) OR here-not-given
 *   - green (done):        everything given / shipped / disposed (closed)
 *
 * "All given = green" is deliberately honest: we never claim everything has
 * arrived (more can always turn up). If a surprise parcel is logged after the
 * pip went green, it re-opens to amber automatically. Cancelled items ("that's
 * all that's coming") drop out of the calculation entirely.
 *
 * See docs/HOLDING-MODULE-SPEC.md / CLAUDE.md Holding section.
 */
import { query } from '../config/database';

const HERE_STATES = ['arrived', 'stored', 'client_notified', 'collection_arranged'];
const CLOSED_STATES = ['given_to_client', 'shipped_back', 'disposed'];

export async function syncMerchRequirementStatus(jobId: string): Promise<void> {
  if (!jobId) return;

  // Incoming items that still "count" (cancelled = won't-arrive, excluded)
  const rows = (await query(
    `SELECT status FROM held_items
     WHERE job_id = $1 AND kind = 'incoming' AND status <> 'cancelled'`,
    [jobId],
  )).rows as { status: string }[];

  // Ensure a merch requirement row exists once there's anything to track.
  const reqRes = await query(
    `SELECT id, status FROM job_requirements
     WHERE job_id = $1 AND requirement_type = 'merch' AND phase = 'pre_hire'`,
    [jobId],
  );

  if (rows.length === 0) {
    // Nothing (or everything cancelled) — leave an existing card at not_started,
    // don't create one from thin air.
    if (reqRes.rows.length > 0 && reqRes.rows[0].status !== 'not_started') {
      await query(
        `UPDATE job_requirements SET status = 'not_started',
            notes = 'No incoming items logged', updated_at = NOW() WHERE id = $1`,
        [reqRes.rows[0].id],
      );
    }
    return;
  }

  const here = rows.filter((r) => HERE_STATES.includes(r.status)).length;
  const awaited = rows.filter((r) => r.status === 'expected').length;
  const allClosed = rows.every((r) => CLOSED_STATES.includes(r.status));
  const status = allClosed ? 'done' : 'in_progress';

  const parts: string[] = [];
  if (here > 0) parts.push(`${here} here to give`);
  if (awaited > 0) parts.push(`${awaited} awaited`);
  if (allClosed) parts.push('all given to client');
  const notes = parts.join(' · ') || 'Incoming items tracked in Holding';

  if (reqRes.rows.length === 0) {
    await query(
      `INSERT INTO job_requirements (job_id, requirement_type, status, notes, is_auto, source, phase)
       VALUES ($1, 'merch', $2, $3, true, 'holding', 'pre_hire')`,
      [jobId, status, notes],
    );
  } else {
    await query(
      `UPDATE job_requirements SET status = $1, notes = $2, updated_at = NOW() WHERE id = $3`,
      [status, notes, reqRes.rows[0].id],
    );
  }
}
