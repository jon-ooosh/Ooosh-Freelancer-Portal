-- ============================================================================
-- Hire form: declarations that don't refer, and the address-mismatch choice
-- (Oct 2026).
--
-- 1. The insurance questions follow the Markerstudy referencing guide (Feb
--    2026). The guide wants every driver's convictions and claims from the
--    last 5 years on record, but most of them are acceptable WITHOUT a
--    referral (two 3-point convictions; one fault claim). Each question used
--    to be a single yes/no where any "yes" raised a referral, so the form
--    either under-asked or over-referred. Each topic is now split:
--
--      has_recent_convictions  any motoring conviction in 5 years — RECORDED,
--                              never refers on its own. UK points are still
--                              priced by the DVLA check (licence-excess.ts).
--      has_convictions         (existing) the referral one: ever DD/BA/UT, or
--                              a single 6+ point offence in 5 years other
--                              than SP30/SP50/CU80.
--      has_accidents           (existing, meaning WIDENED) any motor accident
--                              or claim in 5 years — now RECORDED only.
--      has_fault_claims        the referral one: more than one that was the
--                              driver's fault or is still open.
--
--    NULL on the two new columns means the driver last answered the OLD
--    question set — the hire form uses that to avoid pre-filling old answers
--    under the new wording, and referral reasons use it to read
--    has_accidents the old way (a referral) or the new way (a declaration).
--
-- 2. address_mismatch: the driver said their proofs of address show a
--    different address from their licence. Agreed with the broker: a UK
--    driver in that position also supplies a passport. The choice used to
--    live only in the driver's browser tab, so a driver who came back in a
--    new tab after their POAs was routed past the passport step. NULL = never
--    asked.
-- ============================================================================

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_recent_convictions BOOLEAN;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_fault_claims BOOLEAN;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS address_mismatch BOOLEAN;
