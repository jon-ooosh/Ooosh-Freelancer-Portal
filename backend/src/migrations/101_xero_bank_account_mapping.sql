-- ============================================================================
-- 101: Xero bank account mapping for Cost Capture push
--
-- Five system_settings keys — one per payment method that can be pushed as a
-- Spend Money. Values are the Xero AccountID (UUID) of the matching bank
-- account in Xero, set via the Settings page once Xero returns the list.
-- Empty value = no mapping = costs paid via that method won't push (the
-- cost-xero-push service surfaces this as a soft error with a retry button).
-- ============================================================================

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('xero_bank_cot_card',     '', 'Company card (COT)',          'xero_bank_accounts', 'xero_bank_account', 10),
  ('xero_bank_petty_cash',   '', 'Petty cash',                  'xero_bank_accounts', 'xero_bank_account', 20),
  ('xero_bank_paypal',       '', 'PayPal',                      'xero_bank_accounts', 'xero_bank_account', 30),
  ('xero_bank_reimburse_me', '', 'Reimburse me (staff repays)', 'xero_bank_accounts', 'xero_bank_account', 40),
  ('xero_bank_other',        '', 'Other',                       'xero_bank_accounts', 'xero_bank_account', 50)
ON CONFLICT (key) DO NOTHING;
