-- 155_hire_form_email_claim.sql
--
-- Atomic claim marker for the own-van hire-agreement email.
--
-- The hire agreement PDF+email (generateAndEmailHireFormPdf) can now be
-- triggered from TWO server-side paths for a single book-out:
--   1. PATCH /api/hire-forms/:id  (BookOutPage write-back loop)
--   2. POST /api/vehicles/save-event  (the condition-report / walkaround path)
--
-- Path 2 was added so a freelancer book-out that only fires save-event (and
-- never the PATCH loop) still emails the customer their agreement — the Tobi
-- misfire, HH 15669, 2 Jul 2026. But with both paths live, a normal staff
-- book-out fires both, and the old idempotency guard (read hire_form_emailed_at,
-- then generate+send seconds later) has a race window where two concurrent
-- triggers both see NULL and both email the customer.
--
-- This column is the atomic claim that closes that race: the send is claimed
-- with a conditional UPDATE before the expensive PDF+email work, and the claim
-- is cleared on any non-success exit so a retry (or a later trigger) can
-- re-attempt. hire_form_emailed_at stays the authoritative "it's been sent"
-- marker; this is only the in-flight lock.

ALTER TABLE vehicle_hire_assignments
  ADD COLUMN IF NOT EXISTS hire_form_email_claimed_at TIMESTAMPTZ;
