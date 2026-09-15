-- Supporting documents on a captured cost.
--
-- The main AI-read receipt stays on costs.receipt_r2_key / receipt_filename.
-- This holds the EXTRA evidence that belongs with the same payable — a
-- freelancer's fuel receipt behind their invoice, a delivery note, a warranty
-- card. One payable, one Xero bill, several attachments.
--
-- JSONB rather than a child table: these are inert blobs with no lifecycle of
-- their own (no status, no dates to chase), matching the jobs.files /
-- drivers.files convention. Entry shape:
--   { r2_key, filename, content_type, size_bytes, uploaded_at, uploaded_by }
--
-- Xero caps an object at 10 attachments and keys them by FILENAME, so the push
-- path (services/cost-xero-push.ts) de-duplicates names and caps the set —
-- never read this array straight into an attach loop.
ALTER TABLE costs
  ADD COLUMN IF NOT EXISTS supporting_documents JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN costs.supporting_documents IS
  'Extra evidence filed with this payable, alongside the main receipt. Array of {r2_key, filename, content_type, size_bytes, uploaded_at, uploaded_by}. Pushed to Xero as additional attachments (deduped by filename, capped at the Xero limit).';
