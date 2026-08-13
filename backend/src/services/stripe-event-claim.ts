// stripe-event-claim.ts — atomic Stripe-event idempotency for the Payment Portal.
//
// The Payment Portal (netlify-functions/handle-stripe-webhook.js) claims a Stripe
// event id here BEFORE it creates a HireHop deposit, so a Stripe re-delivery (of the
// SAME event) can never produce a duplicate deposit / duplicate OP payment record /
// duplicate client email. See migration 188 + the job-16513 incident writeup.
//
// Why this lives in OP (not the portal): Netlify functions are stateless, so a durable
// atomic claim needs a shared store. OP's Postgres is that store — and crucially it is
// UNAFFECTED by the HireHop 327 storms that caused the incident (the storm only slows HH
// calls, never OP's own DB), so the claim is always fast and reliable.
//
// Lifecycle of a stripe_events row for a portal event:
//   1. claimStripeEvent()          → row inserted, processed_at NULL, claimed_at NOW()
//   2. recordStripeEventDeposit()  → hh_deposit_id stamped (right after the portal makes
//                                     the HireHop deposit) so a retry reuses it
//   3. markStripeEventProcessed()  → processed_at stamped (payment-event finished cleanly)
//
// A duplicate delivery arriving while (1)–(3) are in flight (or already complete) gets
// `proceed: false` and the portal no-ops.

import { query } from '../config/database';

// How long a claimed-but-unprocessed row is treated as "in flight" before a later delivery
// is allowed to reclaim it (assume the prior attempt died). Concurrent duplicate deliveries
// caused by a Stripe ack timeout arrive ~10-20s apart, so 60s comfortably backs the duplicate
// off; a genuinely-failed prior attempt is picked up by the next Stripe retry after the window.
const STALE_CLAIM_SECONDS = 60;

export interface ClaimResult {
  /** true = caller owns this event and should do the work; false = already handled / in flight. */
  proceed: boolean;
  /** true only when the row exists AND processed_at is set (fully handled before). */
  alreadyProcessed: boolean;
  /** HireHop deposit id recorded for this event by a prior attempt, if any (reuse it). */
  hhDepositId: number | null;
}

/**
 * Atomically claim a Stripe event id for processing.
 *
 * One statement: INSERT the row, or (on conflict) reclaim it ONLY if it's unprocessed and
 * the previous claim has gone stale. `RETURNING` yields a row exactly when we won the claim
 * (fresh insert OR stale-reclaim). No row returned ⇒ someone else holds it or it's done.
 */
export async function claimStripeEvent(eventId: string, type: string): Promise<ClaimResult> {
  const claim = await query(
    `INSERT INTO stripe_events (id, type, claimed_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE
       SET claimed_at = NOW()
       WHERE stripe_events.processed_at IS NULL
         AND stripe_events.claimed_at < NOW() - ($3 || ' seconds')::interval
     RETURNING id, hh_deposit_id`,
    [eventId, type, String(STALE_CLAIM_SECONDS)]
  );

  if (claim.rows.length > 0) {
    // We won the claim (fresh insert or stale reclaim). Reuse any deposit a prior attempt made.
    return {
      proceed: true,
      alreadyProcessed: false,
      hhDepositId: claim.rows[0].hh_deposit_id ?? null,
    };
  }

  // Conflict without a claim: the row exists and is either already processed or still in flight.
  const existing = await query(
    `SELECT processed_at, hh_deposit_id FROM stripe_events WHERE id = $1`,
    [eventId]
  );
  const row = existing.rows[0];
  return {
    proceed: false,
    alreadyProcessed: Boolean(row?.processed_at),
    hhDepositId: row?.hh_deposit_id ?? null,
  };
}

/** Record the HireHop deposit id created for this event (idempotent; only fills a NULL). */
export async function recordStripeEventDeposit(eventId: string, hhDepositId: number): Promise<void> {
  await query(
    `UPDATE stripe_events
        SET hh_deposit_id = COALESCE(hh_deposit_id, $2)
      WHERE id = $1`,
    [eventId, hhDepositId]
  );
}

/**
 * Mark the event fully processed. Terminal — a future delivery short-circuits as a dedup.
 * Upserts so a path that passes stripe_event_id WITHOUT pre-claiming (e.g. the pre-auth path,
 * which creates no deposit) still records the event, so its duplicates dedup too.
 */
export async function markStripeEventProcessed(
  eventId: string,
  opts: { type?: string; hhDepositId?: number | null } = {}
): Promise<void> {
  await query(
    `INSERT INTO stripe_events (id, type, processed_at, hh_deposit_id)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (id) DO UPDATE
       SET processed_at  = COALESCE(stripe_events.processed_at, NOW()),
           hh_deposit_id = COALESCE(stripe_events.hh_deposit_id, EXCLUDED.hh_deposit_id)`,
    [eventId, opts.type ?? 'payment_event', opts.hhDepositId ?? null]
  );
}

/**
 * Check whether an event id is already fully processed WITHOUT claiming it.
 * Used at the top of payment-event: a portal event the portal already claimed will be
 * `processed_at IS NULL` here (the portal claims but doesn't mark processed — OP does that
 * at the end of payment-event), so this only short-circuits genuine re-deliveries of an
 * event whose payment-event already ran to completion.
 */
export async function isStripeEventProcessed(eventId: string): Promise<boolean> {
  const res = await query(
    `SELECT processed_at FROM stripe_events WHERE id = $1`,
    [eventId]
  );
  return Boolean(res.rows[0]?.processed_at);
}
