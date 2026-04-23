-- Migration 062: promote run_groups to first-class entity
--
-- Previously, a "run" was just a shared UUID in quotes.run_group with no
-- object of its own. Combined pricing lived as per-quote run_group_fee,
-- which didn't model "£50 all-in for the whole run" cleanly.
--
-- This migration creates a run_groups table so the run has its own
-- combined_freelancer_fee + combined_client_fee (both optional — if null,
-- display falls back to summing per-quote fees). quotes.run_group becomes
-- an FK. Individual quote fees are NEVER overwritten, so ungrouping
-- non-destructively restores the original per-quote view.
--
-- Existing quotes.run_group_fee is left in place for now (legacy data).
-- New code reads combined_freelancer_fee from run_groups; run_group_fee
-- can be dropped in a later migration once confirmed unused.

CREATE TABLE IF NOT EXISTS run_groups (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date                 DATE,
  combined_freelancer_fee  NUMERIC(10, 2),
  combined_client_fee      NUMERIC(10, 2),
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill: ensure every existing quotes.run_group UUID has a matching
-- run_groups row, with run_date inferred from the first quote in the group.
INSERT INTO run_groups (id, run_date, created_at)
SELECT
  q.run_group                                  AS id,
  MIN(q.job_date)::date                        AS run_date,
  MIN(q.created_at)                            AS created_at
FROM quotes q
WHERE q.run_group IS NOT NULL
  AND q.is_deleted = false
GROUP BY q.run_group
ON CONFLICT (id) DO NOTHING;

-- Now that every run_group UUID has a parent row, add the FK.
-- ON DELETE SET NULL means deleting a run ungroups its quotes non-destructively.
ALTER TABLE quotes
  DROP CONSTRAINT IF EXISTS quotes_run_group_fkey;

ALTER TABLE quotes
  ADD CONSTRAINT quotes_run_group_fkey
    FOREIGN KEY (run_group) REFERENCES run_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_run_groups_run_date ON run_groups (run_date);
