-- ============================================================================
-- 165: Auto-Chase — master send switch
-- ============================================================================
-- Spec: docs/AUTO-CHASE-SPEC.md §9.4, §10.
--
-- The per-job `auto_chase_mode` dial (off/draft/send, migration 157) lets staff
-- opt an individual quote into auto-drafting or auto-sending its chases. This
-- global switch is the safety backstop on top: even a job set to 'send' only
-- actually SENDS when this is 'true'. Default 'false' so the whole team can set
-- jobs to Auto-send and WATCH the drafts that would go out for a couple of weeks
-- before real sends are enabled — the graduation the spec calls for.
--
-- Seed-only; no schema change. auto_chase_mode / auto_chase_count /
-- last_auto_chase_at all already exist from migration 157.
-- ============================================================================

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('auto_chase_send_enabled', 'false',
   'Master switch: allow jobs set to Auto-send to actually SEND chases (off = they create Gmail drafts only)',
   'chase', 'text', 40)
ON CONFLICT (key) DO NOTHING;
