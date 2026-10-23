-- Retire the overtime and working-from-home bells whose request was already
-- decided (jon, Oct 2026). Migration 305 did this for leave requests.
--
-- From this release, deciding or withdrawing an overtime entry or a WFH
-- request marks every approver's bell for it read and done
-- (services/staff-notifications.ts retireOvertimeBells / retireWfhBells).
-- Ones decided BEFORE it still have their bells lit; this clears those once,
-- by the same rule: only the approvers' `follow_up` bells (the person's own
-- "Overtime approved" / "Working from home approved" bell is `system` and is
-- left alone), and only where the entry is no longer pending. Re-running it
-- changes nothing.

UPDATE notifications n
   SET is_read = true,
       read_at = COALESCE(n.read_at, NOW()),
       acknowledged_at = NOW()
  FROM staff_overtime_entries e
 WHERE n.entity_type = 'staff_overtime_entry'
   AND n.type = 'follow_up'
   AND n.entity_id = e.id
   AND n.acknowledged_at IS NULL
   AND e.status <> 'pending';

UPDATE notifications n
   SET is_read = true,
       read_at = COALESCE(n.read_at, NOW()),
       acknowledged_at = NOW()
  FROM staff_wfh_requests w
 WHERE n.entity_type = 'staff_wfh_request'
   AND n.type = 'follow_up'
   AND n.entity_id = w.id
   AND n.acknowledged_at IS NULL
   AND w.status <> 'pending';
