-- 265_vehicle_sale_links.sql
-- Selling a van — Phase 2: per-buyer share links (docs/VEHICLE-SALES-SPEC.md §6).
--
-- One link per recipient. The token is the credential and is kept in the clear
-- (same pattern as claim links) so the same URL can be copied again later.
-- What the buyer sees is set PER LINK by the show_* switches; the public
-- endpoint only ever sends the switched-on sections. A link stops working when
-- it is revoked or when its sale closes (sold / withdrawn).

CREATE TABLE IF NOT EXISTS vehicle_sale_links (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id               UUID NOT NULL REFERENCES vehicle_sales(id) ON DELETE CASCADE,
  token                 VARCHAR(64) NOT NULL UNIQUE,
  recipient_name        VARCHAR(200) NOT NULL,
  show_price            BOOLEAN NOT NULL DEFAULT true,
  show_service_history  BOOLEAN NOT NULL DEFAULT true,
  show_mot_history      BOOLEAN NOT NULL DEFAULT true,
  show_mileage_history  BOOLEAN NOT NULL DEFAULT false,
  -- On by default: hiding known damage from a buyer is a deliberate choice (D11).
  show_damage_history   BOOLEAN NOT NULL DEFAULT true,
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at            TIMESTAMPTZ,
  view_count            INTEGER NOT NULL DEFAULT 0,
  last_viewed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_vehicle_sale_links_sale ON vehicle_sale_links (sale_id, created_at DESC);

-- Q7: the contact line at the foot of every sale page. Edited on the sale page
-- (PUT /api/system-settings only updates keys that already exist).
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('vehicle_sales_contact', NULL, 'Contact shown to buyers on vehicle sale pages', 'vehicle_sales', 'text', 0)
ON CONFLICT (key) DO NOTHING;
