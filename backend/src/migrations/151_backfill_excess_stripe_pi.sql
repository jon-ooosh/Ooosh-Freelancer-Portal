-- 151_backfill_excess_stripe_pi.sql
--
-- Backfill job_excess.stripe_payment_intent_id from payment_reference for every
-- record where the canonical PI column is blank but payment_reference holds a
-- pi_ value.
--
-- Why: the payment portal's straight-charge (non-pre-auth) collection path only
-- ever wrote the Stripe PaymentIntent into payment_reference, NOT into the
-- dedicated stripe_payment_intent_id column. Migration 087's original backfill
-- was a one-shot at migration time, so every excess collected since then landed
-- with a NULL column. The OP-initiated Stripe reimburse path reads ONLY that
-- column, so reimbursing one of these records silently no-op'd the Stripe API
-- call while still recording the reimbursement in OP + HireHop and emailing the
-- client (the silent-swallow bug — jobs 15433/15489/15544/15781/15235/15358/
-- 15503/15996, Jun 2026).
--
-- This re-runs the 087 backfill so the in-flight pipeline of not-yet-reimbursed
-- excesses can refund cleanly when their time comes. The reimburse handler now
-- also falls back to payment_reference at runtime, but populating the column up
-- front keeps the charge.refunded webhook matching + future ops correct.
--
-- Touches no money, changes no status — fills in one column only. Idempotent.

UPDATE job_excess
SET stripe_payment_intent_id = payment_reference,
    updated_at = NOW()
WHERE stripe_payment_intent_id IS NULL
  AND payment_reference ~ '^pi_[A-Za-z0-9]+$';
