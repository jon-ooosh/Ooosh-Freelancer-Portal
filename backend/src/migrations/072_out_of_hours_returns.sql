-- Migration 071: Out-of-Hours return info system
--
-- Adds tracking columns to vehicle_hire_assignments for OOH return automation:
--   * ooh_info_sent_at      — initial info email sent timestamp (idempotency guard)
--   * ooh_reminder_sent_at  — day-before reminder timestamp
--   * ooh_returned_at       — when the driver submitted the parking confirmation form
--   * ooh_parking_lat/lng   — confirmed parking location (Traccar-prefilled, driver-confirmed)
--   * ooh_parking_notes     — free-text notes from the driver
--   * ooh_parking_token     — HMAC token for the public parking-confirmation form
--
-- Also creates a generic system_settings table (key/text-value) for operational
-- config that doesn't fit calculator_settings (which is DECIMAL-only). Seeds
-- OOH-specific entries: gate code, yard address, key-drop photo URL, etc.
-- Admin-editable from the Settings page.

ALTER TABLE vehicle_hire_assignments
  ADD COLUMN IF NOT EXISTS ooh_info_sent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ooh_reminder_sent_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ooh_returned_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ooh_parking_lat       NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS ooh_parking_lng       NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS ooh_parking_notes     TEXT,
  ADD COLUMN IF NOT EXISTS ooh_parking_token     TEXT;

CREATE INDEX IF NOT EXISTS idx_vha_ooh_parking_token
  ON vehicle_hire_assignments(ooh_parking_token)
  WHERE ooh_parking_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vha_ooh_reminder_pending
  ON vehicle_hire_assignments(hire_end)
  WHERE return_overnight = TRUE
    AND ooh_reminder_sent_at IS NULL
    AND status IN ('booked_out', 'active');

-- Generic operational settings table (key/text-value).
-- Distinct from calculator_settings (DECIMAL only) and picklist_items (lists).
-- Use for: gate codes, addresses, URLs, feature toggles, free-form config.
CREATE TABLE IF NOT EXISTS system_settings (
  key         VARCHAR(100) PRIMARY KEY,
  value       TEXT,
  label       VARCHAR(255),
  category    VARCHAR(50),    -- 'ooh_returns', 'general', etc — for UI grouping
  value_type  VARCHAR(20),    -- 'text', 'url', 'bool', 'json'
  sort_order  INTEGER DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID REFERENCES users(id)
);

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('ooh_gate_code',           '12321',                                  'Yard gate code',                          'ooh_returns', 'text',  10),
  ('ooh_yard_address',        '13 Stanford Road, Brighton, BN1 5DJ',    'Yard address (for the email body)',       'ooh_returns', 'text',  20),
  ('ooh_yard_maps_url',       '',                                       'Yard Google Maps link',                   'ooh_returns', 'url',   30),
  ('ooh_keydrop_photo_url',   '',                                       'Key-drop photo URL',                      'ooh_returns', 'url',   40),
  ('ooh_overflow_photo_url',  '',                                       'Overflow parking photo URL',              'ooh_returns', 'url',   50),
  ('ooh_what3words',          '',                                       'what3words (optional)',                   'ooh_returns', 'text',  60),
  ('ooh_cc_info_email',       'true',                                   'CC info@ on parking-form submissions',    'ooh_returns', 'bool',  70)
ON CONFLICT (key) DO NOTHING;
