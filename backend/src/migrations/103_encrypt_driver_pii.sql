-- 103_encrypt_driver_pii.sql
--
-- Phase 1 of driver PII encryption-at-rest (see services/driver-pii.ts +
-- services/encryption.ts). Adds the encrypted companion columns for the
-- "clean" (non-searched) sensitive driver fields. Plaintext columns are LEFT
-- IN PLACE in this phase — dual-write + read-with-plaintext-fallback keeps
-- everything working while we verify decryption in production. A later
-- migration/backfill (Phase 2) nulls the plaintext once verified.
--
-- The encrypted columns are TEXT because AES-256-GCM ciphertext
-- (`iv:authTag:ciphertext` hex) is ~100+ chars — it does not fit the original
-- VARCHAR(50)/VARCHAR(255) columns.
--
-- NOT encrypted here (deliberately): licence_number + postcode are used in
-- live ILIKE/exact search on the Drivers page, and city is coarse — they stay
-- plaintext. date_of_birth moves from a DATE column into encrypted TEXT (it's
-- display-only, no date math anywhere in the codebase).

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS date_of_birth_encrypted   TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS dvla_check_code_encrypted TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS address_line1_encrypted   TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS address_line2_encrypted   TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS address_full_encrypted    TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS licence_address_encrypted TEXT;
