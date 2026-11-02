-- ============================================================================
-- 236: Shop till scope — which sale stock is actually SHOP stock
-- ============================================================================
-- HireHop holds 974 sale-stock items across 17 categories (verified Sep 2026),
-- and not all of it is shop product. "Misc Sale Item" (category 355) holds
-- things like the VE103B certificate at £25 — a compliance charge raised onto a
-- hire, not something a walk-in buys. A till listing everything would let
-- someone sell a VE103B certificate over the counter.
--
-- WHY A CATEGORY EXCLUSION AND NOT HireHop's "exclude from webshop" FLAG:
-- that flag answers a DIFFERENT question — "should this be sold and SHIPPED to
-- the public?" — and the two answers diverge on the shop's most common
-- category. Drinks & snacks should absolutely be excluded from a webshop
-- (nobody posts a can of Coke) and are absolutely core till stock. Using it as
-- the till filter would delete the till's bread and butter the moment the
-- webshop is configured properly.
--
-- `exclude_from_webshop` is mirrored below anyway, because it IS the right flag
-- for its own purpose and `thetour.store` will want it. It is just not this
-- purpose. See docs/SHOP-SALES-SPEC.md §2.4.
--
-- WHY AN EXCLUSION LIST AND NOT AN ALLOWLIST: it fails OPEN. A category that
-- nobody has classified yet still appears at the till, so new stock is sellable
-- the day it lands. With an allowlist a new category is invisible until someone
-- edits a setting — and "I can't find it to sell it" is a worse failure at a
-- counter than "this shouldn't really be here". The `heads` list HireHop
-- returns also looks top-level-only (IDs 343 and 347 are absent), so an
-- allowlist risks hiding sub-categories we cannot currently enumerate.
-- ============================================================================

-- For the future webshop, NOT for the till. See above.
ALTER TABLE shop_stock_cache
  ADD COLUMN IF NOT EXISTS exclude_from_webshop BOOLEAN NOT NULL DEFAULT FALSE;

-- Categories hidden from the till. Staff-editable, JSON array of HireHop
-- category IDs. Seeded with 355 (Misc Sale Item) — the only category verified
-- to hold non-shop charges. The reorder view deliberately ignores this: running
-- out of VE103B certificates matters too, they just aren't sold at the counter.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES (
  'shop_excluded_category_ids',
  '[355]',
  'Shop till — hidden HireHop categories',
  'shop',
  'json',
  10
)
ON CONFLICT (key) DO NOTHING;

-- HireHop tax-type index → VAT percentage. See SHOP-SALES-SPEC.md §2.2:
-- VAT_RATE on a consumables row is an INDEX, not a percentage — index 0 is the
-- STANDARD rate, not zero-rated. Seeded explicitly so the mapping is visible
-- and editable rather than buried in a code default.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES (
  'shop_vat_rate_map',
  '{"0":20}',
  'Shop — HireHop tax index to VAT %',
  'shop',
  'json',
  20
)
ON CONFLICT (key) DO NOTHING;
