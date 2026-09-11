-- ============================================================================
-- Staff Documents — tags, owners, and owner content-review cadence (jon, Jul 2026).
--
-- Three additions to the module:
--   1. tags TEXT[]            — freeform categories (vehicles / money / staging)
--                               for search + filtering, on top of the fixed
--                               `category` enum. Editable at create + after.
--   2. owner_user_ids UUID[]  — the person(s) responsible for keeping the
--                               document current (can be more than one).
--   3. Content-review cadence — the OWNER/creator is reminded every N months to
--                               review the document is still accurate. Distinct
--                               from the assignee re-sign cadence
--                               (`review_interval_months` → assignments.expires_at):
--                               that renews a person's acknowledgement; this
--                               renews the *content*. On review the due date is
--                               knocked forward; publishing a new version (a
--                               significant change) advances it too and re-arms
--                               assignees via the existing new-version flow.
--
-- See docs/STAFF-DOCUMENTS-SPEC.md.
-- ============================================================================

ALTER TABLE staff_documents ADD COLUMN IF NOT EXISTS tags TEXT[];
ALTER TABLE staff_documents ADD COLUMN IF NOT EXISTS owner_user_ids UUID[];

-- Owner content-review cadence:
ALTER TABLE staff_documents ADD COLUMN IF NOT EXISTS content_review_interval_months INT;
ALTER TABLE staff_documents ADD COLUMN IF NOT EXISTS content_review_due_date DATE;
ALTER TABLE staff_documents ADD COLUMN IF NOT EXISTS content_reviewed_at TIMESTAMPTZ;
ALTER TABLE staff_documents ADD COLUMN IF NOT EXISTS content_reviewed_by UUID REFERENCES users(id);
-- Scanner dedup stamps (mirror the assignee chase/escalate stamps):
ALTER TABLE staff_documents ADD COLUMN IF NOT EXISTS content_review_chased_at TIMESTAMPTZ;
ALTER TABLE staff_documents ADD COLUMN IF NOT EXISTS content_review_escalated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_staff_documents_tags ON staff_documents USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_staff_documents_content_review_due
  ON staff_documents(content_review_due_date) WHERE content_review_due_date IS NOT NULL;
