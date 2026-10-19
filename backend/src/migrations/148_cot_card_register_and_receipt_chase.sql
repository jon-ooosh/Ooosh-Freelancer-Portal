-- COT card register (admin-managed) + receipt-chase dedup.
--
-- cot_card_label: a friendly label for each staff member's company card
-- (e.g. "Amex ·1234") so the admin register and the capture stamp read clearly.
-- Admin sets it alongside cot_card_last4; staff never type card details.
ALTER TABLE users ADD COLUMN IF NOT EXISTS cot_card_label VARCHAR(60);

-- receipt_chase_sent_at: per-cost dedup stamp for the daily COT receipt chaser.
-- A cost with a company-card payment but no receipt attached gets one nudge to
-- its card-holder; re-fires only after the re-chase window (so it's not silent
-- forever, but isn't daily spam either). Cleared implicitly when a receipt lands
-- (the cost drops out of the scan).
ALTER TABLE costs ADD COLUMN IF NOT EXISTS receipt_chase_sent_at TIMESTAMPTZ;
