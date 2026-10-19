-- 125_combine_bookings.sql
--
-- "Combine bookings" tool — merge two confirmed bookings for the same client
-- into one. The absorbed booking is retired via the normal `cancelled` status
-- (HH 9), but it's NOT a real cancellation: no fee, no refund, the deposit is
-- reallocated to the survivor in HireHop. This column records the linkage so:
--   - Job Detail renders a distinct "🔀 Combined into #X" banner (not the red
--     cancellation banner) with a link to the survivor.
--   - Cancellation analytics can EXCLUDE these — they're not lost revenue, the
--     money moved sideways into the survivor booking.
--
-- The survivor keeps no marker; it's just an ordinary (longer) booking. Only the
-- absorbed side carries combined_into_job_id.
--
-- Self-referential FK to jobs(id). ON DELETE SET NULL — if a survivor were ever
-- hard-deleted (jobs are normally soft-deleted via is_deleted, so this is
-- defensive), the absorbed job's banner just stops linking rather than erroring.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS combined_into_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_combined_into
  ON jobs(combined_into_job_id)
  WHERE combined_into_job_id IS NOT NULL;
