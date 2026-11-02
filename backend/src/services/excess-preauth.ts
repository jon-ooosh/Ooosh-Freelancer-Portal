/**
 * excess-preauth.ts — shared pre-auth reconciliation helpers.
 *
 * Used by the Stripe webhook (real-time) and the daily expiry scheduler
 * (housekeeping backstop). Keeps the "release a held pre-auth in OP" logic in
 * one place so both paths behave identically.
 */
import { query } from '../config/database';
import { syncExcessRequirementStatus } from './excess-requirement-sync';
import { ukToday } from './uk-date';

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

  const dateStr = ukToday();
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
    const { isStripeConfigured } = await import('../config/stripe');
    if (!isStripeConfigured()) return { changed: false, status: 'unknown', reason: 'stripe_not_configured' };
    try {
      const { stripeClientForPaymentIntent } = await import('./stripe-terminal');
      const pi = await (await stripeClientForPaymentIntent(r.stripe_payment_intent_id)).paymentIntents.retrieve(r.stripe_payment_intent_id);
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

// ── Recording a pre-auth hold on a record ─────────────────────────────────

export class PreauthRecordError extends Error {
  constructor(message: string, public status = 400, public detail?: string) { super(message); }
}

export interface RecordPreauthInput {
  excessId: string;
  amount: number;
  /** worldpay | amex | till_cash | stripe_gbp (the card reader is stripe_gbp + its PaymentIntent). */
  method: string;
  reference?: string | null;
  stripePaymentIntentId?: string | null;
  /** How long the hold lasts: days from now (the manual form), or an exact time (the card
   *  reader passes Stripe's `capture_before`). One of the two. */
  expiresInDays?: number;
  expiresAt?: Date | null;
  notes?: string | null;
  userId?: string | null;
  /** job_payments.source of the audit row. */
  source: string;
}

/**
 * Put a record into `pre_auth` — THE path for a hold OP records itself (the Manage
 * modal's "Record Pre-Auth", and the card reader). Lifted verbatim from
 * POST /excess/:id/record-preauth (Oct 2026) so the reader can't drift from it.
 *
 * Sets the hold in amount_held (NOT excess_amount_taken — no money is in our account
 * yet). No HireHop deposit — that happens at capture. Only valid from a "no money yet"
 * state (needed / pending); anything else throws PreauthRecordError (400).
 *
 * stripe_payment_intent_id is the load-bearing field for a Stripe-channel hold.
 * It is written to BOTH job_excess and the job_payments audit row, because:
 *   - Capture (422s without it) and Release (Stripe cancel) both need the PI.
 *   - services/stripe-preauth-reconciler.ts diffs live Stripe holds against those
 *     two columns, so a hold recorded WITHOUT the PI still reads as "unrecorded"
 *     and re-alerts info@ every morning until the hold expires.
 */
export async function recordPreauthHold(input: RecordPreauthInput): Promise<Record<string, unknown>> {
  const { excessId: id, amount, method, reference, stripePaymentIntentId, notes, userId, source } = input;

  const currentResult = await query(
    `SELECT je.*, j.hh_job_number FROM job_excess je
     LEFT JOIN jobs j ON j.id = je.job_id
     WHERE je.id = $1`,
    [id]
  );
  if (currentResult.rows.length === 0) throw new PreauthRecordError('Excess record not found', 404);
  const current = currentResult.rows[0];

  // Guard: only record a hold when there's no money/hold already on the record.
  // 'needed'/'pending' are the collectable pre-money states. Anything else
  // (taken, pre_auth, fully_claimed, etc.) means money or a hold is already
  // attached and a fresh hold would be ambiguous.
  const alreadyHeld = parseFloat(current.amount_held || '0');
  const alreadyTaken = parseFloat(current.excess_amount_taken || '0');
  if (!['needed', 'pending'].includes(current.excess_status) || alreadyHeld > 0 || alreadyTaken > 0) {
    throw new PreauthRecordError(
      'Cannot record a pre-auth on this record',
      400,
      `Status is "${current.excess_status}" with £${alreadyTaken.toFixed(2)} taken and £${alreadyHeld.toFixed(2)} held. Pre-auth holds can only be recorded on a record that is still Needed with nothing collected. If a hold already exists, capture or release it first.`,
    );
  }

  const holdDays = input.expiresInDays || 5;
  const expiresAt = input.expiresAt && !Number.isNaN(input.expiresAt.getTime()) ? input.expiresAt : null;
  // Only card-machine CARD methods produce a paper receipt to scan
  // (Worldpay/Amex). Stripe has an electronic trail; cash-held has no card
  // receipt — so neither flags a receipt as required.
  const needsReceipt = method === 'worldpay' || method === 'amex';

  const dateStr = ukToday();
  const expiryText = expiresAt
    ? `Expires ${expiresAt.toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' })}.`
    : `Expires in ${holdDays} days.`;
  const preauthNote = `[${dateStr}] Pre-auth hold of £${amount.toFixed(2)} recorded via ${method.replace(/_/g, ' ')}${reference ? ` (ref ${reference})` : ''}${notes ? `. ${notes}` : ''}. ${expiryText}`;
  const newNotes = current.notes ? `${current.notes}\n${preauthNote}` : preauthNote;

  const result = await query(
    `UPDATE job_excess SET
      amount_held              = $1,
      excess_amount_taken      = 0,
      excess_status            = 'pre_auth',
      held_at                  = NOW(),
      held_expires_at          = COALESCE($9::timestamptz, NOW() + ($2 || ' days')::interval),
      payment_method           = $3,
      payment_reference        = $4,
      stripe_payment_intent_id = COALESCE($5, stripe_payment_intent_id),
      receipt_required         = $6,
      notes                    = $7,
      updated_at               = NOW()
    WHERE id = $8
    RETURNING *`,
    [
      amount,                       // $1
      String(holdDays),             // $2
      method,                       // $3
      reference || null,            // $4
      stripePaymentIntentId || null, // $5
      needsReceipt,                 // $6
      newNotes,                     // $7
      id,                           // $8
      expiresAt ? expiresAt.toISOString() : null, // $9
    ]
  );

  // Audit row in job_payments (payment_status='pre_auth' — not completed). Keeps
  // the hold visible in payment history, consistent with the portal path in money.ts.
  //
  // stripe_payment_intent is populated deliberately: the Stripe → OP pre-auth
  // reconciler (services/stripe-preauth-reconciler.ts) diffs live Stripe holds
  // against BOTH job_excess.stripe_payment_intent_id and this column. Leaving it
  // null here meant a hold recorded by hand still read as "not present in OP"
  // and re-alerted info@ every morning.
  try {
    await query(
      `INSERT INTO job_payments
        (job_id, hirehop_job_id, payment_type, amount, payment_method,
         payment_reference, payment_status, source, excess_id,
         client_name, recorded_by, notes, stripe_payment_intent, payment_date)
       VALUES ($1, $2, 'excess', $3, $4, $5, 'pre_auth', $11, $6, $7, $8, $9, $10, NOW())`,
      [
        current.job_id,
        current.hh_job_number || null,
        amount,
        method,
        reference || null,
        id,
        current.client_name || null,
        userId || null,
        notes || `Pre-auth hold recorded (${expiresAt ? expiryText.toLowerCase().replace(/\.$/, '') : `expires ${holdDays}d`})`,
        stripePaymentIntentId || null,
        source,
      ]
    );
  } catch (err) {
    console.error('[excess] Failed to insert job_payments row for pre-auth (non-fatal):', err);
  }

  // Held money counts as coverage — sync requirement status.
  if (current.job_id) {
    syncExcessRequirementStatus(current.job_id).catch(e =>
      console.error('[excess] syncExcessRequirementStatus failed (record-preauth):', e)
    );
  }

  console.log(`[excess] Pre-auth recorded: ${id}, £${amount} held via ${method}, ${expiresAt ? `expires ${expiresAt.toISOString()}` : `expires ${holdDays}d`}`);
  return result.rows[0];
}

// ── May this hire have a pre-auth now? ────────────────────────────────────

export interface PreauthEligibility {
  allowed: boolean;
  /** 'ok' | 'long_hire' | 'too_early' | 'too_late' | 'no_dates' */
  code: string;
  /** In words, for the Manage modal. */
  reason: string;
  hireDays: number | null;
  daysFromNowToEnd: number | null;
}

/**
 * The payment portal's pre-auth rule, copied exactly (netlify-functions
 * `get-job-details-v2.js` determineExcessPaymentTiming — jon, 16 Oct 2026: "copy
 * exactly what we have" before deviating). A hire of 4 days or fewer may be
 * pre-authed, and only once the hold can last until the hire ends: no more than 5
 * days from now to the end. Anything else is a payment. Day counts round UP, as there.
 * Used by the card reader; the manual "Record Pre-Auth" form is not gated by it.
 */
export function preauthEligibility(start: Date | string | null | undefined, end: Date | string | null | undefined, now: Date = new Date()): PreauthEligibility {
  const s = start ? new Date(start) : null;
  const e = end ? new Date(end) : null;
  if (!s || !e || Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    return { allowed: false, code: 'no_dates', reason: 'The job has no hire dates, so a pre-auth can\'t be offered. Take a payment.', hireDays: null, daysFromNowToEnd: null };
  }
  const DAY = 1000 * 60 * 60 * 24;
  const hireDays = Math.ceil((e.getTime() - s.getTime()) / DAY);
  const daysFromNowToEnd = Math.ceil((e.getTime() - now.getTime()) / DAY);
  if (hireDays > 4) {
    return { allowed: false, code: 'long_hire', reason: `This hire is ${hireDays} days. Pre-auths are for hires of 4 days or fewer, so take a payment.`, hireDays, daysFromNowToEnd };
  }
  if (daysFromNowToEnd > 5) {
    const from = new Date(e.getTime() - 5 * DAY);
    const fromText = from.toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' });
    return { allowed: false, code: 'too_early', reason: `Too early for a pre-auth: it would expire before the hire ends. Available from ${fromText}, or take a payment now.`, hireDays, daysFromNowToEnd };
  }
  if (daysFromNowToEnd < 0) {
    return { allowed: false, code: 'too_late', reason: 'The hire has ended, so take a payment.', hireDays, daysFromNowToEnd };
  }
  return { allowed: true, code: 'ok', reason: 'Short hire within the pre-auth window.', hireDays, daysFromNowToEnd };
}
