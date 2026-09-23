-- ============================================================================
-- 237: Complete the shop VAT map from HireHop's own tax types
-- ============================================================================
-- Migration 236 seeded `shop_vat_rate_map` as `{"0":20}` — the only index we
-- had verified. The probe run of 23 Sep 2026 then turned up HireHop publishing
-- its whole tax table on the job payload (`standard_tax_rates` on
-- `/api/save_job.php` and `job_data.php`):
--
--   INDEX 0 → 20%  "20% (VAT on Income)"
--   INDEX 1 →  0%  "Zero Rated Income"
--   INDEX 2 →  5%  "5% (VAT on Income)"
--
-- That confirms index 0 is the standard rate (SHOP-SALES-SPEC.md §2.2) and, more
-- usefully, shows the seeded map was INCOMPLETE. A genuinely zero-rated item
-- (VAT_RATE 1) would have missed the map, hit the fall-back-to-standard rule,
-- and been charged 20% VAT it shouldn't carry. The fallback direction is still
-- right — over-charging is correctable, under-declaring is not — but being
-- right by accident is not the same as being right.
--
-- Most cold food is zero-rated in the UK while canned drinks and confectionery
-- are standard, so for a shop selling snacks this is a live distinction rather
-- than a theoretical one.
--
-- GUARDED UPDATE: only rewrites the value if it is still exactly what 236
-- seeded. If anyone has edited the map by hand, their edit wins — a migration
-- must not silently clobber a deliberate operational change.
-- ============================================================================

UPDATE system_settings
   SET value = '{"0":20,"1":0,"2":5}',
       updated_at = NOW()
 WHERE key = 'shop_vat_rate_map'
   AND value = '{"0":20}';
