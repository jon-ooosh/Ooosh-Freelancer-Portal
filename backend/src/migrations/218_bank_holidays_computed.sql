-- ============================================================================
-- 218: Bank holidays are computed, not seeded
-- ============================================================================
-- Migration 216 seeded 2026, 2027 and 2028, which immediately raised the right
-- question: who adds 2029? Nobody does, and the calendar quietly stops marking
-- them — the kind of failure that is invisible until someone books a day they
-- thought was a holiday.
--
-- They do not need remembering. Seven of the eight are arithmetic and the
-- eighth is Easter; services/bank-holidays.ts derives any year, checked against
-- published dates from 2024 to 2040 in its unit tests.
--
-- So the per-year rows stay, but BLANK, and become an OVERRIDE for the rare
-- year the arithmetic needs correcting. Empty means "compute it". The seeded
-- values are cleared rather than left in place because a stale literal that
-- happens to match today is exactly what stops anyone noticing it has diverged.
--
-- ONE-OFF ROYAL BANK HOLIDAYS (a coronation, a jubilee, a state funeral) are
-- deliberately NOT this table's problem. They are not computable and they are
-- not really bank-holiday-calendar changes — they are "the company is shut that
-- day", which is what company days are for.
-- ============================================================================

UPDATE system_settings
   SET value = '',
       label = 'Bank holidays ' || RIGHT(key, 4) ||
               ' — OVERRIDE only. Leave empty and they are worked out automatically',
       updated_at = NOW()
 WHERE key IN ('staff.bank_holidays.2026', 'staff.bank_holidays.2027', 'staff.bank_holidays.2028');

-- Re-label the remaining rows so the Settings page explains itself.
UPDATE system_settings
   SET label = 'Bank holidays: use_allowance (normal working days) or granted (extra days off). Dates are worked out automatically',
       updated_at = NOW()
 WHERE key = 'staff.bank_holidays_policy';
