-- Possible insurance claims, Phase 4 (docs/INCIDENT-CLAIMS-SPEC.md §14, §21):
-- the van's GPS trace around the incident, from Traccar.
--
--   incident_claim_files.file_type += 'gps_trace'  (a CSV of positions; never shared with insurers by default)
--   incident_claims.gps_auto_captured_at  — the daily job saves one trace per case as soon as the
--     incident date is known, in case Traccar's history doesn't last until a late claim arrives.
--     Stamped whether or not Traccar had anything, so it's tried once.

ALTER TABLE incident_claim_files DROP CONSTRAINT IF EXISTS incident_claim_files_file_type_check;
ALTER TABLE incident_claim_files ADD CONSTRAINT incident_claim_files_file_type_check
  CHECK (file_type IN ('photo', 'police_report', 'broker_correspondence', 'repair_quote', 'tts360_notice', 'gps_trace', 'other'));

ALTER TABLE incident_claims ADD COLUMN IF NOT EXISTS gps_auto_captured_at TIMESTAMPTZ;
