-- ============================================================================
-- 231: Staff Records — private files held ABOUT staff
-- ============================================================================
-- See docs/STAFF-RECORDS-SPEC.md §3.1 (Phase 1 of §8's build order).
--
-- NOT to be confused with `staff_documents` / `staff_document_assignments`,
-- which is documents we publish TO staff (handbook, training, tick/sign
-- tracking). This is the opposite direction and the opposite access rule:
-- admin-only, per person, nobody else. Spec §1.4 explains why reusing that
-- table would have been a permissions accident.
--
-- Deliberately NOT here (spec §1.1, and it is the whole reason this table is
-- small): licence, DVLA check code and passport DATES. Those already exist on
-- `drivers` — and a second copy already exists on `people` from migration 184.
-- A third would be the bug `services/driver-validity.ts` was written to end.
-- The FILE may be filed here under the matching doc_type; the dates are read
-- from where they already live.
-- ============================================================================

CREATE TABLE IF NOT EXISTS staff_record_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,

  -- jon's word was "labellable". The LABEL is free text for humans
  -- ("Passport 2024", "Contract signed Mar 2025"); the TYPE is the enum the
  -- system reasons about. Both, not one: a free-text type cannot drive the
  -- review cycles in spec §4, and an enum alone cannot tell two passports
  -- apart.
  label         TEXT NOT NULL,
  doc_type      VARCHAR(30) NOT NULL DEFAULT 'other'
                  CHECK (doc_type IN (
                    'contract', 'right_to_work', 'passport', 'licence',
                    'dvla_check', 'qualification', 'medical', 'other'
                  )),

  -- R2 private bucket. The `staff-records/` prefix is load-bearing, not
  -- cosmetic: GET /api/files/download authorises by PREFIX, and every other
  -- allowed prefix is readable by ANY authenticated user (a freelancer
  -- included). This prefix is the one that carries an admin check. Never file
  -- one of these under `files/`.
  r2_key        TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  content_type  VARCHAR(160),
  size_bytes    BIGINT,

  notes         TEXT,

  uploaded_by   UUID REFERENCES users(id),
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Soft-delete per CLAUDE.md. A removed passport scan still happened, and
  -- "who deleted the contract, and when" is exactly the question an employment
  -- dispute asks. The R2 object is deleted for real; the row is the record
  -- that it existed.
  deleted_at    TIMESTAMPTZ,
  deleted_by    UUID REFERENCES users(id)
);

-- The only read this table gets: one person's live files, newest first.
CREATE INDEX IF NOT EXISTS idx_staff_record_files_person
  ON staff_record_files(person_id, uploaded_at DESC)
  WHERE deleted_at IS NULL;

-- Phase 6 (spec §4) scans by type to derive review cycles.
CREATE INDEX IF NOT EXISTS idx_staff_record_files_type
  ON staff_record_files(doc_type)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE staff_record_files IS
  'Private files held ABOUT a staff member (contracts, right-to-work, ID). Admin-only. The opposite of staff_documents, which publishes TO staff. See docs/STAFF-RECORDS-SPEC.md.';

COMMENT ON COLUMN staff_record_files.doc_type IS
  'Drives the review cycles in spec §4. ''medical'' is special-category data whose per-type retention is still Phase 7 — see spec §7 before relying on anything sweeping it.';

COMMENT ON COLUMN staff_record_files.r2_key IS
  'Always under the staff-records/ prefix. GET /api/files/download gates that prefix on admin; every other prefix it serves is readable by any authenticated user.';
