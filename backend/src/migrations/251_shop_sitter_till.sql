-- ============================================================================
-- 251: Shop sales — the sitter till (freelancer portal)
-- ============================================================================
-- docs/SHOP-SALES-SPEC.md §5. Studio sitters sell from their phone on the
-- night they're rostered. Three things the ledger needs for that:
--
-- 1. WHO. Sitters are `people`, not OP `users` — they log in to the portal,
--    not the staff site. `recorded_by` (→ users) becomes optional and a sale
--    records `recorded_by_person_id` instead; a CHECK keeps "someone recorded
--    this" true for every row. Same for who cancelled.
-- 2. WHICH NIGHT. `shift_id` ties a sitter sale to the evening it was taken,
--    so the lock-up report can show that night's takings.
-- 3. REVIEW. Sitter sales land `needs_review` (migration 240). Staff tick them
--    off (`reviewed_at`); a reminder goes out if they sit unreviewed.
--
-- Plus the lock-up report's "Have the clients paid?" becomes "Any money
-- outstanding?" (jon, Sep 2026) — the till now records what WAS paid.
-- ============================================================================

ALTER TABLE shop_sales ALTER COLUMN recorded_by DROP NOT NULL;

ALTER TABLE shop_sales
  ADD COLUMN IF NOT EXISTS recorded_by_person_id  UUID REFERENCES people(id),
  ADD COLUMN IF NOT EXISTS cancelled_by_person_id UUID REFERENCES people(id),
  ADD COLUMN IF NOT EXISTS shift_id               UUID REFERENCES studio_sitter_shifts(id),
  ADD COLUMN IF NOT EXISTS reviewed_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by            UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS review_reminded_at     TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shop_sales_recorded_by_someone') THEN
    ALTER TABLE shop_sales ADD CONSTRAINT shop_sales_recorded_by_someone
      CHECK (recorded_by IS NOT NULL OR recorded_by_person_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shop_sales_shift ON shop_sales (shift_id) WHERE shift_id IS NOT NULL;

-- How long a sitter sale may sit unreviewed before a reminder, and who gets it.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('shop_review_reminder_hours', '12',
   'Shop — remind after N hours if sitter sales are unreviewed', 'shop', 'text', 90),
  ('shop_review_reminder_to', 'info@oooshtours.co.uk',
   'Shop — who gets the "review sitter sales" reminder', 'shop', 'text', 91)
ON CONFLICT (key) DO NOTHING;

-- ── Lock-up template: "Have the clients paid?" → "Any money outstanding?" ──
-- The template is staff-editable (Settings), so this only replaces the item if
-- it is still exactly as seeded (migration 172). An edited one is left alone —
-- change it in Settings instead. A NEW item id, because the answer flips
-- meaning (expected "no" rather than "yes"): old reports' `clients_paid`
-- answers must not be re-read as "money outstanding: yes".
UPDATE system_settings
   SET value = jsonb_set(
         jsonb_set(value::jsonb, '{items}', (
           SELECT jsonb_agg(
                    CASE WHEN e->>'id' = 'clients_paid'
                         THEN jsonb_build_object(
                                'id', 'money_outstanding',
                                'section', e->>'section',
                                'label', 'Any money outstanding? (anything a band still owes that didn''t go through the shop till)',
                                'type', 'yesno',
                                'expected', 'no',
                                'note_prompt', 'Who owes what, and what for?')
                         ELSE e END
                    ORDER BY ord)
             FROM jsonb_array_elements(value::jsonb->'items') WITH ORDINALITY AS t(e, ord)
         )),
         '{version}', to_jsonb(COALESCE((value::jsonb->>'version')::int, 1) + 1)
       )::text,
       updated_at = NOW()
 WHERE key = 'studio_sitter_lockup_template'
   AND value::jsonb->'items' @> '[{"id":"clients_paid","label":"Have the clients paid? (if so, note how below and put the card receipt in the till)"}]'::jsonb;
