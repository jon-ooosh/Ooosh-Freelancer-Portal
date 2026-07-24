-- 169: Auto-cover excess from a client's held-on-account balance (opt-in, admin-set)
--
-- Some regular clients leave a standing insurance-excess deposit with us and
-- expect it to cover hire after hire rather than paying fresh excess each time
-- (e.g. The Hoosiers / Crab Race, The Wedding Present — historic Stripe/pre-HireHop
-- money that's past any card-refund window and will only ever be returned by BACS).
--
-- This flag opts a client's self-drive hires into being auto-covered from that
-- held balance. When set, the HH requirement-derivation engine marks a new hire's
-- excess as covered (status 'waived' + a '[Auto-covered by account]' marker note)
-- as long as the client's held-on-account balance is sufficient — no fresh excess
-- collected, no dispatch-gate / close-out nag, no per-hire staff action. It's a
-- STANDING cover: the held balance is not consumed, it stays held and is returned
-- (by BACS) when the client stops. See services/hh-requirement-derivation.ts.
--
-- Opt-in, per-client, ADMIN-ONLY (toggled via POST /api/organisations/:id/auto-cover-excess).
-- Deliberately NOT global: only explicitly-enabled clients ever stop collecting
-- excess, so a stray held record can never silently drop a client's cover.
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS auto_cover_excess_from_account BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_cover_excess_set_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_cover_excess_set_by        VARCHAR(255);
