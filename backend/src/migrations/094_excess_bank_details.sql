-- 094_excess_bank_details.sql
-- Encrypted client bank details for excess reimbursement (PR 3, May 2026)
--
-- When an excess is reimbursed via a bank transfer (UK BACS or international),
-- staff need the client's bank details. We store them ENCRYPTED (AES-256-GCM
-- via services/encryption.ts) and SCOPED TO THE job_excess RECORD — not
-- permanently on the person/org — because details can change between hires and
-- we don't want stale account numbers sitting around as a standing liability.
--
-- A "reuse from previous hire" lookup (services-side) finds the client's most
-- recent record with bank details and offers to copy them across, with a
-- "last used DD/MM/YYYY" heads-up so staff sanity-check stale details (they
-- reconfirm with the client as standard practice).
--
-- The decrypted shape (JSON, never stored as plaintext) is:
--   {
--     type: 'uk' | 'international',
--     accountHolder: string,
--     -- UK:
--     sortCode?: string,
--     accountNumber?: string,
--     -- International:
--     iban?: string,
--     swiftBic?: string,
--     bankCountry?: string
--   }
-- These structured fields are the direct input to a future Wise recipient.
--
-- Decryption happens ONLY in the API response layer for admin/manager. The
-- column holds `iv:authTag:ciphertext` (hex) — opaque without ENCRYPTION_KEY.

BEGIN;

ALTER TABLE job_excess
  ADD COLUMN IF NOT EXISTS bank_details_encrypted    TEXT,
  ADD COLUMN IF NOT EXISTS bank_details_last_used_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bank_details_updated_at   TIMESTAMPTZ;

-- Card-machine receipt scan (R2 key). Migration 087 added receipt_required +
-- receipt_uploaded_at but no column for the scan itself. The capture endpoint
-- (PR 1/2) accepts receipt_url in its body but had nowhere to store it — this
-- closes that gap. NULL until a scan is attached via POST /api/excess/:id/receipt.
ALTER TABLE job_excess
  ADD COLUMN IF NOT EXISTS receipt_url TEXT;

-- Reuse-from-previous lookup scans a client's records for the most recent one
-- carrying bank details. Partial index keeps that scan cheap.
CREATE INDEX IF NOT EXISTS idx_job_excess_bank_details
  ON job_excess(job_id)
  WHERE bank_details_encrypted IS NOT NULL;

COMMIT;
