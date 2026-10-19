-- ============================================================================
-- 260: Possible claims — how we heard, TTS360 notices, share-with-insurers
-- ============================================================================
-- docs/INCIDENT-CLAIMS-SPEC.md §18 (Phase 1 follow-up, jon Sep 2026).
--
--   incident_claims.notified_via  — how the incident first reached us. TTS360
--       (the 24-hour breakdown line) sends a notice whenever a client calls
--       them; staff track that separately from a client calling us direct.
--   incident_claim_files.file_type += 'tts360_notice'
--   incident_claim_files.share_with_insurer — not everything on the case file
--       goes to the broker. Only ticked photos appear in the broker PDF (and
--       behind its "View full size" links); ticked documents are attached to
--       the broker email.
-- ============================================================================

ALTER TABLE incident_claims ADD COLUMN IF NOT EXISTS notified_via VARCHAR(20)
  CHECK (notified_via IN ('client', 'tts360', 'third_party', 'check_in', 'other'));

-- A case opened from a check-in Problem was found at check-in; a claim out of
-- the blue came from the third party. Everything else staff set by hand.
UPDATE incident_claims c SET notified_via = 'check_in'
FROM job_issues ji
WHERE ji.id = c.origin_issue_id AND ji.source_module = 'vehicle' AND c.notified_via IS NULL;
UPDATE incident_claims SET notified_via = 'third_party'
WHERE third_party_claim = true AND notified_via IS NULL;

ALTER TABLE incident_claim_files DROP CONSTRAINT IF EXISTS incident_claim_files_file_type_check;
ALTER TABLE incident_claim_files ADD CONSTRAINT incident_claim_files_file_type_check
  CHECK (file_type IN ('photo', 'police_report', 'broker_correspondence', 'repair_quote', 'tts360_notice', 'other'));

ALTER TABLE incident_claim_files ADD COLUMN IF NOT EXISTS share_with_insurer BOOLEAN NOT NULL DEFAULT FALSE;
-- Existing files keep today's behaviour for photos (they were all in the PDF),
-- and the evidence types an insurer would expect default to shared.
UPDATE incident_claim_files SET share_with_insurer = TRUE
WHERE file_type IN ('photo', 'police_report', 'repair_quote');
