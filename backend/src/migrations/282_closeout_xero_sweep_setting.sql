-- 282: the hire close-out's nightly Xero credit sweep is switched on here
-- (docs/HIRE-CLOSE-OUT-SPEC.md §4.3 step 2, Phase 3a). Off until jon flips it:
-- it applies HireHop's existing allocations as overpayment credits in Xero,
-- one job at a time, and the bookkeeper has been doing that by hand.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('closeout_xero_sweep_enabled', 'false',
        'Nightly sweep: apply HireHop payment allocations as credits in Xero (hire close-out)',
        'money', 'bool', 50)
ON CONFLICT (key) DO NOTHING;
