-- ============================================================================
-- 362: Premises & compliance — phase 3b (docs/PREMISES-COMPLIANCE-SPEC.md §16)
-- ============================================================================
--   * A BOOKED VISIT: "Northside are coming on 14 Dec at 10:00, Sam letting
--     them in". At most one live booking per check (unique index). It turns
--     the owner's "Book: …" To Do into "… coming on … — let them in" for whoever
--     is letting them in, shows on the staff calendar (a read-through lane, via
--     GET /premises/visits — the calendar's own tables are not touched), and is
--     marked done when the visit is recorded. Soft-cancelled, never deleted.
--   * reminded_key: what the check's open To Do was last made for — a due date
--     ("due:2026-12-14") or a booking ("booking:<id>:<date>") — so a To Do ticked
--     by hand isn't made again for the same thing. Replaces reading
--     reminded_for_due alone (which is still written and still honoured).
--   * staff_document_id: a check can point at a Staff Document (the fire
--     procedure for the fire risk assessment); recording a visit then offers to
--     re-issue it. Linked, never copied.
-- ============================================================================

CREATE TABLE IF NOT EXISTS premises_bookings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id              UUID NOT NULL REFERENCES premises_checks(id),
  visit_on              DATE NOT NULL,
  -- "HH:MM" on the quarter hour from the form; NULL = no set time.
  visit_time            TEXT CHECK (visit_time IS NULL OR visit_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  letting_in_person_id  UUID REFERENCES people(id),
  note                  TEXT,
  status                VARCHAR(10) NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'done', 'cancelled')),
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at          TIMESTAMPTZ,
  cancelled_by          UUID REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_premises_bookings_live ON premises_bookings(check_id) WHERE status = 'booked';
CREATE INDEX IF NOT EXISTS idx_premises_bookings_date ON premises_bookings(visit_on) WHERE status <> 'cancelled';

ALTER TABLE premises_checks ADD COLUMN IF NOT EXISTS reminded_key TEXT;
ALTER TABLE premises_checks ADD COLUMN IF NOT EXISTS staff_document_id UUID REFERENCES staff_documents(id);
