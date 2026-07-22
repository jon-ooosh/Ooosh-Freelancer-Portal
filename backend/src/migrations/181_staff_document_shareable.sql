-- Staff Documents — freelancer shareability (jon, Jul 2026).
--
-- A document can be shared into the freelancer portal's Resources section, the
-- same way files get shared. Only sensible categories may be shared
-- (policy / training / other) — agreement / contract / official_doc are
-- internal-only (enforced in the API). Default false.
ALTER TABLE staff_documents
  ADD COLUMN IF NOT EXISTS shareable_with_freelancers BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_staff_documents_shareable
  ON staff_documents(shareable_with_freelancers) WHERE shareable_with_freelancers = TRUE;
