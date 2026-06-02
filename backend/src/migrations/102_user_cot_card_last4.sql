-- ============================================================================
-- 102: COT card last 4 on users
--
-- Each staff member sets the last 4 of their company card on Profile. On cost
-- capture (payment_method='cot_card') the backend stamps the card holder name
-- + last 4 onto the cost from the logged-in user — staff no longer enters
-- either every time.
-- ============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS cot_card_last4 VARCHAR(4);
