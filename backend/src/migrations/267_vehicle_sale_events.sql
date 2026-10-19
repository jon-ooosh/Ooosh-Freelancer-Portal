-- 267_vehicle_sale_events.sql
-- Selling a van — Phase 3: the activity log (docs/VEHICLE-SALES-SPEC.md §7).
--
-- Staff log what happened (viewings, listings, contacts, offers, notes); OP
-- logs stage changes and share links itself. A follow-up is a To Do item
-- (staff_tasks, source_type = 'vehicle_sale') — task_id points at it, the
-- task row is owned by the To Do module.
--
-- "who" is free text for now (a dealer, "Dave from the band") — linking to a
-- person / organisation record is deliberately not built yet.

CREATE TABLE IF NOT EXISTS vehicle_sale_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id       UUID NOT NULL REFERENCES vehicle_sales(id) ON DELETE CASCADE,
  type          VARCHAR(20) NOT NULL CHECK (type IN (
                  'note', 'viewing', 'listed', 'contact', 'offer',
                  'status_change', 'link_created', 'link_revoked')),
  occurred_on   DATE NOT NULL DEFAULT CURRENT_DATE,
  who           VARCHAR(200),
  text          TEXT,
  amount        NUMERIC(12,2),                       -- offers
  offer_status  VARCHAR(10) CHECK (offer_status IN ('open', 'accepted', 'declined')),
  listing_site  VARCHAR(100),                        -- listings
  listing_url   TEXT,
  task_id       UUID REFERENCES staff_tasks(id) ON DELETE SET NULL,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_sale_events_sale ON vehicle_sale_events (sale_id, occurred_on DESC, created_at DESC);
