-- 192 — Driver document validity: FROM dates as the single input, windows derived
--
-- THE PROBLEM THIS FIXES (job 16291 / Peter Christopherson, 19 Aug 2026)
-- ---------------------------------------------------------------------
-- Driver document validity was stored TWICE, in two families of columns, with
-- six consumers split across them and no code keeping them in step:
--
--   * CHECK dates  — idenfy_check_date, dvla_check_date  (window derived +90d/+30d)
--   * VALID-UNTIL  — licence_valid_to, dvla_valid_until, poa*_valid_until
--
-- The hire-form ROUTER and the driver-detail PILLS read the check dates. The
-- drivers list, the assign-driver picker and the hard book-out gate read the
-- valid-until columns. Neither `dvla_valid_until` nor `licence_valid_to` was
-- editable anywhere in the OP UI, and nothing except the driver's own DVLA
-- upload ever wrote `dvla_valid_until`. So every staff-side fix moved the
-- displayed pill and left the gate reading a stale value — a driver could show
-- green on their own page and be hard-400'd out of the assign picker.
--
-- THE MODEL FROM HERE
-- -------------------
-- Staff and the hire form only ever set a FROM date (the day the document was
-- issued / the check was run — by far the easiest thing to read off a
-- document). OP derives the expiry. Both are displayed.
--
--   group     FROM (input)          doc's own expiry (input)   derived window (OP-written)
--   -------   -------------------   ------------------------   ---------------------------
--   licence   idenfy_check_date     licence_valid_to           licence_check_valid_until  (NEW)
--   dvla      dvla_check_date       —                          dvla_valid_until
--   poa1      poa1_doc_date (NEW)   —                          poa1_valid_until
--   poa2      poa2_doc_date (NEW)   —                          poa2_valid_until
--   passport  passport_check_date   passport_expiry (NEW)      passport_valid_until
--             (NEW)
--
-- Windows: licence = min(from+90d, licence_valid_to); dvla = from+30d;
-- poa = from+90d; passport = min(from+30d, passport_expiry).
--
-- The `*_valid_until` columns are now DERIVED — written only by
-- services/driver-validity.ts on every driver write. Do not set them by hand
-- and do not add a new writer: set the FROM date and let the service derive.
-- They stay as real stored columns (rather than moving the arithmetic into the
-- app) so the existing SQL consumers — the drivers-list status CASE, the
-- assign-driver picker, the quick-assign gate — keep working unchanged and
-- simply become correct.
--
-- BACKFILL IS DELIBERATELY VALUE-PRESERVING
-- -----------------------------------------
-- Each FROM date is back-computed from the existing window so that re-deriving
-- reproduces exactly the value already stored. No driver's effective validity
-- moves on deploy, and nobody's gate status changes. The FROM date simply
-- becomes the field staff edit from now on.
--
-- licence_check_valid_until is the one genuinely new window. It is populated
-- here for VISIBILITY only — this migration ships alongside display changes,
-- NOT a gate-policy change. The picker and the book-out gate continue to read
-- `licence_valid_to` (the physical licence expiry) exactly as before. Tightening
-- them to the check window is a separate, deliberate decision because it would
-- newly red-flag drivers whose iDenfy check has aged past 90 days.

-- ── FROM dates ──────────────────────────────────────────────────────────────
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS poa1_doc_date       DATE,
  ADD COLUMN IF NOT EXISTS poa2_doc_date       DATE,
  ADD COLUMN IF NOT EXISTS passport_check_date DATE,
  ADD COLUMN IF NOT EXISTS passport_expiry     DATE;

-- ── Derived licence check window ────────────────────────────────────────────
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS licence_check_valid_until DATE;

COMMENT ON COLUMN drivers.poa1_doc_date IS
  'Date on proof-of-address document 1. INPUT — poa1_valid_until derives from it (+90d).';
COMMENT ON COLUMN drivers.poa2_doc_date IS
  'Date on proof-of-address document 2. INPUT — poa2_valid_until derives from it (+90d).';
COMMENT ON COLUMN drivers.passport_check_date IS
  'Date the passport was checked. INPUT — passport_valid_until derives from it (+30d, capped at passport_expiry).';
COMMENT ON COLUMN drivers.passport_expiry IS
  'Expiry printed on the passport itself. INPUT — caps the derived passport window.';
COMMENT ON COLUMN drivers.licence_check_valid_until IS
  'DERIVED by services/driver-validity.ts: min(idenfy_check_date + 90d, licence_valid_to). '
  'NULL when the licence record is not trusted (licence_issued_by blank) — a check date with no '
  'licence identity behind it is not evidence of anything. Do not write by hand.';

-- ── Value-preserving backfill of the FROM dates ─────────────────────────────
UPDATE drivers
   SET poa1_doc_date = poa1_valid_until - INTERVAL '90 days'
 WHERE poa1_doc_date IS NULL AND poa1_valid_until IS NOT NULL;

UPDATE drivers
   SET poa2_doc_date = poa2_valid_until - INTERVAL '90 days'
 WHERE poa2_doc_date IS NULL AND poa2_valid_until IS NOT NULL;

-- Passport: pre-192 `passport_valid_until` held the window end for auto-captured
-- records (idenfy_check_date + 30d) and a hand-typed date for manual ones. Both
-- invert the same way; passport_expiry stays NULL so the window is unchanged
-- (min() with NULL is a no-op) until staff record the real document expiry.
UPDATE drivers
   SET passport_check_date = passport_valid_until - INTERVAL '30 days'
 WHERE passport_check_date IS NULL AND passport_valid_until IS NOT NULL;

-- ── Seed the new licence check window ───────────────────────────────────────
-- Mirrors computeLicenceWindow() in services/driver-validity.ts, including the
-- integrity guard: no trusted licence identity => no window.
--
-- NB `idenfy_check_date` is VARCHAR(50), not DATE — the iDenfy webhook writes a
-- raw ISO timestamp ("2026-08-18T12:26:19.937Z") while staff edits write
-- "YYYY-MM-DD". Both cast cleanly, but the regex guard keeps a single malformed
-- legacy value from failing the whole migration.
UPDATE drivers
   SET licence_check_valid_until = LEAST(
         (LEFT(idenfy_check_date, 10)::date + INTERVAL '90 days')::date,
         COALESCE(licence_valid_to, 'infinity'::date)
       )
 WHERE licence_check_valid_until IS NULL
   AND idenfy_check_date ~ '^\d{4}-\d{2}-\d{2}'
   AND NULLIF(TRIM(licence_issued_by), '') IS NOT NULL;
