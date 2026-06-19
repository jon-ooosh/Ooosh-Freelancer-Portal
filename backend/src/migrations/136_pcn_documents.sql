-- 132_pcn_documents.sql
-- PCN multi-document support (front + back of paper notices, council/company
-- correspondence + responses) for audit completeness. One JSONB array on the
-- pcns row — mirrors jobs.files / drivers.files. The legacy single-pointer
-- columns (pcn_document_url, receipt_url) are kept and merged on read, so
-- existing rows + the email-attach + receipt flows keep working untouched.
--
-- Each entry: { r2_key, name, kind, comment, uploaded_at, uploaded_by }
--   kind ∈ notice_front | notice_back | correspondence | response | receipt | other
--
-- Adds/removes are logged to pcn_events (event_type document_added/document_removed)
-- by the route handlers — no schema change needed there (metadata is JSONB).

ALTER TABLE pcns ADD COLUMN IF NOT EXISTS documents JSONB NOT NULL DEFAULT '[]'::jsonb;
