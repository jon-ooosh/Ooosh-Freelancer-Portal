-- Out-of-hours returns for freelancers become automatic for late van returns
-- (jon, Nov 2026; services/freelancer-ooh-return.ts, FREELANCER-PORTAL-SPEC.md §8).
--
-- quotes.ooh_return is now three-way:
--   NULL  = automatic: decided on the job's day from when the van should be back
--           in the yard (venue time + time on site + the drive back)
--   TRUE  = a person turned it on
--   FALSE = a person turned it off
-- The automatic answer is never stored, so a time changed later can't leave a
-- stale copy behind.
ALTER TABLE quotes ALTER COLUMN ooh_return DROP NOT NULL;
ALTER TABLE quotes ALTER COLUMN ooh_return DROP DEFAULT;

-- Until now FALSE only meant "nobody ticked it" (migration 335's default), so
-- those become automatic. TRUE (a person's tick) stays.
UPDATE quotes SET ooh_return = NULL WHERE ooh_return = false;

-- The rule's times, editable in Settings › Out-of-Hours Returns. The office is
-- open 09:00 to 17:00, seven days a week, bank holidays included: a van due back
-- at 16:40 or later, or before 09:00, gets the out-of-hours email by default.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('ooh_auto_from',  '16:40', 'Freelancer van due back at or after (HH:MM): out-of-hours email by default', 'ooh_returns', 'text', 72),
  ('ooh_auto_until', '09:00', 'Freelancer van due back before (HH:MM, morning): out-of-hours email by default', 'ooh_returns', 'text', 74)
ON CONFLICT (key) DO NOTHING;
