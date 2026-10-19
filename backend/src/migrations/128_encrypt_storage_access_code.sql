-- ============================================================================
-- 128: Encrypt storage door codes at rest
--
-- storage_tenancies.access_code holds a client's door / padlock code — it
-- protects physical access to their gear. Moves it to the application-level
-- encryption layer (services/encryption.ts, AES-256-GCM), same pattern as
-- driver PII (migration 103). The ciphertext (`iv:authTag:ciphertext` hex,
-- ~100+ chars) lives in a TEXT companion column; the plaintext column is
-- nulled on write (and by the one-shot backfill script
-- scripts/encrypt-storage-access-codes.ts).
--
-- If ENCRYPTION_KEY is not configured the route falls back to plaintext, so
-- nothing breaks pre-key — but prod already has the key (driver PII is live).
-- See docs/STORAGE-CLIENTS-SPEC.md §9.
-- ============================================================================

ALTER TABLE storage_tenancies ADD COLUMN IF NOT EXISTS access_code_encrypted TEXT;
