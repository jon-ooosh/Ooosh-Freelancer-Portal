-- Migration 073: Drop ooh_overflow_photo_url system_setting
--
-- The "overflow parking photo URL" setting was seeded by migration 072 to let
-- the OOH info email render an optional "View nearest legal parking →" link.
-- Ooosh has no formal overflow car park — the email simply mentions the
-- seafront in plain text — so the photo link is unwanted noise on the
-- Settings page. The email template no longer references the variable
-- (the seafront line is plain text now).
--
-- Safe to drop: pure UI/email noise; no other code reads this key.

DELETE FROM system_settings WHERE key = 'ooh_overflow_photo_url';
