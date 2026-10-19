-- 292: card-reader receipts (docs/STRIPE-TERMINAL-SPEC.md §12).
--
-- A reader payment no longer emails the client the moment it records: the panel asks
-- "Send receipt?" while the client is at the desk. These columns hold that answer.
--
--   receipt_status: pending   = waiting for staff (the 5-minute sweep sends to the usual
--                               recipient once a payment has waited 15 minutes)
--                   sending   = claimed by whoever is sending it (never two at once)
--                   sent      = sent by staff to receipt_sent_to
--                   auto_sent = nobody answered; sent to the usual recipient
--                   skipped   = staff pressed "No receipt" (never allowed when
--                               confirmed_booking — that email is the booking confirmation)
--                   failed    = the automatic send failed; info@ was told
--   NULL on sessions from before this migration (their email went out at recording).
ALTER TABLE terminal_sessions
  ADD COLUMN IF NOT EXISTS confirmed_booking BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS receipt_status    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS receipt_sent_to   TEXT,
  ADD COLUMN IF NOT EXISTS receipt_at        TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_terminal_sessions_receipt_pending
  ON terminal_sessions(finished_at) WHERE receipt_status = 'pending';
