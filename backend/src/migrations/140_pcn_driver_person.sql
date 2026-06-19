-- ============================================================================
-- 139: PCN driver person link
--
-- A PCN's responsible driver can be a client self-drive driver (drivers table,
-- existing pcns.driver_id) OR a freelancer/crew person who was driving an Ooosh
-- van (people table — no drivers row). The latter had no home, so this adds an
-- optional person link alongside driver_id. Exactly one of the two is set at a
-- time (the picker clears the other); both null = unassigned.
-- ============================================================================

ALTER TABLE pcns ADD COLUMN IF NOT EXISTS driver_person_id UUID REFERENCES people(id);

CREATE INDEX IF NOT EXISTS idx_pcns_driver_person ON pcns(driver_person_id) WHERE is_deleted = false;
