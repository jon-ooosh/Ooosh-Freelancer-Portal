-- 053 — Shared portal accounts (staff shared logins)
--
-- Some portal users represent multiple physical staff — info@oooshtours.co.uk
-- is the canonical example. When a staff member logs in via this shared
-- account they should see all "Ooosh crew" quote assignments (local D&C /
-- in-house collections), not just ones pinned to a specific person.
--
-- The completion form already prompts for an actual staff name when an
-- @oooshtours.co.uk address is logged in, so per-person accountability is
-- preserved in completion_notes/completed_by.

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS is_portal_shared_account BOOLEAN NOT NULL DEFAULT false;

-- Flag info@oooshtours.co.uk if it's already in the people table (idempotent
-- — safe to re-run, safe if the row doesn't exist yet).
UPDATE people
SET is_portal_shared_account = true
WHERE lower(email) = 'info@oooshtours.co.uk'
  AND is_freelancer = true;
