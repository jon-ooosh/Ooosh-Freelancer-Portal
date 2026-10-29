-- The warehouse kiosk tablet lock (docs/STAFF-LOGIN-SECURITY-SPEC.md §9).
--
-- The kiosk PIN works only on a tablet an admin has set up. Until now it was
-- held to the yard's public address (kiosk_allowed_ips); the broadband's
-- address changed on 28 Oct 2026 and locked the warehouse out, so the lock
-- moved from the building to the device. services/kiosk-devices.ts.
--
-- One row per tablet. An admin makes the row with a one-time set-up code
-- (hashed, 10 minutes); the tablet types it on the PIN page and the row goes
-- live, the tablet carrying the op_kiosk_device cookie that names it. The ROW
-- is the revocation (revoked_at), as for user_trusted_devices.
CREATE TABLE IF NOT EXISTS kiosk_devices (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label             TEXT NOT NULL DEFAULT '',
  setup_code_hash   TEXT,
  setup_expires_at  TIMESTAMPTZ,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at      TIMESTAMPTZ,
  last_used_at      TIMESTAMPTZ,
  last_used_ip      TEXT,
  revoked_at        TIMESTAMPTZ,
  revoked_by        UUID REFERENCES users(id) ON DELETE SET NULL
);

-- On from the start: until a tablet is set up the PIN works nowhere, and the
-- tablet's message says how to set it up. 'false' switches the lock off.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('kiosk_device_required', 'true',
   'Warehouse kiosk: the PIN works only on a tablet an admin has set up (true/false)',
   'security', 'text', 90)
ON CONFLICT (key) DO NOTHING;
