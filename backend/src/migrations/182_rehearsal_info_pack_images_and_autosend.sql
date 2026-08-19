-- 182: Info-pack photos + auto-send settings (Rehearsals A + B)
--
-- A — pictures/PDFs in the client info-pack email. Image list stored as a JSON
--     array in one system_settings row; images live in the PUBLIC R2 bucket so
--     the inline <img> URLs are durable (don't expire like presigned links).
--     Shape: [{ "key": "<public r2 key>", "filename": "...", "caption": "..." }]
-- B — auto-send the info pack at T-N days before the rehearsal (like hire forms
--     / carnet). Off by default; N configurable.
--
-- All in category 'rehearsals'; managed from the Rehearsals hub → Info Pack tab
-- via dedicated controls (these three keys are NOT rendered as plain text fields).

INSERT INTO system_settings (key, value, label, category, value_type, sort_order) VALUES
  ('rehearsal_info_pack_images',       '[]',    'Info-pack photos',                 'rehearsals', 'json', 70),
  ('rehearsal_info_pack_auto_enabled', 'false', 'Auto-send info pack',              'rehearsals', 'bool', 80),
  ('rehearsal_info_pack_auto_days',    '7',     'Auto-send days before rehearsal',  'rehearsals', 'text', 90)
ON CONFLICT (key) DO NOTHING;
