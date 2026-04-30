-- Unify "Ooosh Crew" / "Ooosh Staff" representation in quote_assignments.
--
-- Until now there have been two competing patterns for "in-house Ooosh person
-- did this" on quote_assignments:
--   (A) person_id = OOOSH_STAFF_ID + is_ooosh_crew = true  (from local D&C path)
--   (B) person_id = NULL          + is_ooosh_crew = true  (from /assignments/ooosh-crew path)
-- Plus a third in practice:
--   (C) person_id = OOOSH_STAFF_ID + is_ooosh_crew = false (drift — flag never set)
--
-- This migration consolidates onto pattern (A) for every row that represents
-- in-house work. The portal already authenticates the shared info@ account
-- against OOOSH_STAFF_ID, so this also means shared-account access matches
-- through person_id without relying on the is_ooosh_crew widening clause in
-- portal.ts.

-- Step 1: Delete NULL-person rows that would conflict with an existing
-- OOOSH_STAFF_ID row on the same quote (would violate UNIQUE(quote_id, person_id)
-- when we promote them in step 2). Rare but possible.
DELETE FROM quote_assignments a
WHERE a.person_id IS NULL
  AND a.is_ooosh_crew = true
  AND EXISTS (
    SELECT 1 FROM quote_assignments b
    WHERE b.quote_id = a.quote_id
      AND b.person_id = '00000000-0000-0000-0000-000000000001'
  );

-- Step 2: Promote remaining NULL-person Ooosh Crew rows to use the system
-- Ooosh Staff person record.
UPDATE quote_assignments
SET person_id = '00000000-0000-0000-0000-000000000001',
    updated_at = NOW()
WHERE person_id IS NULL AND is_ooosh_crew = true;

-- Step 3: Catch in-house rows attached to OOOSH_STAFF_ID where the flag was
-- never set true (the 163 false rows we measured before this work).
UPDATE quote_assignments
SET is_ooosh_crew = true,
    updated_at = NOW()
WHERE person_id = '00000000-0000-0000-0000-000000000001'
  AND is_ooosh_crew = false;
