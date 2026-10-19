-- 264_vehicle_sales.sql
-- Selling a van — Phase 1 (docs/VEHICLE-SALES-SPEC.md §4–5).
--
-- One sale per van at a time (partial unique index). The van stays active and
-- hireable throughout; nothing here touches fleet_vehicles. A sale ends as
-- 'sold' (via the existing sold modal, Phase 3) or 'withdrawn'.
--
-- Vehicle facts are read LIVE from fleet_vehicles etc. — never copied here.
-- Photos are the exception: chosen by a person, kept until a person changes
-- them. `photos_confirmed_at` is stamped on every photo change and on
-- "Photos still OK"; any Problem on the van created or re-flagged after it
-- means the photos need a look (computed, not stored).

CREATE TABLE IF NOT EXISTS vehicle_sales (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id          UUID NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,
  status              VARCHAR(20) NOT NULL DEFAULT 'preparing'
                        CHECK (status IN ('preparing', 'listed', 'under_offer', 'sold', 'withdrawn')),
  asking_price        NUMERIC(12,2),
  -- How the asking price reads on a link: 'plus' = "+VAT", 'inc' = "inc. VAT" (Q5).
  price_vat_basis     VARCHAR(10) NOT NULL DEFAULT 'plus'
                        CHECK (price_vat_basis IN ('plus', 'inc')),
  description         TEXT,
  -- Optional "try not to book it after" date — a warning, never a gate (D3).
  hold_from_hire      DATE,
  photos_confirmed_at TIMESTAMPTZ,
  started_by          UUID REFERENCES users(id),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at           TIMESTAMPTZ,
  closed_reason       TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_sales_one_open
  ON vehicle_sales (vehicle_id)
  WHERE status IN ('preparing', 'listed', 'under_offer');

CREATE INDEX IF NOT EXISTS idx_vehicle_sales_vehicle ON vehicle_sales (vehicle_id, started_at DESC);

-- The photos chosen for the sale. Book-out / check-in photos are REFERENCED by
-- their key in the public bucket (events/{eventId}/{REG}/…); new ones are
-- uploaded to vehicle-sales/{saleId}/ in the same bucket.
CREATE TABLE IF NOT EXISTS vehicle_sale_photos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id          UUID NOT NULL REFERENCES vehicle_sales(id) ON DELETE CASCADE,
  r2_key           TEXT NOT NULL,
  source           VARCHAR(10) NOT NULL CHECK (source IN ('event', 'upload')),
  source_event_id  VARCHAR(100),
  label            VARCHAR(100),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  added_by         UUID REFERENCES users(id),
  added_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sale_id, r2_key)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_sale_photos_sale ON vehicle_sale_photos (sale_id, sort_order);
