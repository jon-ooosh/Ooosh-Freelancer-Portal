-- Staff login security, phases 2–3 (docs/STAFF-LOGIN-SECURITY-SPEC.md §3.4, §3.5, §4).
-- Passkeys and recovery codes; the kiosk till's settings and its place on a sale.

-- A passkey (WebAuthn credential). A person may hold several — a phone, a laptop,
-- a YubiKey. Apple/Google sync one across a person's own devices. The row is the
-- revocation (revoked_at): "Remove" never deletes what once signed a login.
CREATE TABLE IF NOT EXISTS user_passkeys (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  TEXT NOT NULL,                 -- base64url, as the browser reports it
  public_key     BYTEA NOT NULL,
  counter        BIGINT NOT NULL DEFAULT 0,     -- replay guard, from the authenticator
  transports     TEXT[],
  label          TEXT NOT NULL DEFAULT '',
  device_type    TEXT,                          -- singleDevice | multiDevice
  backed_up      BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_passkeys_credential ON user_passkeys (credential_id);
CREATE INDEX IF NOT EXISTS idx_user_passkeys_live ON user_passkeys (user_id) WHERE revoked_at IS NULL;

-- Recovery codes — admins only (jon holds them, §1). Ten per person, single use,
-- hashed at rest like the email codes. Regenerating replaces the set.
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_recovery_codes_live ON user_recovery_codes (user_id) WHERE used_at IS NULL;

-- The kiosk till (§4.3): a sale rung up on the warehouse iPad under the PIN
-- session. Who sold it is recorded_by_person_id (migration 251's column —
-- "sold_by_person_id" in the spec); recorded_by stays NULL, as for a sitter.
ALTER TABLE shop_sales DROP CONSTRAINT IF EXISTS shop_sales_recorded_in_check;
ALTER TABLE shop_sales ADD CONSTRAINT shop_sales_recorded_in_check
  CHECK (recorded_in IN ('staff_till', 'sitter_till', 'kiosk_till'));

-- §4.4 where the PIN works, §4.2 the reader on the kiosk, §4.5 the PIN rotation bell.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('kiosk_allowed_ips', '95.144.185.166',
   'Warehouse kiosk: public IP addresses the PIN is accepted from (comma-separated; empty = anywhere)',
   'security', 'text', 91),
  ('stripe_terminal_kiosk', 'false',
   'Card reader on the warehouse kiosk till (true/false) — the sale still names the person from the dropdown',
   'money', 'text', 93),
  ('kiosk_pin_rotated_at', to_char(CURRENT_DATE, 'YYYY-MM-DD'),
   'Warehouse kiosk: when the PIN was last changed (YYYY-MM-DD) — admins are reminded every 3 months',
   'security', 'text', 92)
ON CONFLICT (key) DO NOTHING;
