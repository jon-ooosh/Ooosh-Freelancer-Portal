/**
 * excess-preauth.ts — shared pre-auth reconciliation helpers.
 *
 * Used by the Stripe webhook (real-time) and the daily expiry scheduler
 * (housekeeping backstop). Keeps the "release a held pre-auth in OP" logic in
 * one place so both paths behave identically.
 */
import { query } from '../config/database';
import { syncExcessRequirementStatus } from './excess-requirement-sync';

/**
 * Mark a held pre-auth as released in OP (no Stripe call — caller has already
 * confirmed the hold is gone, or it's a card-machine hold that auto-voided).
 * No-op if the record isn't currently a held pre_auth. Returns true if it flipped.
 */
export async function markExcessReleased(excessId: string, reason: string): Promise<boolean> {
  const cur = await query(
    `SELECT job_id, amount_held, notes FROM job_excess
     WHERE id = $1 AND excess_status = 'pre_auth'`,
    [excessId]
  );
  if (cur.rows.length === 0) return false; // already actioned / not a hold

  const dateStr = new Date().toISOString().split('T')[0];
  const held = parseFloat(cur.rows[0].amount_held || '0');
  const note = `[${dateStr}] Hold released — ${reason}.`;
  const newNotes = cur.rows[0].notes ? `${cur.rows[0].notes}\n${note}` : note;

  await query(
    `UPDATE job_excess SET
      amount_released = COALESCE(amount_released, 0) + amount_held,
      amount_held     = 0,
      excess_status   = 'released',
      released_at     = NOW(),
      notes           = $2,
      updated_at      = NOW()
    WHERE id = $1 AND excess_status = 'pre_auth'`,
    [excessId, newNotes]
  );

  const jobId = cur.rows[0].job_id;
  if (jobId) {
    syncExcessRequirementStatus(jobId).catch((e) =>
      console.error('[excess-preauth] syncExcessRequirementStatus failed (release):', e)
    );
  }
  console.log(`[excess-preauth] Released hold ${excessId} (£${held.toFixed(2)}) — ${reason}`);
  return true;
}
