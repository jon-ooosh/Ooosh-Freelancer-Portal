-- 087_preauth_lifecycle.sql
-- Pre-auth lifecycle restructure (May 2026)
--
-- Separates "money we have a promise of" (held — pre-auth) from "money in our account"
-- (taken — captured payment). Before this migration, both states were conflated in
-- excess_amount_taken with the only distinction being excess_status='pre_auth' as a
-- label. That broke downstream logic — claim flow assumed real money, reimburse flow
-- tried to refund money that was never captured, balance reporting overstated cash by
-- the value of every active pre-auth.
--
-- New model:
--   amount_held              — money on hold via pre-auth (Stripe or card-machine)
--   excess_amount_taken      — money actually in our bank account (real, claimable)
--   amount_released          — money that was held but auto-released without capture
--                              (Stripe auto-voids residual after partial capture; full
--                               release on expiry; explicit void via /release endpoint)
--
--   held_at                  — when the hold was created
--   held_expires_at          — when we expect it to auto-release (5 days standardised
--                              across Stripe + Worldpay + Amex for simplicity)
--   released_at              — when the release actually happened (terminal)
--
--   stripe_payment_intent_id — direct reference for Stripe capture/cancel API calls
--                              (avoids memo-mining the HH deposit description)
--
--   receipt_required         — TRUE for card-machine methods (worldpay/amex/cash);
--   receipt_uploaded_at      — surfaces as amber "outstanding to-do" banner until set
--
-- New status:
--   'released' — pre-auth voided without capture (terminal state)
--
-- Lifecycle outcomes for a pre-auth:
--   1. Capture full → status='taken', amount_held=0, amount_taken=full
--   2. Capture partial → status='taken' (or fully_claimed), amount_held=0,
--                        amount_taken=captured, amount_released=residual
--   3. Void / expire → status='released', amount_held=0, amount_released=full,
--                      amount_taken=0
--
-- See CLAUDE.md "Excess Pre-Auth Lifecycle" section for full design notes.

BEGIN;

-- ── New columns ────────────────────────────────────────────────────────────────

ALTER TABLE job_excess
  ADD COLUMN IF NOT EXISTS amount_held              DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_released          DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS held_at                  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS held_expires_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS released_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS receipt_required         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS receipt_uploaded_at      TIMESTAMPTZ;

-- ── Indexes ────────────────────────────────────────────────────────────────────

-- Expiry scheduler will scan held records nearing held_expires_at
CREATE INDEX IF NOT EXISTS idx_job_excess_held_expires
  ON job_excess(held_expires_at)
  WHERE excess_status = 'pre_auth' AND held_expires_at IS NOT NULL;

-- Stripe webhook receiver needs fast lookup by PI when events arrive
CREATE INDEX IF NOT EXISTS idx_job_excess_stripe_pi
  ON job_excess(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- Receipt-outstanding NeedsAttention bucket query
CREATE INDEX IF NOT EXISTS idx_job_excess_receipt_required
  ON job_excess(receipt_required)
  WHERE receipt_required = TRUE AND receipt_uploaded_at IS NULL;

-- ── Backfill: migrate existing pre_auth records → 'released' ────────────────────
--
-- As of May 2026 query: 10 records in pre_auth status, all >5 days old. Stripe will
-- have auto-voided every hold weeks ago — the £12,000 sitting in excess_amount_taken
-- across these records is phantom money (OP thought it was held, the cards have long
-- since released).
--
-- All 10 have a valid pi_ reference in payment_reference (no nulls).
-- All 10 were stripe_gbp method.
--
-- Migration:
--   - amount_held = previous excess_amount_taken (preserve the historical hold value)
--   - amount_released = previous excess_amount_taken (Stripe released it all)
--   - excess_amount_taken = 0 (no money was ever captured)
--   - excess_status = 'released'
--   - stripe_payment_intent_id = payment_reference (lift the pi_ value into the new column)
--   - held_at = created_at, held_expires_at = created_at + 5 days, released_at = NOW()
--   - audit note in notes column

UPDATE job_excess
SET
  amount_held              = excess_amount_taken,
  amount_released          = excess_amount_taken,
  excess_amount_taken      = 0,
  held_at                  = created_at,
  held_expires_at          = created_at + INTERVAL '5 days',
  released_at              = NOW(),
  excess_status            = 'released',
  stripe_payment_intent_id = CASE
                               WHEN payment_reference LIKE 'pi_%' THEN payment_reference
                               ELSE NULL
                             END,
  notes                    = TRIM(BOTH FROM (
                               COALESCE(notes, '') ||
                               ' [Migrated 087: pre-auth >5d old at migration time, Stripe auto-released before new model went live]'
                             ))
WHERE excess_status = 'pre_auth';

-- ── Backfill: stripe_payment_intent_id on all records with pi_ in payment_reference ──
-- Catches taken/partially_paid/etc. records that came in via Stripe but where the PI
-- only lived in payment_reference. Future Stripe webhook routing needs this.

UPDATE job_excess
SET stripe_payment_intent_id = payment_reference
WHERE payment_reference LIKE 'pi_%'
  AND stripe_payment_intent_id IS NULL;

-- ── Normalise legacy 'pending' → 'needed' ───────────────────────────────────────
-- 21 production records have excess_status='pending' (legacy value from before the
-- 038 enum rename). Two derivation paths writing different values for the same
-- conceptual state. Pick 'needed' as the canonical name.

UPDATE job_excess
SET excess_status = 'needed'
WHERE excess_status = 'pending';

-- ── Backfill: receipt_required for existing card-machine excess ─────────────────
-- For records where money is actually present (taken or downstream states) AND was
-- collected via a physical card machine or cash, flag receipt as required. These
-- will surface as "receipt scan outstanding" in the new UI (PR 2) until staff
-- uploads the scan. Stripe and bank-transfer methods have electronic trails so
-- don't need a paper receipt.

UPDATE job_excess
SET receipt_required = TRUE
WHERE payment_method IN ('worldpay', 'amex', 'till_cash')
  AND excess_status IN ('taken', 'partially_paid', 'partially_reimbursed',
                        'reimbursed', 'fully_claimed', 'rolled_over');

COMMIT;
