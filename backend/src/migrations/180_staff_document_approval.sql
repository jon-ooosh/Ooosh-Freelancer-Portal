-- Staff Documents — two-stage authoring (jon, Jul 2026).
--
-- Any staff member can now create a document, but for non-managers it must be
-- approved by an admin/manager before it disseminates. Documents move
-- draft → pending_approval → approved; only 'approved' (+ active, tracked)
-- documents materialise assignments. Existing documents default to 'approved'
-- so nothing already live is affected.
ALTER TABLE staff_documents
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'approved'
    CHECK (approval_status IN ('draft', 'pending_approval', 'approved'));
ALTER TABLE staff_documents ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE staff_documents ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id);
ALTER TABLE staff_documents ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE staff_documents ADD COLUMN IF NOT EXISTS review_notes TEXT; -- rejection reason / approval note

CREATE INDEX IF NOT EXISTS idx_staff_documents_approval ON staff_documents(approval_status);
CREATE INDEX IF NOT EXISTS idx_staff_documents_created_by ON staff_documents(created_by);
