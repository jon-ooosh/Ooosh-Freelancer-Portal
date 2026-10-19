-- 156_quote_legs.sql
--
-- Leg-based completion tracking for portal D&C quotes.
--
-- A freelancer D&C job can involve a VAN leg (book-out / check-in on OP) and/or
-- an EQUIPMENT leg (portal /complete checklist). The /start wizard already asks
-- "van only / backline only / both" — that IS the declaration of which legs the
-- job has. We persist that declaration here, then record each leg's completion
-- server-side as it happens, and auto-close the quote when the last required
-- leg lands — INDEPENDENT of whether the freelancer's browser makes it back
-- across the OP↔portal domain boundary.
--
-- Why: van-only deliveries used to close only when the browser returned to the
-- portal /complete after the OP book-out. When it didn't (Tobi, HH 15669, 2 Jul
-- 2026), the quote sat un-completed and the completion chaser nagged all night.
-- With the van book-out stamping van_leg_done_at + closing the quote directly,
-- no return hop is required.
--
-- requires_* semantics:
--   true  = this leg is part of the job and must complete before the quote closes
--   false = explicitly NOT part of the job (e.g. equipment on a van-only delivery)
--   NULL  = not declared (legacy quote that never hit the new /start). maybeCloseQuote
--           falls back to legacy behaviour for these — see services/quote-completion.ts.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS requires_van_leg       BOOLEAN,
  ADD COLUMN IF NOT EXISTS requires_equipment_leg BOOLEAN,
  ADD COLUMN IF NOT EXISTS van_leg_done_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS equipment_leg_done_at  TIMESTAMPTZ;
