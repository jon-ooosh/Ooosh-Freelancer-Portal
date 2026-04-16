-- ============================================================================
-- 047: Reminder job requirement type
-- Adds a "Reminder" requirement type for follow-up tasks on jobs.
-- Uses existing job_requirements fields: due_date, assigned_to, notes, custom_label.
-- ============================================================================

INSERT INTO requirement_type_definitions (type, label, icon, steps, sort_order) VALUES
  ('reminder',  'Reminder',  '🔔', NULL, 260)
ON CONFLICT (type) DO NOTHING;
