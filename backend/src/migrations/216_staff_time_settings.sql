-- ============================================================================
-- 216: Staff Calendar & Time — the settings from spec §13, finally created
-- ============================================================================
-- §13 has specified these since the spec was written and Phases A–D shipped
-- without them: every threshold was a hardcoded default with a comment
-- pointing here. That was fine while the module was being built and is not
-- fine now, because spec §17 lists nine statutory specifics that want a sanity
-- check from the accountants BEFORE go-live — the rounding rule, whether bank
-- holidays are granted, how banked overtime is paid at year end. The whole
-- argument for them being settings was that a correction is a settings change
-- and not a deploy.
--
-- Read through services/staff-settings.ts, which is the only place that reads
-- them and which falls back to exactly these values if a row is missing or
-- malformed. Nothing breaks if someone empties one.
--
-- BANK HOLIDAYS ARE INFORMATIONAL, NOT TIME OFF. Policy is `use_allowance`:
-- a bank holiday is an ordinary working day, and someone who wants it off
-- books holiday like any other day. They are stored here as dates to MARK on
-- the calendar. They are emphatically NOT seeded as staff_pattern_exceptions —
-- that would make them non-working and silently hand everyone eight free days
-- a year that no ledger entry ever paid for.
-- ============================================================================

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('staff.statutory_weeks',                '5.6',
   'Holiday entitlement (weeks per year) — per-person override on the Staff page',
   'staff_time', 'text', 10),

  ('staff.bank_holidays_policy',           'use_allowance',
   'Bank holidays: use_allowance (normal working days) or granted (extra days off)',
   'staff_time', 'text', 20),

  ('staff.pro_rata_rounding',              'up_half_day',
   'Rounding for a part-year starter or leaver: up_half_day or none. Never rounds below statutory',
   'staff_time', 'text', 30),

  ('staff.leave_year_start_month',         '1',
   'Month the leave year starts (1 = January). Changing this is NOT supported by the code yet',
   'staff_time', 'text', 40),

  ('staff.overtime_year_end',              'cash_out',
   'Banked overtime at year end: cash_out (pay it) or expire (not advised — hours worked cannot be forfeited)',
   'staff_time', 'text', 50),

  ('staff.overtime_min_increment_minutes', '5',
   'Overtime is logged in steps of this many minutes. NB lowering it also needs a migration — the database enforces 5',
   'staff_time', 'text', 60),

  ('staff.overtime_cashout_reminder_day',  '8',
   'Day of December the year-end cash-out reminder is emailed. Early enough to reach December payroll',
   'staff_time', 'text', 70),

  ('staff.notice_days_warning',            '14',
   'Warn when a leave request gives less notice than this many days. A warning, never a block',
   'staff_time', 'text', 80),

  ('staff.min_headcount_by_weekday',       '{}',
   'Minimum people wanted in, as JSON keyed by weekday (Monday = 0). e.g. {"0":2,"4":1}. Empty = no floor',
   'staff_time', 'text', 90),

  ('staff.absence_flag_spells',            '3',
   'Repeat-absence flag: this many separate sickness spells…',
   'staff_time', 'text', 100),

  ('staff.absence_flag_months',            '3',
   '…within this many months. Spells matter more than days',
   'staff_time', 'text', 110),

  ('staff.rtw_chase_days',                 '7',
   'Days after a sickness absence closes before the one return-to-work chase',
   'staff_time', 'text', 120),

  -- England & Wales, computed rather than recalled, with weekend substitutes
  -- applied (26 Dec 2026 is a Saturday, so Boxing Day moves to Monday the
  -- 28th; Christmas AND Boxing Day both fall on the weekend in 2027).
  -- A comma-separated list so adding 2029 is an edit, not a deploy.
  ('staff.bank_holidays.2026',
   '2026-01-01,2026-04-03,2026-04-06,2026-05-04,2026-05-25,2026-08-31,2026-12-25,2026-12-28',
   'Bank holidays 2026 (England & Wales) — marked on the calendar, not time off',
   'staff_time', 'text', 200),

  ('staff.bank_holidays.2027',
   '2027-01-01,2027-03-26,2027-03-29,2027-05-03,2027-05-31,2027-08-30,2027-12-27,2027-12-28',
   'Bank holidays 2027 (England & Wales) — marked on the calendar, not time off',
   'staff_time', 'text', 210),

  ('staff.bank_holidays.2028',
   '2028-01-03,2028-04-14,2028-04-17,2028-05-01,2028-05-29,2028-08-28,2028-12-25,2028-12-26',
   'Bank holidays 2028 (England & Wales) — marked on the calendar, not time off',
   'staff_time', 'text', 220)
ON CONFLICT (key) DO NOTHING;

-- ── The year-end reminder needs somewhere to record that it fired ───────────
-- Same lesson as rtw_chased_at in migration 214: a reminder with nowhere to
-- stamp itself either never fires or fires every morning for three weeks. The
-- scheduler checks December daily rather than using an annual cron, so that a
-- server that happens to be down on the 8th still sends it on the 9th, and
-- this row is what stops it sending twice.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('staff.overtime_cashout_reminded_year', '',
   'Internal — the last year the cash-out reminder was sent. Clear it to make the reminder fire again',
   'staff_time', 'text', 300)
ON CONFLICT (key) DO NOTHING;
