-- "PCN date" — the date the notice was issued / dated (as printed on the notice).
-- Distinct from offence_at (when the contravention happened): the issue date is
-- usually what starts the payment / appeal clock ticking. Nullable; existing rows
-- and Monday-imported historical PCNs have no value until re-entered or
-- re-extracted (the Monday PCN board had no issue-date column to migrate).
ALTER TABLE pcns ADD COLUMN IF NOT EXISTS issued_date DATE;
