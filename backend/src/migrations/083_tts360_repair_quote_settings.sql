-- ============================================================================
-- Migration 083: TTS360 repair quote contact settings
-- ============================================================================
-- Seeds the system_settings rows the damage repair-quote email reads to
-- decide who to mail. Kept in system_settings (not hardcoded) so the team
-- can re-target without a deploy if Will moves on or TTS360 changes the
-- engineering address.
-- ============================================================================

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('tts360_engineering_email', 'engineering@tts360.co.uk', 'TTS360 engineering email (To)',              'external_contacts', 'text', 10),
  ('tts360_cc_email',          'will@oooshtours.co.uk',    'CC on TTS360 repair quote requests',         'external_contacts', 'text', 20),
  ('tts360_contract_reference', '',                        'Optional fixed contract reference for TTS360 (blank = use HH job number)', 'external_contacts', 'text', 30)
ON CONFLICT (key) DO NOTHING;
