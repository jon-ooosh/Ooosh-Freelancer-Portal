-- Staff login security, phase 1 (docs/STAFF-LOGIN-SECURITY-SPEC.md §3, §5).
-- Email codes as a second factor, trusted devices, the service identity made
-- unable to log in, and the enforcement date (a banner until then).

ALTER TABLE users ADD COLUMN IF NOT EXISTS login_disabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMPTZ;

-- The service identity (migration 031): automated writes are recorded against
-- it; nobody ever logs in as it.
UPDATE users SET login_disabled = true WHERE id = '00000000-0000-0000-0000-000000000000';

-- A device (browser profile) that has passed the second factor for this person.
-- The row is the revocation: a cookie whose row is missing or revoked is refused
-- whatever its signature says.
CREATE TABLE IF NOT EXISTS user_trusted_devices (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_trusted_devices_live ON user_trusted_devices (user_id) WHERE revoked_at IS NULL;

-- The 6-digit email codes — the driver_verification_codes shape, per user,
-- hashed at rest. One live code per person: a new send voids the old.
CREATE TABLE IF NOT EXISTS staff_login_codes (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash     TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_login_codes_live ON staff_login_codes (user_id) WHERE consumed_at IS NULL;

-- Until this date a person with no second factor logs in as before and sees a
-- banner; from it the login insists. Set 14 days out at migration time.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('staff_2fa_enforced_from', to_char(CURRENT_DATE + 14, 'YYYY-MM-DD'),
        'Staff login security: from this date (YYYY-MM-DD) every login must have a second factor; before it, a banner',
        'security', 'text', 90)
ON CONFLICT (key) DO NOTHING;
