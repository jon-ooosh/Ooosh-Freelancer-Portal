-- Retire the leave-request bells whose request was already decided (jon, Oct 2026).
--
-- From this release, approving, declining or withdrawing a leave request marks
-- every approver's "X has requested holiday" bell read and done
-- (services/notification-resolve.ts, retireLeaveRequestBells). Requests
-- decided BEFORE it still have their bells lit; this clears those once, by
-- the same rule: only the approvers' `follow_up` bells (the requester's own
-- "Time off approved" bell is `system` and is left alone), and only where the
-- request is no longer pending. Re-running it changes nothing.

UPDATE notifications n
   SET is_read = true,
       read_at = COALESCE(n.read_at, NOW()),
       acknowledged_at = NOW()
  FROM staff_leave_requests r
 WHERE n.entity_type = 'staff_leave_request'
   AND n.type = 'follow_up'
   AND n.entity_id = r.id
   AND n.acknowledged_at IS NULL
   AND r.status <> 'pending';
