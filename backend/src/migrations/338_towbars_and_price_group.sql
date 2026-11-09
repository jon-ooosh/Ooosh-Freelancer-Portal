-- Towbars and the yearly price change (jon, Nov 2026; docs/PRICE-LIST-CHANGE.md).

-- A towbar is fitted to this van. Jobs that ask for one (the HireHop "Towbar"
-- autopull, item 2064) list towbar vans first at allocation, and warn when the
-- van picked has none; jobs that didn't ask list them last. Never a block.
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS has_towbar BOOLEAN NOT NULL DEFAULT false;

-- Which HireHop price group (A/B/C) the jobs OP creates are born on, and from
-- which UK date. Both empty = OP sends nothing and HireHop uses Price A, as
-- before. Read by services/hh-price-group.ts.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('hh_price_group', '',
        'Price group for new HireHop jobs: A, B or C. Empty = HireHop''s default (A)',
        'hirehop', 'text', 10)
ON CONFLICT (key) DO NOTHING;

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('hh_price_group_from', '',
        'From this date (YYYY-MM-DD, UK), jobs OP creates use the price group above. Empty = straight away',
        'hirehop', 'text', 11)
ON CONFLICT (key) DO NOTHING;
