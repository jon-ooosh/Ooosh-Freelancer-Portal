-- ============================================================================
-- 272: Leads — dashboard surfacing threshold
-- ============================================================================
-- Spec: docs/TOUR-FINDER-SPEC.md §15. The dashboard's "Leads to look at" card
-- shows WARM leads at the normal minimum score (lead_min_relevance_score) but
-- COLD leads only at or above this higher bar, so a big search doesn't flood
-- the dashboard with every plausible act.
-- ============================================================================
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('lead_dashboard_min_score', '8', 'Minimum AI score for a COLD lead to show on the dashboard (warm leads use the normal minimum)', 'leads', 'text', 55)
ON CONFLICT (key) DO NOTHING;
