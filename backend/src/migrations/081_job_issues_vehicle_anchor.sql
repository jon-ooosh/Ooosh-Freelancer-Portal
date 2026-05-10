-- Migration 081: Job issues — vehicle-anchored issues + dedup support
--
-- Two changes that together turn job_issues from a strict "every issue
-- belongs to a job" model into one that can hold vehicle-only issues
-- (prep flags between hires) without losing dedup ability.
--
-- 1. job_id: NOT NULL → NULLABLE.
--    Pre-hire prep flags surface BETWEEN hires, when no job is active
--    on the vehicle. Forcing them to anchor against "the most recent
--    completed job" was a half-truth that polluted job-level reports.
--    Vehicle-only issues are now first-class: they live on the vehicle
--    until they're resolved or until a hire surfaces them, at which
--    point staff can manually link the job_id from the IssueDetailPage.
--
--    All other modules (rehearsal, equipment, transport, dispute) keep
--    populating job_id as today — the column being nullable is enabling,
--    not forcing.
--
-- 2. component_key VARCHAR(100): stable identifier for "the same thing".
--    Prep checklist items have stable IDs (e.g. fire_extinguisher,
--    bodywork_panels, windscreen, seat_belts). When PrepPage / CheckInPage
--    fire an auto-create, they pass component_key. The auto-create helper
--    matches against (vehicle_id, component_key, status NOT IN terminal)
--    and either appends an event to the existing open issue (recurrence)
--    or creates a new row.
--
--    Manual entry / check-in damage with no checklist context can leave
--    component_key NULL; those rows always create fresh and don't dedup.

-- ── Column changes ──────────────────────────────────────────────────────

ALTER TABLE job_issues
  ALTER COLUMN job_id DROP NOT NULL;

ALTER TABLE job_issues
  ADD COLUMN IF NOT EXISTS component_key VARCHAR(100);

-- ── Dedup index ─────────────────────────────────────────────────────────
-- Partial index on (vehicle_id, component_key) for issues NOT in a
-- terminal state. The auto-create helper queries this index to find
-- "is there already an open issue for this (van, component)?". Partial
-- so it only carries the active set — the bulk of historical resolved
-- rows don't bloat it.

CREATE INDEX IF NOT EXISTS idx_job_issues_vehicle_component_open
  ON job_issues (vehicle_id, component_key)
  WHERE vehicle_id IS NOT NULL
    AND component_key IS NOT NULL
    AND status NOT IN ('resolved', 'written_off', 'cancelled');

-- ── Lift job_id index restriction ───────────────────────────────────────
-- The original job_id index is btree (job_id) — fine when the column was
-- NOT NULL but now wastes space on NULL rows. Recreate as partial.

DROP INDEX IF EXISTS idx_job_issues_job_id;
CREATE INDEX IF NOT EXISTS idx_job_issues_job_id
  ON job_issues (job_id)
  WHERE job_id IS NOT NULL;

-- ── At-least-one-anchor constraint ──────────────────────────────────────
-- Every issue must be anchored to SOMETHING — either a job or a vehicle.
-- Driver / person / client_org issues always have a job context in
-- practice (they happen to a someone IN the context of a hire), so we
-- don't permit anchor-less rows by relaxing this further.
--
-- Use NOT VALID + VALIDATE so existing rows aren't blocked by the
-- constraint addition (they all have job_id since the column was
-- previously NOT NULL — VALIDATE will pass without rewrite).

ALTER TABLE job_issues
  ADD CONSTRAINT job_issues_anchor_check
    CHECK (job_id IS NOT NULL OR vehicle_id IS NOT NULL)
    NOT VALID;

ALTER TABLE job_issues
  VALIDATE CONSTRAINT job_issues_anchor_check;
