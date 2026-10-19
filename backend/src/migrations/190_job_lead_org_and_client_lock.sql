-- ============================================================================
-- Migration 190: Lead organisation per job + client lock against HH clobber
-- ============================================================================
-- Two related fixes to how organisations attach to a job.
--
-- 1. LEAD ORGANISATION.  `job_organisations.is_primary` has existed since
--    migration 027 but nothing has ever read or written it. It becomes the
--    explicit "lead organisation" flag: the org that headlines the job.
--    When no row is flagged, the job's `client_id` (the accounting client)
--    is the lead by default — so existing jobs need no backfill.
--
--    A partial unique index keeps it to one lead per job, mirroring the
--    `job_contacts.is_primary` convention (migration 086). The dedupe below
--    is defensive only — nothing has ever set the column, so it should be a
--    no-op, but a stray true would otherwise fail the index build.
--
-- 2. CLIENT LOCK.  The HH job sync writes `client_id = COALESCE($n, client_id)`,
--    which only guards against NULL. It does NOT guard against a human having
--    deliberately changed the client in OP: HireHop's COMPANY string wins on
--    every 30-minute sync, so an OP-side change silently reverts. Stamping
--    `client_locked_at` when staff change the client via the Job Detail pencil
--    lets the sync leave that decision alone (and flag a review instead when
--    HireHop disagrees, rather than reverting silently).
-- ============================================================================

-- ── 1. Client lock ──────────────────────────────────────────────────────────
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS client_locked_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS client_locked_by UUID REFERENCES users(id);

COMMENT ON COLUMN jobs.client_locked_at IS
  'Set when a human changes the client via OP. While set, the HireHop job sync will not overwrite client_id — it queues a client_mismatch review instead.';

-- ── 2. One lead organisation per job ────────────────────────────────────────
-- Defensive dedupe: keep the oldest flagged row per job, clear the rest.
UPDATE job_organisations jo
SET is_primary = false
WHERE jo.is_primary = true
  AND jo.id <> (
    SELECT inner_jo.id
    FROM job_organisations inner_jo
    WHERE inner_jo.job_id = jo.job_id AND inner_jo.is_primary = true
    ORDER BY inner_jo.created_at ASC, inner_jo.id ASC
    LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_org_primary
  ON job_organisations (job_id)
  WHERE is_primary;
