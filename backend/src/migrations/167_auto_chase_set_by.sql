-- ============================================================================
-- 167: Auto-Chase — record who set a job's auto-chase
-- ============================================================================
-- Spec: docs/AUTO-CHASE-SPEC.md §9.2.
--
-- Same sign-off logic as a manual "Draft chase" (which signs off with whoever
-- clicked): an AUTOMATED chase should sign off with whoever SET the auto-chase
-- on this job. Stamped when auto_chase_mode is set to draft/send via the
-- pipeline PATCH; the runner signs off with this person's first name, falling
-- back to the job's manager, then chase_default_sender_name, then the team.
-- ============================================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS auto_chase_set_by UUID REFERENCES users(id);
