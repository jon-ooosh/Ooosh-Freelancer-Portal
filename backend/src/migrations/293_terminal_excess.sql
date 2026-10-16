-- 293: card-reader excess payments and pre-auths (docs/STRIPE-TERMINAL-SPEC.md §13, Phase 2).
--
--   excess_id       the job_excess record an excess payment / pre-auth lands on
--   capture_before  a pre-auth's real expiry, from Stripe (charge.payment_method_details
--                   .card_present.capture_before) — also written to job_excess.held_expires_at
--   warning         something staff must read on the result screen (e.g. the pre-auth
--                   expires before the hire ends)
-- payment_type gains 'excess' and 'excess_preauth' (it is VARCHAR, no constraint to change).
ALTER TABLE terminal_sessions
  ADD COLUMN IF NOT EXISTS excess_id      UUID REFERENCES job_excess(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS capture_before TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS warning        TEXT;
