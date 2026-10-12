-- 286: Quote options — alternative quotes for ONE enquiry as a GROUP of jobs
-- (docs/QUOTE-VERSIONS-SPEC.md §4; "version" in the spec is "option" in code —
-- jon, 12 Oct 2026, so it can't be confused with the quote-PDF versions on the
-- Activity Timeline, which are revisions of ONE job's quote).
--
-- One option = one OP job + one HireHop job. The group is a thin layer on top:
-- a job keeps every behaviour it has today; group_id / option_no / option_label
-- are the only additions. A group exists only once a second option exists.
--
-- `kind` is 'alternative' for this spec (the client picks ONE); 'part_of'
-- (festival-style "these belong together") is Phase 2 and costs a flag here,
-- not a model.

CREATE TABLE IF NOT EXISTS job_groups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            VARCHAR(20) NOT NULL DEFAULT 'alternative'
                  CHECK (kind IN ('alternative', 'part_of')),
  label           TEXT,                       -- "Katatonia Nov options"; default = client name
  lead_job_id     UUID REFERENCES jobs(id) ON DELETE SET NULL,  -- NULL = auto (most progressed); set = pinned
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS group_id      UUID REFERENCES job_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS option_no     INTEGER,   -- 1, 2, 3… within the group; NULL when ungrouped
  ADD COLUMN IF NOT EXISTS option_label  TEXT;      -- the differentiator: "Van + driver", "Whole stretch + Twin"

CREATE INDEX IF NOT EXISTS idx_jobs_group ON jobs(group_id) WHERE group_id IS NOT NULL;
-- option_no is MAX + 1 at add time and never reused or renumbered.
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_group_option ON jobs(group_id, option_no) WHERE group_id IS NOT NULL;

COMMENT ON TABLE job_groups IS
  'Alternative quotes for one enquiry (kind=alternative) — each member is an ordinary job with its own HireHop job. See docs/QUOTE-VERSIONS-SPEC.md.';
COMMENT ON COLUMN jobs.option_no IS
  'Position within job_groups (Option 1, Option 2…). The identity of the alternative, not a revision counter — never auto-bumps.';
