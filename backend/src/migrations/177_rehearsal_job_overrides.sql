-- 177: Per-hire overrides on rehearsal_job_details (unified rehearsal editing)
--
-- The Job Detail rehearsal card and the org Rehearsals tab edited disjoint field
-- sets, so the "usual vs this hire" toggle only existed on the two fields present
-- in both (PA setup ↔ pa_monitoring, backline ↔ usual_backline). To put that
-- toggle on EVERY band-standing setup field without a schema column per field, we
-- store per-hire overrides as one JSONB map keyed by the PROFILE field name:
--   { room_setup, mic_list, power_notes, pa_monitoring, usual_backline, desk,
--     load_in_access, regular_contact }
-- Display precedence on a job: overrides[key] ?? organisation_rehearsal_profile[key].
-- "Band usual" writes the profile (carries forward); "This hire" writes overrides.
--
-- The legacy pa_setup / backline_notes columns are superseded by
-- overrides.pa_monitoring / overrides.usual_backline. We keep the columns (safe —
-- no drop) but backfill any existing per-hire values into the overrides map so the
-- new card reads them. New code stops writing pa_setup / backline_notes.

ALTER TABLE rehearsal_job_details
  ADD COLUMN IF NOT EXISTS overrides JSONB NOT NULL DEFAULT '{}';

-- Backfill legacy per-hire PA / backline values into the overrides map.
UPDATE rehearsal_job_details
SET overrides = COALESCE(overrides, '{}'::jsonb)
  || CASE WHEN pa_setup       IS NOT NULL AND pa_setup       <> '' THEN jsonb_build_object('pa_monitoring',  pa_setup)       ELSE '{}'::jsonb END
  || CASE WHEN backline_notes IS NOT NULL AND backline_notes <> '' THEN jsonb_build_object('usual_backline', backline_notes) ELSE '{}'::jsonb END
WHERE (pa_setup       IS NOT NULL AND pa_setup       <> '')
   OR (backline_notes IS NOT NULL AND backline_notes <> '');
