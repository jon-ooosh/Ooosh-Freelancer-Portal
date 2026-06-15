-- Migration 121: SMS module + Out-of-Hours approach reminder
--
-- Part 1 of the OOH SMS + compliance work (docs/OOH-SMS-AND-COMPLIANCE-SPEC.md).
--
--   * sms_log              — audit trail for every outbound SMS (mirrors email_log)
--   * ooh_sms_sent_at      — one-shot guard so the geofence scan texts a driver once
--   * system_settings seed — yard lat/lng for the geofence, trigger radius, and the
--                            country allowlist (which countries we actually SMS;
--                            everything else falls back to email-only, no regression)

ALTER TABLE vehicle_hire_assignments
  ADD COLUMN IF NOT EXISTS ooh_sms_sent_at TIMESTAMPTZ;

-- Partial index matching the "armed" set the approach scan walks every few minutes.
CREATE INDEX IF NOT EXISTS idx_vha_ooh_sms_pending
  ON vehicle_hire_assignments(vehicle_id)
  WHERE return_overnight = TRUE
    AND ooh_returned_at IS NULL
    AND ooh_sms_sent_at IS NULL
    AND status IN ('booked_out', 'active');

-- SMS audit trail. Mirrors email_log: 'mode' stores the per-message *effective*
-- routing (live if it reached the real number, test if it was redirected).
CREATE TABLE IF NOT EXISTS sms_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id         VARCHAR(100) NOT NULL,
  recipient           VARCHAR(50)  NOT NULL,   -- intended number (E.164)
  actual_recipient    VARCHAR(50)  NOT NULL,   -- after any test-mode redirect
  body                TEXT,
  segments            INTEGER,
  status              VARCHAR(20)  NOT NULL,   -- sent | failed
  provider_message_id VARCHAR(100),
  error_message       TEXT,
  mode                VARCHAR(10)  NOT NULL,   -- live | test (effective routing)
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sms_log_created  ON sms_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_log_template ON sms_log(template_id);

-- Geofence + allowlist settings (appear automatically in the OOH section of the
-- Settings page — value_type 'text', rendered as plain inputs).
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('ooh_base_lat',              '',   'Yard latitude (SMS geofence)',                  'ooh_returns', 'text', 80),
  ('ooh_base_lng',              '',   'Yard longitude (SMS geofence)',                 'ooh_returns', 'text', 90),
  ('ooh_sms_radius_miles',      '1',  'SMS reminder trigger radius (miles)',           'ooh_returns', 'text', 100),
  ('ooh_sms_country_allowlist', 'GB', 'SMS country allowlist (ISO codes, comma-sep)',  'ooh_returns', 'text', 110)
ON CONFLICT (key) DO NOTHING;
