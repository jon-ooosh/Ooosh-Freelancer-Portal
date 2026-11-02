-- 319_soft_checked_in_by.sql
--
-- WHO collected the van, beside soft_checked_in_at (migration 158) — the
-- freelancer (or the shared Ooosh crew account) whose portal collection
-- stamped it. Read by the Job Detail "Vehicles on this job" strip:
-- "RX21UOB collected by Rich Allwood · Sun 25 Oct, 10:53 · awaiting check-in
-- at base", until the warehouse's final check-in. Written only by the
-- freelancer soft check-in in POST /api/vehicles/save-event; NULL on every
-- row collected before this column existed.

ALTER TABLE vehicle_hire_assignments
  ADD COLUMN IF NOT EXISTS soft_checked_in_by_person_id UUID REFERENCES people(id) ON DELETE SET NULL;
