-- ============================================================================
-- 166: Auto-Chase — default sender name for automated chases
-- ============================================================================
-- Spec: docs/AUTO-CHASE-SPEC.md §9.2.
--
-- A MANUAL "Draft chase" signs off with the staff member who clicked it. An
-- AUTOMATED chase (the scheduled runner) has no clicker, so it needs a name to
-- sign off with — otherwise it reads "the Ooosh team", which is impersonal.
--
-- The runner signs off with: the job's assigned manager's first name → this
-- setting → "the Ooosh team". Set this to whoever should front the automated
-- chases (e.g. "Will") so they always carry a human name even on jobs with no
-- manager assigned. Empty = fall through to "the Ooosh team".
-- ============================================================================

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('chase_default_sender_name', '',
   'Name to sign automated chases off with when a job has no assigned manager (blank = "the Ooosh team")',
   'chase', 'text', 15)
ON CONFLICT (key) DO NOTHING;
