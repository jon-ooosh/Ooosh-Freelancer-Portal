-- ============================================================================
-- 150: Cost recharge — resolution lifecycle + markup
--
-- A flagged recharge previously had only two visible states: pending (flagged,
-- not pushed) or gone (pushed to HireHop, recharged_to_hh_at stamped). This adds
-- a proper terminal lifecycle so a recharge always ends "Done" in one of three
-- ways, and records the markup that was applied so the billed figure is auditable.
--
-- recharge_status:
--   pending             — flagged (recharge_mode <> 'none'), not yet resolved
--   recharged_hh        — pushed to HireHop as a billable line (the existing path)
--   recharged_external  — billed another way (direct Xero invoice etc; HH job closed)
--   absorbed            — deliberately not recharged / written off (reason required)
-- NULL when recharge_mode = 'none' (never was a recharge).
--
-- Markup is applied at confirm time, ex VAT (the figure pushed to HH is net; HH's
-- 20%-rated recharge stock items add the VAT). recharge_amount stays the final
-- (post-markup, net) figure billed; the three new markup columns record how it
-- was reached. See docs/COST-CAPTURE-RECHARGE-SPEC.md — "Phase D".
-- ============================================================================

ALTER TABLE costs ADD COLUMN IF NOT EXISTS recharge_status         VARCHAR(20);
ALTER TABLE costs ADD COLUMN IF NOT EXISTS recharge_base_amount    NUMERIC(12,2);  -- net cost before markup
ALTER TABLE costs ADD COLUMN IF NOT EXISTS recharge_markup_type    VARCHAR(12);    -- greater_of | percent | fixed | none
ALTER TABLE costs ADD COLUMN IF NOT EXISTS recharge_markup_value   NUMERIC(12,2);  -- the percent or fixed value used
ALTER TABLE costs ADD COLUMN IF NOT EXISTS recharge_resolution_note TEXT;          -- absorb reason / external reference
ALTER TABLE costs ADD COLUMN IF NOT EXISTS recharge_resolved_by    UUID REFERENCES users(id);
ALTER TABLE costs ADD COLUMN IF NOT EXISTS recharge_resolved_at    TIMESTAMPTZ;

COMMENT ON COLUMN costs.recharge_status IS
  'Recharge resolution: pending | recharged_hh | recharged_external | absorbed. NULL when recharge_mode=none.';

-- Backfill existing flagged recharges into the new lifecycle.
UPDATE costs SET recharge_status = 'recharged_hh'
  WHERE recharge_mode <> 'none' AND recharged_to_hh_at IS NOT NULL AND recharge_status IS NULL;
UPDATE costs SET recharge_status = 'pending'
  WHERE recharge_mode <> 'none' AND recharged_to_hh_at IS NULL AND recharge_status IS NULL;

-- The pending bucket is now keyed on recharge_status (replaces the
-- recharged_to_hh_at IS NULL test, which can't see the two new terminal states).
CREATE INDEX IF NOT EXISTS idx_costs_recharge_pending
  ON costs(recharge_status) WHERE recharge_status = 'pending';

-- Default markup config (ex VAT). system_settings PUT is update-only, so seed.
-- Default rule: greater of 20% of the net cost or a £10 floor.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order) VALUES
  ('cost_recharge_default_markup_type',    'greater_of', 'Default recharge markup type (greater_of | percent | fixed | none)', 'cost_recharge', 'text', 10),
  ('cost_recharge_default_markup_percent', '20',         'Default recharge markup percent',                                      'cost_recharge', 'text', 20),
  ('cost_recharge_default_markup_floor',   '10',         'Default recharge markup minimum (£, ex VAT)',                          'cost_recharge', 'text', 30)
ON CONFLICT (key) DO NOTHING;

-- Post-hire close-out card for resolving client recharges (sibling of excess_resolve).
INSERT INTO requirement_type_definitions (type, label, icon, steps, sort_order) VALUES
  ('cost_resolve', 'Cost Recharge', '💸', NULL, 225)
ON CONFLICT (type) DO NOTHING;
