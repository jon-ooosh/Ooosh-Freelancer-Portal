-- 349: vouchers (docs/GOODWILL-CREDIT-SPEC.md §16, jon 17 Nov 2026).
--
-- A voucher IS a goodwill credit with a code on it — one system for "money off", not two.
-- The GW-0013 ref stays the INTERNAL reference (HireHop line notes, the read-back); the
-- voucher code is what the client is given. GW refs are sequential, so anyone could guess
-- one; the code is 12 random characters (about 60 bits), checked only by staff, single use.
--
-- A voucher's face value is INC VAT (jon: "£20 is inc VAT"), kept as typed in
-- voucher_value_inc_vat; amount_ex_vat (what every goodwill sum uses) is that ÷ 1.2.
-- Single use: whatever it doesn't take lapses (the goodwill rule).
--
-- A voucher can be held by nobody ("anyone with the code" — an ad hoc promo voucher),
-- which no other goodwill credit may be.

ALTER TABLE goodwill_credits ADD COLUMN IF NOT EXISTS voucher_code VARCHAR(20) UNIQUE;
ALTER TABLE goodwill_credits ADD COLUMN IF NOT EXISTS voucher_value_inc_vat NUMERIC(10,2);
-- Used at the shop till: the sale it came off (reinstated if that sale is cancelled / refunded).
ALTER TABLE goodwill_credits ADD COLUMN IF NOT EXISTS used_shop_sale_id UUID REFERENCES shop_sales(id) ON DELETE SET NULL;

ALTER TABLE goodwill_credits DROP CONSTRAINT IF EXISTS goodwill_credits_voucher_value;
ALTER TABLE goodwill_credits ADD CONSTRAINT goodwill_credits_voucher_value
  CHECK ((voucher_code IS NULL) = (voucher_value_inc_vat IS NULL)
         AND (voucher_value_inc_vat IS NULL OR voucher_value_inc_vat > 0));

ALTER TABLE goodwill_credits DROP CONSTRAINT IF EXISTS goodwill_credits_one_owner;
ALTER TABLE goodwill_credits ADD CONSTRAINT goodwill_credits_one_owner
  CHECK ((person_id IS NULL) <> (organisation_id IS NULL)
         OR (person_id IS NULL AND organisation_id IS NULL AND voucher_code IS NOT NULL));

ALTER TABLE goodwill_credits DROP CONSTRAINT IF EXISTS goodwill_credits_used_how_check;
ALTER TABLE goodwill_credits ADD CONSTRAINT goodwill_credits_used_how_check
  CHECK (used_how IN ('line', 'credit_note', 'manual', 'shop'));

-- 'voucher' = made by hand on Money › Vouchers.
ALTER TABLE goodwill_credits DROP CONSTRAINT IF EXISTS goodwill_credits_source_kind_check;
ALTER TABLE goodwill_credits ADD CONSTRAINT goodwill_credits_source_kind_check
  CHECK (source_kind IN ('close_out', 'problem', 'cancellation', 'organisation', 'person', 'referral', 'voucher'));

CREATE INDEX IF NOT EXISTS idx_goodwill_credits_vouchers ON goodwill_credits (offered_at DESC) WHERE voucher_code IS NOT NULL;

-- The referral offer's two vouchers, INC VAT. friend_credit_ex_vat is no longer read: jon
-- typed the friend's figure meaning inc VAT, so it is copied across as typed. The
-- referrer's figure is lifted out of the reward text ("a £20 discount voucher …").
ALTER TABLE referral_offers ADD COLUMN IF NOT EXISTS friend_voucher_inc_vat NUMERIC(10,2)
  CHECK (friend_voucher_inc_vat IS NULL OR friend_voucher_inc_vat > 0);
ALTER TABLE referral_offers ADD COLUMN IF NOT EXISTS referrer_voucher_inc_vat NUMERIC(10,2)
  CHECK (referrer_voucher_inc_vat IS NULL OR referrer_voucher_inc_vat > 0);
UPDATE referral_offers SET friend_voucher_inc_vat = friend_credit_ex_vat
 WHERE friend_voucher_inc_vat IS NULL AND friend_credit_ex_vat IS NOT NULL;
UPDATE referral_offers
   SET referrer_voucher_inc_vat = NULLIF(substring(referrer_reward FROM '£\s*([0-9]+(\.[0-9]{1,2})?)'), '')::numeric
 WHERE referrer_voucher_inc_vat IS NULL AND referrer_reward ~ '£\s*[0-9]';

-- The referrer's thank-you voucher, and when the friend was emailed their welcome voucher.
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS reward_credit_id UUID REFERENCES goodwill_credits(id) ON DELETE SET NULL;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS welcome_email_sent_at TIMESTAMPTZ;
