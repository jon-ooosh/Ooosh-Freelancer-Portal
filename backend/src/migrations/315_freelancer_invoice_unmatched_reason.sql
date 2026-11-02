-- Why a freelancer invoice was saved without ticking the work it covers
-- (docs/FREELANCER-PORTAL-SPEC.md §5.1, jon, Oct 2026). Saving one with nothing
-- ticked asks why, but never blocks: 'person_not_in_op', 'work_not_in_op' or
-- 'later' (asked again on the next save). Shown in the Costs list so an
-- unmatched invoice can be spotted. Cleared when work is ticked.
ALTER TABLE costs ADD COLUMN IF NOT EXISTS work_unmatched_reason TEXT;
