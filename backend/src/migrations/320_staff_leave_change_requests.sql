-- ============================================================================
-- 320: Staff Calendar — asking to CHANGE or CANCEL approved time off
-- ============================================================================
-- Spec §5.4 (jon, Oct 2026). Until now an approved holiday could not be touched
-- from any screen: staff could only withdraw a request still waiting, and the
-- admin-only cancel route had no button. Staff now ask, in writing, and an
-- admin approves — same shape as every other request in this module.
--
-- A CHANGE is a new pending request that REPLACES an approved one
-- (replaces_request_id). Nothing moves until it is approved: approving it
-- cancels the original (a 'cancellation' credit) and approves the new one (a
-- 'booking' debit) in one transaction, so the ledger shows both facts and the
-- person is never left with neither. Declining or withdrawing it leaves the
-- original exactly as it was.
--
-- Its day rows are written with is_live = false while it waits, because they
-- usually overlap the booking they replace and the no-double-booking index
-- (migration 209) would otherwise refuse them. The existing status trigger
-- makes them live the moment the change is approved — AFTER the original has
-- been cancelled in the same transaction, so the index never sees both.
--
-- A CANCEL ask has no days of its own, so it is three columns on the approved
-- request itself. Approving it is the ordinary cancel; declining it records the
-- reason the person is shown, and the booking stands.
--
-- Additive only: every existing row has these NULL, which means "never asked".
-- ============================================================================

ALTER TABLE staff_leave_requests
  ADD COLUMN IF NOT EXISTS replaces_request_id UUID REFERENCES staff_leave_requests(id),
  ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_requested_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancel_request_note TEXT,
  ADD COLUMN IF NOT EXISTS cancel_declined_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_declined_by  UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancel_decline_note TEXT;

-- One change waiting per booking. Two at once would each try to cancel the
-- same original on approval; the database says no rather than the service
-- remembering to.
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_leave_one_pending_change
  ON staff_leave_requests(replaces_request_id)
  WHERE status = 'pending' AND replaces_request_id IS NOT NULL;

-- The approvals list asks "which approved bookings have a cancel ask waiting?"
CREATE INDEX IF NOT EXISTS idx_staff_leave_cancel_asked
  ON staff_leave_requests(cancel_requested_at)
  WHERE status = 'approved' AND cancel_requested_at IS NOT NULL AND cancel_declined_at IS NULL;
