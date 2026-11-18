-- ============================================================================
-- 350: "Written off" is a resolution REASON now, not a Problem status
-- ============================================================================
-- docs/INCIDENT-CLAIMS-SPEC.md §23.1. Since §23 a resolved Problem says how it
-- was resolved (Repaired / Replaced / Found / Written off / No action / Other),
-- so a separate "Written off" status was a second way of saying the same
-- thing. Production had ONE row with it (Nov 2026).
--
-- That row moves to Resolved + reason "Written off" — unless it already had
-- one of the new reasons, which a person chose and is kept. The old money
-- answers (claim_excess / charge_client) said who paid, not what happened,
-- so they give way to "write_off" here.
--
-- The status stays valid in the CHECK constraint and in every "is it closed?"
-- filter (harmless, and an old export or script won't fail on it); the app
-- simply no longer sets it.
-- ============================================================================

-- On the Problem's timeline first, while the rows can still be found by status.
-- Logged as the system user (migration 075's fallback), only if it exists.
INSERT INTO job_issue_events (issue_id, event_type, body, metadata, created_by)
SELECT ji.id, 'status_change',
       'Written off is now a reason, not a status — moved to Resolved (written off)',
       jsonb_build_object('from_status', 'written_off', 'to_status', 'resolved', 'migration', '350'),
       '00000000-0000-0000-0000-000000000000'::uuid
FROM job_issues ji
WHERE ji.status = 'written_off'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = '00000000-0000-0000-0000-000000000000'::uuid);

UPDATE job_issues
SET status = 'resolved',
    resolution_path = CASE
      WHEN resolution_path IN ('repaired', 'replaced', 'found', 'write_off', 'no_action', 'other') THEN resolution_path
      ELSE 'write_off'
    END,
    updated_at = NOW()
WHERE status = 'written_off';
