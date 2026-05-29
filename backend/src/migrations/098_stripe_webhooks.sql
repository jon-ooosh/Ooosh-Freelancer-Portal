-- 098_stripe_webhooks.sql
-- Stripe webhook receiver + dispute tracking (PR 4, May 2026)
--
-- `stripe_events` — idempotency log for the inbound webhook. Stripe can deliver
-- the same event more than once; we process each event id at most once. A row
-- exists once received; `processed_at` is stamped only after the handler
-- succeeds, so a failed handler (returns 500 → Stripe retries) reprocesses.
--
-- Dispute tracking on `job_excess` — chargebacks arrive ONLY via webhook
-- (out-of-band). We flag the excess so it surfaces on the Money tab, and email
-- info@. `dispute_status`: 'open' while live, 'won'/'lost' when closed.

BEGIN;

CREATE TABLE IF NOT EXISTS stripe_events (
  id           TEXT PRIMARY KEY,         -- Stripe event id (evt_...)
  type         TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

ALTER TABLE job_excess
  ADD COLUMN IF NOT EXISTS dispute_status VARCHAR(20),   -- NULL | 'open' | 'won' | 'lost'
  ADD COLUMN IF NOT EXISTS disputed_at    TIMESTAMPTZ;

COMMIT;
