-- ============================================================================
-- 250: costs — link to PROBLEMS (job_issues), not the retired platform tracker
-- ============================================================================
-- Migration 092 gave costs a `platform_issue_id` referencing `platform_issues`,
-- believing that table was the Problems module. It is not: `platform_issues`
-- was the in-app bug tracker (retired Sep 2026, PR #1301). Problems live in
-- `job_issues` (mig 075).
--
-- The Problems page's "+ Add cost" sent a job_issues id into that column, so
-- the foreign key refused every such insert — the feature never worked, and
-- production had 0 rows with the column set when this was written.
--
-- Renamed rather than a second column added, so nothing is left pointing at
-- the wrong table. Guarded so a re-run is a no-op.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'costs' AND column_name = 'platform_issue_id') THEN
    ALTER TABLE costs DROP CONSTRAINT IF EXISTS costs_platform_issue_id_fkey;
    -- Nothing can legitimately survive the re-point: any value here named a
    -- bug-tracker row, which is not a Problem.
    UPDATE costs SET platform_issue_id = NULL WHERE platform_issue_id IS NOT NULL;
    ALTER TABLE costs RENAME COLUMN platform_issue_id TO job_issue_id;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'costs_job_issue_id_fkey') THEN
    ALTER TABLE costs ADD CONSTRAINT costs_job_issue_id_fkey
      FOREIGN KEY (job_issue_id) REFERENCES job_issues(id);
  END IF;
END $$;

COMMENT ON COLUMN costs.job_issue_id IS
  'The Problem (job_issues) this cost belongs to — repair/damage costs. Was platform_issue_id, pointing at the retired bug tracker (mig 250).';
