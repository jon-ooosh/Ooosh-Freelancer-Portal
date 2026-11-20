-- ============================================================================
-- 360: Premises & compliance — phase 3a (docs/PREMISES-COMPLIANCE-SPEC.md §15)
-- ============================================================================
--   * The documents library: what isn't a check — the lease, insurance
--     schedules, plans, the asbestos survey, manuals. A FOLDER has a
--     visibility; a DOCUMENT can be set tighter, never looser; a document's
--     files are its versions (newest is current, older ones kept).
--   * premises_files now belongs to a record (a check's certificate) OR a
--     document (the library) — exactly one, by CHECK. Both live under the
--     premises/ prefix, gated per file by the download route.
--   * Advisories: an engineer's "replace the condensate trap" as its own row,
--     so it can become a To Do or be ticked off rather than sit in a note.
--   * A record can point at the contractor's bill in Costs. ON DELETE SET
--     NULL: a cost is hard-deleted from Money › Costs, and that must never
--     fail because a certificate once pointed at it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS premises_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  visibility  VARCHAR(10) NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'managers', 'admins')),
  sort_order  INT NOT NULL DEFAULT 0,
  retired_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS premises_documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id   UUID NOT NULL REFERENCES premises_folders(id),
  title       TEXT NOT NULL,
  -- NULL = the folder's. Never looser than the folder (services/premises.ts).
  visibility  VARCHAR(10) CHECK (visibility IN ('all', 'managers', 'admins')),
  place_id    UUID REFERENCES premises_places(id),
  notes       TEXT,
  archived_at TIMESTAMPTZ,
  archived_by UUID REFERENCES users(id),
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_premises_documents_folder ON premises_documents(folder_id) WHERE archived_at IS NULL;

ALTER TABLE premises_files ALTER COLUMN record_id DROP NOT NULL;
ALTER TABLE premises_files ADD COLUMN IF NOT EXISTS document_id UUID REFERENCES premises_documents(id);
ALTER TABLE premises_files DROP CONSTRAINT IF EXISTS premises_files_one_owner;
ALTER TABLE premises_files ADD CONSTRAINT premises_files_one_owner CHECK ((record_id IS NULL) <> (document_id IS NULL));
CREATE INDEX IF NOT EXISTS idx_premises_files_document ON premises_files(document_id);

CREATE TABLE IF NOT EXISTS premises_advisories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id   UUID NOT NULL REFERENCES premises_records(id),
  text        TEXT NOT NULL,
  -- The To Do made from it, if anyone asked for one.
  task_id     UUID REFERENCES staff_tasks(id),
  done_at     TIMESTAMPTZ,
  done_by     UUID REFERENCES users(id),
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_premises_advisories_record ON premises_advisories(record_id);

ALTER TABLE premises_records ADD COLUMN IF NOT EXISTS cost_id UUID REFERENCES costs(id) ON DELETE SET NULL;

-- ── Seed: the library's folders (spec §6) ───────────────────────────────────
INSERT INTO premises_folders (name, visibility, sort_order)
SELECT v.name, v.visibility, v.sort_order
  FROM (VALUES ('Lease & legal', 'admins', 1), ('Insurance', 'admins', 2), ('Risk assessments', 'all', 3),
               ('Plans & drawings', 'all', 4), ('Manuals & warranties', 'all', 5), ('Utility accounts', 'managers', 6))
       AS v(name, visibility, sort_order)
 WHERE NOT EXISTS (SELECT 1 FROM premises_folders);
