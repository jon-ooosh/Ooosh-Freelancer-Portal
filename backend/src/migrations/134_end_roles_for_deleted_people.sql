-- 134: End stale organisation roles for already-soft-deleted people.
--
-- Soft-deleting a person used to leave their person_organisation_roles rows
-- with status='active', which (combined with org-people queries that didn't
-- filter is_deleted) caused deleted people to keep appearing in Org People
-- tabs and contact pickers. The delete handler now ends these roles going
-- forward; this is the one-off backfill for people deleted before that fix.
--
-- Idempotent: only touches active roles whose person is soft-deleted.

UPDATE person_organisation_roles por
SET status = 'historical',
    end_date = COALESCE(por.end_date, NOW()),
    updated_at = NOW()
FROM people p
WHERE p.id = por.person_id
  AND p.is_deleted = true
  AND por.status = 'active';
