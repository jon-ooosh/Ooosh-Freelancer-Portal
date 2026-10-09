-- Migration 223: quote_contacts junction (who to call on a transport job)
-- ------------------------------------------------------------------------
-- Before this, a quote had NO contact field at all. `client_introduction` is
-- a STATUS (not_needed / todo / working_on_it / done), not a person. So the
-- site contact for a delivery was typed by hand into `freelancer_notes` —
-- surfaced to the portal as `keyNotes` — every single time, despite the job
-- already knowing every person at every org on it.
--
-- Why a junction rather than columns on `quotes`: for a delivery you routinely
-- want TWO — the tour manager and the venue/production contact. Columns would
-- have meant a second migration within months.
--
-- ── No snapshot columns, deliberately ────────────────────────────────────
-- `person_id` is a live reference; name / phone / email are resolved by join
-- at read time and never copied here. Snapshotting protects an immutable
-- record, but a site contact is operational data read for a few days around
-- the job: if the number changes you WANT the driver to get the new one.
-- Copying it would put us straight back to hand-maintained duplicates, which
-- is the problem this table exists to remove. It also matches CLAUDE.md's
-- "people are the primary entity" — a contact who isn't in the address book
-- gets added to it (with their phone), rather than living as loose text on
-- one quote.
--
-- `label` is the per-job role of this person ON THIS LEG ("Site contact",
-- "TM", "Venue duty manager"), which is not necessarily their org-level role
-- in `person_organisation_roles`. Free text, optional.
--
-- ── Kept separate from job_contacts, deliberately ───────────────────────
-- `job_contacts` (migration 086) drives CLIENT email routing — hire-form
-- requests, booking confirmations, payment receipts. Ticking a venue's duty
-- manager onto a delivery must never start sending them hire forms, so
-- nothing here writes to that table. The two share a candidate pool and
-- nothing else.
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS quote_contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id    UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  person_id   UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  label       VARCHAR(100),
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One person can't be on the same leg twice
  CONSTRAINT uq_quote_contact UNIQUE (quote_id, person_id)
);

CREATE INDEX IF NOT EXISTS idx_quote_contacts_quote ON quote_contacts (quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_contacts_person ON quote_contacts (person_id);
