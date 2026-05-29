-- ============================================================================
-- 097: Client Storage — round 2 refinements
--
-- Feedback from first live use (May 2026):
--   - Access mechanism (code / key / padlock) changes per CLIENT, so it moves
--     from the room to the tenancy. Room keeps physical attributes only.
--   - Rooms gain an Internal/External location tag + a default weekly rate
--     (prefills the move-in rate).
--   - Access requests become reminder-style: choose recipients + bell/email,
--     fire on the requested date (or immediately if today/undated).
-- See docs/STORAGE-CLIENTS-SPEC.md.
-- ============================================================================

-- Rooms: physical attributes
ALTER TABLE storage_rooms ADD COLUMN IF NOT EXISTS location_type VARCHAR(20)
  CHECK (location_type IS NULL OR location_type IN ('internal', 'external'));
ALTER TABLE storage_rooms ADD COLUMN IF NOT EXISTS default_weekly_rate NUMERIC(10,2);

-- Tenancies: per-client access mechanism (moved off the room)
ALTER TABLE storage_tenancies ADD COLUMN IF NOT EXISTS access_type VARCHAR(20)
  NOT NULL DEFAULT 'door_code'
  CHECK (access_type IN ('door_code', 'we_hold_key', 'client_key'));
ALTER TABLE storage_tenancies ADD COLUMN IF NOT EXISTS access_code TEXT;
ALTER TABLE storage_tenancies ADD COLUMN IF NOT EXISTS key_location VARCHAR(200);

-- Access events: reminder-style notifications
ALTER TABLE storage_access_events ADD COLUMN IF NOT EXISTS notify_user_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE storage_access_events ADD COLUMN IF NOT EXISTS delivery_method VARCHAR(20)
  NOT NULL DEFAULT 'both'
  CHECK (delivery_method IN ('notification', 'email', 'both'));
