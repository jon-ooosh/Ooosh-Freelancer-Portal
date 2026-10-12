-- 283: the hire close-out's arrival hook is switched on here
-- (docs/HIRE-CLOSE-OUT-SPEC.md §4.5, Phase 3b). Off until jon flips it: when a
-- hire payment lands on a job with exactly one invoice owing, it allocates THAT
-- payment to it in HireHop and applies the credit in Xero. Never completes a job.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('closeout_arrival_hook_enabled', 'false',
        'Allocate a hire payment automatically when it arrives on a job with one invoice owing (hire close-out)',
        'money', 'bool', 51)
ON CONFLICT (key) DO NOTHING;
