-- 054 — Venue default tolls amount
--
-- The transport quoting calculator surfaces tolls as an operational flag
-- ("tolls: n/a / booked / paid"). We want repeat venues to supply a
-- default tolls figure the same way they supply default mileage and
-- drive time, so quoting stays quick for known destinations.
--
-- Nullable — no default, leave blank when unknown. Populated via the
-- Monday venues migration + editable in the venue edit form.

ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS default_tolls_amount DECIMAL(10, 2);

COMMENT ON COLUMN venues.default_tolls_amount IS 'Default tolls / congestion charge amount for this venue (£). Used as a pre-fill in transport quoting.';
