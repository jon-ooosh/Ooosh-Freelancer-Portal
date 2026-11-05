-- 333: "Have they read it?" for freelancer documents (jon, Nov 2026;
-- docs/FREELANCER-PORTAL-SPEC.md §8). services/freelancer-document-reads.ts.
--
-- A Staff Document shared with freelancers can ask them to confirm they've read
-- it. The portal marks it "To read", the freelancer taps "I've read and
-- understood this", and we record who, which VERSION and when. A new version
-- (the Staff Documents "New version" button) asks everyone again, because a read
-- belongs to a version; an edit to the title or settings doesn't.
--
-- Freelancers are people, not OP users, so this is its own table rather than
-- staff_document_assignments (which is keyed on users and carries the staff
-- chasers). Nothing is blocked by an unread document: it is a reminder and a record.
-- No IP or browser: the portal calls OP server-side, so they'd be the portal's own.
ALTER TABLE staff_documents
  ADD COLUMN IF NOT EXISTS freelancer_read_required BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS freelancer_document_reads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  UUID NOT NULL REFERENCES staff_documents(id) ON DELETE CASCADE,
  version_id   UUID NOT NULL REFERENCES staff_document_versions(id) ON DELETE CASCADE,
  person_id    UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  read_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (version_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_freelancer_doc_reads_person ON freelancer_document_reads(person_id);
CREATE INDEX IF NOT EXISTS idx_freelancer_doc_reads_document ON freelancer_document_reads(document_id);
