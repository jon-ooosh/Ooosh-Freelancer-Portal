-- ============================================================================
-- 105: Cost Capture — real payment instruments + payables-as-Xero-bills
--
-- Phase A of the "finish Cost Capture" work (Jun 2026). Three changes:
--
--   1. Retire the catch-all 'other' payment method. It could never push — a
--      Xero Spend Money must book against a real bank account, and 'other' has
--      none, so it sat stuck on "Not synced" forever. Existing 'other' rows are
--      nulled (payment unspecified) rather than guessed at. "Not yet paid"
--      (bill to pay) is now the proper home for the "unsure / sort later" case.
--
--   2. Add the real instruments Ooosh pays suppliers from: Amex, Lloyds credit
--      card, Wise transfer, Lloyds bank transfer. Each maps to a Xero bank
--      account (used for both the Spend Money push AND recording a payment
--      against a bill later).
--
--   3. Add `paid_value_date` — the date money actually moves (can be future, for
--      a scheduled bill payment), distinct from `paid_at` (the audit timestamp of
--      the "mark paid" click). Feeds the Xero Payment Date when a bill is paid.
--
-- The bill flow itself (not_yet_paid + reimburse_me → authorised ACCPAY bill on
-- OP approval, then a payment recorded against it when marked paid) is wired in
-- routes/costs.ts + services/cost-xero-push.ts. It goes live once the Xero
-- Custom Connection is granted the `accounting.transactions` scope.
-- ============================================================================

-- 1. Retire 'other' — null existing rows, then tighten the constraint.
UPDATE costs SET payment_method = NULL WHERE payment_method = 'other';

ALTER TABLE costs DROP CONSTRAINT IF EXISTS costs_payment_method_check;
ALTER TABLE costs ADD CONSTRAINT costs_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN
    ('cot_card', 'amex', 'lloyds_cc', 'petty_cash', 'paypal', 'wise',
     'lloyds_transfer', 'reimburse_me', 'not_yet_paid'));

-- 2. Date money actually moves (nullable; can be future for scheduled payment).
ALTER TABLE costs ADD COLUMN IF NOT EXISTS paid_value_date DATE;

-- 2b. Xero PaymentID recorded against a bill — set once the bill-payment leg
--     succeeds, so re-running the push never double-pays the bill in Xero.
ALTER TABLE costs ADD COLUMN IF NOT EXISTS xero_payment_id VARCHAR(60);

-- 3. Bank-account mapping rows. Drop 'other' (retired) and 'reimburse_me' (now
--    a pay-later bill — its payment posts to the chosen pay-method's bank
--    account, so it needs no mapping of its own). Add the four new instruments.
DELETE FROM system_settings WHERE key IN ('xero_bank_other', 'xero_bank_reimburse_me');

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('xero_bank_amex',           '', 'Amex card',            'xero_bank_accounts', 'xero_bank_account', 15),
  ('xero_bank_lloyds_cc',      '', 'Lloyds credit card',   'xero_bank_accounts', 'xero_bank_account', 25),
  ('xero_bank_wise',           '', 'Wise bank transfer',   'xero_bank_accounts', 'xero_bank_account', 60),
  ('xero_bank_lloyds_transfer','', 'Lloyds bank transfer', 'xero_bank_accounts', 'xero_bank_account', 70)
ON CONFLICT (key) DO NOTHING;
