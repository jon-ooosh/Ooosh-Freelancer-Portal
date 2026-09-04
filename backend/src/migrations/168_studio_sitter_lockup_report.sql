-- 168: Studio-sitter end-of-day lock-up report (Rehearsals module, Phase E)
--
-- The "Finish for the night" report a studio sitter fills in when they lock up.
-- Port of the Jotform lock-up form, but configurable (template in system_settings),
-- soft (warnings not gates), and no PDF. See docs/REHEARSALS-SPEC.md §4.
--
-- Storage: four report_* columns on studio_sitter_shifts. The `closed` status
-- already existed on the shift CHECK; a submitted report sets status='closed'.
--
--   report_answers          JSONB   — { answers: {itemId: value}, notes, continuing_tomorrow, ... }
--   report_template_version INT     — the template version answered against (for future migrations)
--   report_submitted_by     UUID    — the SITTER (people row; sitters are freelancers, not OP users)
--   report_submitted_at     TIMESTAMPTZ
--
-- Template + reference photos live in system_settings (category studio_sitter),
-- admin-editable in Settings (OOH-returns pattern). Seeded with a sensible
-- lock-up checklist; jon tunes the wording/items without a deploy.

ALTER TABLE studio_sitter_shifts
  ADD COLUMN IF NOT EXISTS report_answers JSONB,
  ADD COLUMN IF NOT EXISTS report_template_version INT,
  ADD COLUMN IF NOT EXISTS report_submitted_by UUID REFERENCES people(id),
  ADD COLUMN IF NOT EXISTS report_submitted_at TIMESTAMPTZ;

-- ── Template + reference photos (system_settings, category studio_sitter) ────
-- value is a JSON string (system_settings.value is TEXT). The lock-up sub-page +
-- the Settings editor parse/serialise it. Each checklist item carries an
-- `expected` value; an off-expected answer is flagged. `end_of_booking_only`
-- items are gated on the DERIVED "continuing tomorrow?" answer (auto-hidden when
-- the studio is in use the next day).

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  (
    'studio_sitter_lockup_template',
    '{"version":1,"intro":"Quick walk round before you lock up. Flag anything that isn''t right — we''d rather know tonight than find out tomorrow.","items":[{"id":"rooms_tidy","label":"Rehearsal rooms tidied and reset","type":"yesno","expected":"yes"},{"id":"our_gear_back","label":"All Ooosh gear back in its place / nothing left out","type":"yesno","expected":"yes"},{"id":"heating_off","label":"Heating / aircon / fans turned off","type":"yesno","expected":"yes"},{"id":"lights_off","label":"Lights off in all rooms and common areas","type":"yesno","expected":"yes"},{"id":"taps_off","label":"Taps off, no water left running","type":"yesno","expected":"yes"},{"id":"windows_closed","label":"All windows closed and latched","type":"yesno","expected":"yes"},{"id":"back_doors_locked","label":"Fire exits / back doors closed and bolted","type":"yesno","expected":"yes"},{"id":"front_door_locked","label":"Front door locked","type":"yesno","expected":"yes"},{"id":"alarm_set","label":"Alarm set","type":"yesno","expected":"yes"},{"id":"bins_out","label":"Bins taken out / emptied","type":"yesno","expected":"yes","end_of_booking_only":true},{"id":"kitchen_clean","label":"Kitchen / common areas cleaned down","type":"yesno","expected":"yes","end_of_booking_only":true},{"id":"nothing_left_by_band","label":"Nothing left behind by the band (check for lost property)","type":"yesno","expected":"yes"}],"notes_label":"Anything we need to know? Money owed, items taken, jobs for tomorrow, anything left undone.","lost_property_prompt":"Found something a band left behind? Log it in Holding so we can get it back to them."}',
    'Lock-up report template',
    'studio_sitter',
    'json',
    10
  ),
  (
    'studio_sitter_lockup_reference_photos',
    '[]',
    'Lock-up reference photos',
    'studio_sitter',
    'json',
    20
  )
ON CONFLICT (key) DO NOTHING;
