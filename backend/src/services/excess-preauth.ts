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

export type PreauthReconcileStatus =
  | 'released'      // hold confirmed gone → flipped to released in OP
  | 'still_held'    // hold genuinely still live (Stripe says so, or card within window)
  | 'not_preauth'   // record isn't a held pre_auth (already actioned / not found)
  | 'unknown';      // couldn't determine (Stripe unreachable / not configured)

export interface PreauthReconcileResult {
  changed: boolean;              // did the OP record flip to released?
  status: PreauthReconcileStatus;
  stripeStatus?: string;         // raw Stripe PI status when we could read it
  reason?: string;
}

/**
 * Reconcile ONE pre-auth record against the truth (Stripe for online holds; the
 * 5-day window for card-machine holds). This is the single-record engine behind
 * the nightly sweep, the on-demand "Check hold status" button, and the
 * opportunistic self-heal on Money-tab / Overview load.
 *
 * Binary by design — it never leaves a record in a "maybe" state: it either
 * confirms the hold is gone (→ released) or confirms it's still live (→ still_held).
 * The only non-committal outcome is `unknown` (Stripe not configured / unreachable),
 * in which case we leave the record untouched rather than guess.
 *
 * NEVER pre-empts a Stripe hold Stripe still considers live — their auth window
 * can run to ~7 days, longer than our conservative 5-day model.
 */
export async function reconcileExcessPreauth(excessId: string): Promise<PreauthReconcileResult> {
  const cur = await query(
    `SELECT id, payment_method, stripe_payment_intent_id, excess_status, held_expires_at
     FROM job_excess WHERE id = $1`,
    [excessId]
  );
  if (cur.rows.length === 0) return { changed: false, status: 'not_preauth', reason: 'not_found' };
  const r = cur.rows[0];
  if (r.excess_status !== 'pre_auth') return { changed: false, status: 'not_preauth' };

  const pastExpiry = r.held_expires_at != null && new Date(r.held_expires_at).getTime() < Date.now();

  // ── Stripe channel — ask Stripe for the real state ──
  if (r.payment_method === 'stripe_gbp' && r.stripe_payment_intent_id) {
    const { getStripeClient, isStripeConfigured } = await import('../config/stripe');
    if (!isStripeConfigured()) return { changed: false, status: 'unknown', reason: 'stripe_not_configured' };
    try {
      const pi = await getStripeClient().paymentIntents.retrieve(r.stripe_payment_intent_id);
      if (pi.status === 'canceled') {
        const flipped = await markExcessReleased(excessId, 'Stripe hold canceled (reconciled)');
        return { changed: flipped, status: 'released', stripeStatus: pi.status };
      }
      // requires_capture / processing / etc. → Stripe still holds it. Genuinely live.
      return { changed: false, status: 'still_held', stripeStatus: pi.status };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[excess-preauth] Stripe PI retrieve failed for excess ${excessId}:`, msg);
      return { changed: false, status: 'unknown', reason: msg };
    }
  }

  // ── Card-machine / cash — can't query the acquirer. Past the 5-day window it
  //    has auto-voided and can no longer be captured, so release. Within the
  //    window it's still live. ──
  if (r.payment_method === 'stripe_gbp' && !r.stripe_payment_intent_id) {
    // Stripe method but no PI on record — nothing to query; Stripe will auto-void.
    if (pastExpiry) {
      const flipped = await markExcessReleased(excessId, 'Stripe hold expired, no PI on record (reconciled)');
      return { changed: flipped, status: 'released', reason: 'stripe_no_pi_expired' };
    }
    return { changed: false, status: 'still_held', reason: 'stripe_no_pi_within_window' };
  }
  if (pastExpiry) {
    const flipped = await markExcessReleased(excessId, 'Card-machine hold expired (5-day window elapsed, reconciled)');
    return { changed: flipped, status: 'released', reason: 'card_window_elapsed' };
  }
  return { changed: false, status: 'still_held', reason: 'card_within_window' };
}

/**
 * Opportunistic self-heal — reconcile every EXPIRED pre-auth on a job. Called
 * fire-and-forget from the Money-tab summary + excess-info loads so a stuck
 * past-expiry hold resolves to its true state on view, without waiting for the
 * nightly sweep. Non-blocking: callers must not await the page render on it.
 * Only touches records past their window, so in-window holds cost zero Stripe calls.
 */
export async function reconcileExpiredPreauthsForJob(jobId: string): Promise<number> {
  const rows = await query(
    `SELECT id FROM job_excess
     WHERE job_id = $1 AND excess_status = 'pre_auth'
       AND held_expires_at IS NOT NULL AND held_expires_at < NOW()`,
    [jobId]
  );
  let changed = 0;
  for (const row of rows.rows as Array<{ id: string }>) {
    try {
      const r = await reconcileExcessPreauth(row.id);
      if (r.changed) changed++;
    } catch (e) {
      console.error('[excess-preauth] job reconcile failed for', row.id, e);
    }
  }
  return changed;
}
