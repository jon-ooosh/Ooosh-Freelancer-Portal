-- 350: one money-off system (jon, 18 Nov 2026 — docs/GOODWILL-CREDIT-SPEC.md §17).
--
-- Goodwill credits and vouchers merge: EVERY credit is a voucher with one random code,
-- used everywhere (the client quotes it, staff type it into OP, it goes in HireHop's line
-- note). The GW ref stays in the table as an internal id and old GW refs keep working,
-- but no screen shows it any more.
--
-- Every credit that has no code yet gets one here — including the live GW-0001 — with a
-- face value of its ex-VAT amount + 20%. Codes are 12 characters from the voucher alphabet
-- (no 0/O, 1/I/L), drawn from gen_random_uuid() (a strong random source, built in).

DO $$
DECLARE
  alphabet CONSTANT text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  r record;
  bytes bytea;
  code text;
  i int;
  -- A v4 uuid fixes some bits of bytes 6 and 8 (version / variant); skip those two.
  idx CONSTANT int[] := ARRAY[0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13];
BEGIN
  FOR r IN SELECT id FROM goodwill_credits WHERE voucher_code IS NULL LOOP
    LOOP
      bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
      code := '';
      FOR i IN 1..12 LOOP
        code := code || substr(alphabet, (get_byte(bytes, idx[i]) % 31) + 1, 1);
        IF i = 4 OR i = 8 THEN code := code || '-'; END IF;
      END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM goodwill_credits WHERE voucher_code = code);
    END LOOP;
    UPDATE goodwill_credits
       SET voucher_code = code,
           voucher_value_inc_vat = ROUND(amount_ex_vat * 1.2, 2),
           updated_at = NOW()
     WHERE id = r.id;
  END LOOP;
END $$;

-- The referral emails switch now covers all four (both rewards are sent automatically).
UPDATE system_settings
   SET label = 'Send the referral emails: someone you recommended got in touch, they booked, the friend''s welcome voucher, and the thank-you voucher (Marketing › Referrals)'
 WHERE key = 'referral_emails_enabled';
