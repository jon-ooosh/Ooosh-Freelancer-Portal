-- 188_stripe_event_dedup.sql
-- Stripe webhook idempotency, extended for the Payment Portal (job 16513, Aug 2026).
--
-- `stripe_events` was created in migration 098 as an idempotency log for OP's OWN
-- inbound Stripe webhook (payment_intent.canceled, charge.dispute.*, charge.refunded).
-- The Payment Portal (netlify-functions/handle-stripe-webhook.js) processes a DIFFERENT
-- set of events (checkout.session.completed → HireHop deposit + OP payment-event).
--
-- On 11 Aug 2026 (job 16513) a HireHop 327 rate-limit storm made OP's payment-event take
-- ~19s to return; the portal awaits that before acking Stripe, blew Stripe's ack timeout,
-- Stripe re-delivered the same event, and the portal replayed its whole handler → a SECOND
-- HireHop deposit (9007) for one £146.83 charge. Neither side deduped on the Stripe event id.
--
-- This migration turns `stripe_events` into the shared atomic dedup store the portal claims
-- against BEFORE it creates the HireHop deposit. Because it's a Postgres claim, it is immune
-- to HireHop 327 storms (the storm only slows HH calls, not OP's own DB).
--
--   claimed_at    — when the row was (re)claimed. Drives the "in-flight vs dead prior attempt"
--                   staleness decision so a concurrent duplicate delivery backs off while a
--                   genuinely-failed prior attempt can be retried after the window.
--   hh_deposit_id — the HireHop deposit the portal created for this event, so a Stripe retry
--                   reuses it instead of creating a duplicate.
--
-- Existing 098 consumers (OP's own webhook) are untouched: claimed_at defaults to NOW() on
-- their INSERTs, hh_deposit_id stays NULL, and their DO NOTHING / processed_at logic is
-- unaffected.

BEGIN;

ALTER TABLE stripe_events
  ADD COLUMN IF NOT EXISTS claimed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS hh_deposit_id BIGINT;

COMMIT;
