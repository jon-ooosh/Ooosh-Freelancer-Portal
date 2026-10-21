-- Portal two-factor sign-in (docs/FREELANCER-PORTAL-SPEC.md §7, jon, Oct 2026).
-- The staff design (296) copied for freelancers: an email code as the second
-- step, phones remembered for 90 days, and a switch-on date. Keyed by person:
-- a portal login is a people row, not a users row.

-- A phone (browser) that passed the second step for this person. The ROW is the
-- revocation: a pass whose row is missing or revoked is refused whatever its
-- signature says. "Sign them out everywhere" revokes them all.
CREATE TABLE IF NOT EXISTS portal_trusted_devices (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  person_id     UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_portal_trusted_devices_live ON portal_trusted_devices (person_id) WHERE revoked_at IS NULL;

-- The 6-digit sign-in codes, hashed at rest, one live code per person (a new
-- one voids the old). `issued_by` is set when a member of staff read the code
-- out on the phone ("Give them a sign-in code") rather than it being emailed.
CREATE TABLE IF NOT EXISTS portal_login_codes (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  person_id     UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  code_hash     TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  consumed_at   TIMESTAMPTZ,
  issued_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_login_codes_live ON portal_login_codes (person_id) WHERE consumed_at IS NULL;

-- From this date (YYYY-MM-DD) a portal sign-in on a phone that isn't remembered
-- needs the emailed code. EMPTY = off: it ships off, and jon sets the date once
-- the rest of the portal work is done and freelancers have been told.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('portal_2fa_enforced_from', '',
        'Freelancer portal sign-in: from this date (YYYY-MM-DD) a phone that is not remembered needs an emailed code. Empty = off',
        'security', 'text', 91)
ON CONFLICT (key) DO NOTHING;
