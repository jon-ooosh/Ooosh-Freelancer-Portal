-- 193 — Capture what iDenfy already tells us, and gate on the face verdict
--
-- WHAT WAS BEING THROWN AWAY
-- --------------------------
-- functions/idenfy-webhook.js computes the full verification verdict —
-- faceValid, autoFace/manualFace, autoDocument/manualDocument, mismatchTags,
-- fraudTags, suspicionReasons — into a local object and then persists NONE of
-- it. The face-match result, which is the entire point of the check, had zero
-- effect on anything. It also saves only fileUrls.FRONT and fileUrls.BACK: the
-- SELFIE arrives in the same payload and is discarded.
--
-- The consequence ran in two opposite directions:
--
--   DENIED    iDenfy returns no document data, so OP received only a check date
--             + overall_status='Stuck'. The router correctly refused to trust a
--             check date with no licence identity, so it routed the driver back
--             to iDenfy — forever. overall_status='Stuck' was written and never
--             read by the routing engine. (4 drivers found in this state,
--             May–Aug 2026.)
--
--   SUSPECTED iDenfy DOES return document data, so everything wrote and the
--             driver sailed through — despite the face not matching the licence.
--             Staff would refresh the page and tell the driver it had worked.
--
-- Neither outcome consulted faceValid. This migration gives it somewhere to
-- live and a status to drive.
--
-- THE REVIEW GATE
-- ---------------
-- A face mismatch is common and usually innocent — an older driver whose
-- appearance has changed since their licence photo. So it is NOT a rejection:
-- it is a "a human must look at this" state, modelled on the existing insurance
-- referral so staff meet one pattern rather than two.
--
--   identity_check_status  NULL          never flagged (the overwhelming case)
--                          needs_review  iDenfy could not match the face
--                          accepted      staff compared selfie vs licence — it's them
--                          rejected      staff compared — it is not
--
-- Like a referral: blocks quick-assign, withholds the hire agreement, raises an
-- amber banner, and emails the vehicle-notification targets once. Unlike a
-- referral, the resolver is a member of staff with two photos rather than an
-- insurer — hence a separate column rather than overloading requires_referral,
-- which would conflate "the insurer must approve this person" with "someone
-- needs to eyeball two pictures".
--
-- WHICH HIRE IS THIS?
-- -------------------
-- current_job_number closes a real blind spot: a driver part-way through the
-- form has no vehicle_hire_assignments row yet (that is created on signature),
-- so Hire History is empty and staff cannot tell which hire a stuck driver
-- belongs to. The job number is in the hire-form link they clicked and in the
-- iDenfy clientId; we simply never stored it.

ALTER TABLE drivers
  -- Raw iDenfy verdict, kept verbatim so staff see what the machine saw.
  ADD COLUMN IF NOT EXISTS idenfy_overall            VARCHAR(20),
  ADD COLUMN IF NOT EXISTS idenfy_face_result        VARCHAR(40),
  ADD COLUMN IF NOT EXISTS idenfy_doc_result         VARCHAR(40),
  ADD COLUMN IF NOT EXISTS idenfy_mismatch_tags      JSONB,
  ADD COLUMN IF NOT EXISTS idenfy_suspicion_reasons  JSONB,
  -- Staff review of a failed face match.
  ADD COLUMN IF NOT EXISTS identity_check_status     VARCHAR(20),
  ADD COLUMN IF NOT EXISTS identity_reviewed_by      UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS identity_reviewed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS identity_review_notes     TEXT,
  -- Once-only claim for the alert email (mirrors referral_alert_sent_at).
  ADD COLUMN IF NOT EXISTS identity_alert_sent_at    TIMESTAMPTZ,
  -- Which hire the driver is currently filling a form in for.
  ADD COLUMN IF NOT EXISTS current_job_number        INTEGER,
  ADD COLUMN IF NOT EXISTS current_job_started_at    TIMESTAMPTZ;

-- NULL means "no identity concern", so nothing needs backfilling and the
-- column stays sparse — same convention as referral_status.
ALTER TABLE drivers
  DROP CONSTRAINT IF EXISTS drivers_identity_check_status_check;
ALTER TABLE drivers
  ADD CONSTRAINT drivers_identity_check_status_check
  CHECK (identity_check_status IS NULL
         OR identity_check_status IN ('needs_review', 'accepted', 'rejected'));

COMMENT ON COLUMN drivers.identity_check_status IS
  'Staff review of a failed iDenfy face match. NULL = no concern. needs_review blocks '
  'quick-assign and withholds the hire agreement, exactly like a pending insurance referral.';
COMMENT ON COLUMN drivers.idenfy_face_result IS
  'iDenfy autoFace/manualFace verdict, e.g. FACE_MATCH / FACE_MISMATCH. Computed by the '
  'webhook since launch and discarded until Aug 2026.';
COMMENT ON COLUMN drivers.current_job_number IS
  'HireHop job number of the hire whose form the driver is currently completing. Lets staff '
  'identify a stuck driver before a vehicle_hire_assignments row exists (created on signature).';

-- Surfaces the "who is stuck, and on which hire" list cheaply.
CREATE INDEX IF NOT EXISTS idx_drivers_identity_needs_review
  ON drivers (identity_check_status)
  WHERE identity_check_status = 'needs_review';
