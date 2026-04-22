-- Migration 058: case-insensitive email lookup on drivers
--
-- The `drivers.email` column has always been case-sensitive, so callers that
-- sent the same address with different casing (e.g. "Foo@bar.com" vs
-- "foo@bar.com") created duplicate rows. Application code now lowercases
-- email at every entry point in driver-verification.ts and hire-forms.ts,
-- but we add a functional index here so future LOWER(email) lookups are
-- cheap and the intent is documented at the schema level.
--
-- This is deliberately NOT a UNIQUE index — pre-existing data may still
-- contain case-mismatched duplicates that need manual merge before a
-- uniqueness constraint can be enforced.

CREATE INDEX IF NOT EXISTS idx_drivers_email_lower ON drivers (LOWER(email));
