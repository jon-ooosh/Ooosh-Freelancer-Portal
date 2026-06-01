-- 099_excess_refund_legs.sql
-- Refund-leg ledger on job_excess for cross-source idempotency (Jun 2026).
--
-- One Stripe refund can arrive on OP via two paths in parallel (the portal's
-- payment-event AND Stripe's charge.refunded webhook). Both call the shared
-- `unwindRefundOnExcess()` helper; without a stable dedup ledger they'd
-- double-apply.
--
-- Each leg: { source, ref, amount, at }. Dedup key is (source, ref). New
-- entry-points (HH passive reconciliation, manual) write through the same
-- helper so the ledger covers every path.

BEGIN;

ALTER TABLE job_excess
  ADD COLUMN IF NOT EXISTS refund_legs JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
