-- 120_job_balance_chases.sql
--
-- Chase log for the /money/overview Balances Outstanding list: "when did we
-- last do something about this debt?". One row per chase event (click on the
-- overview), so the count is COUNT(*), the last-chased date is MAX(chased_at),
-- and an accidental click is undone by deleting the latest row — full audit
-- trail for free.
--
-- Deliberately a separate table (same reasoning as job_balance_overrides in
-- migration 117): the job_financials cache write-through / nightly backfill
-- recomputes money figures and must never clobber staff's chase history.
-- Distinct from the pipeline chase machinery (jobs.next_chase_date +
-- chase interactions) — that drives ENQUIRY chasing; this tracks DEBT chasing
-- on confirmed/finished jobs and deliberately doesn't touch pipeline state.

CREATE TABLE IF NOT EXISTS job_balance_chases (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  chased_by  UUID REFERENCES users(id),
  chased_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note       TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_balance_chases_job ON job_balance_chases(job_id, chased_at DESC);

-- Backup user read grant (matches the other OP tables).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON job_balance_chases TO ooosh_backup;
  END IF;
END $$;
