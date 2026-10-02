-- ============================================================================
-- 249: Shop sales — hide shop-machinery jobs that aren't weekly periods
-- ============================================================================
-- The sync keeps every weekly shop job out of OP's `jobs` table (SHOP-SALES-
-- SPEC.md §3.0). The scratch test job 16749 ("OP Shop Sales - Sales") predates
-- that and got an OP row, so staff could find it in search and the till's job
-- picker — exactly the confusion the exclusion exists to prevent (jon, Sep 2026).
--
-- `shop_hidden_job_numbers` adds job numbers to the same exclusion
-- (`shop-period.ts getShopJobNumbers`). The sync also soft-deletes any OP row
-- an excluded job already has; this migration does it now for 16749 rather
-- than waiting for the next pass.
-- ============================================================================

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES (
  'shop_hidden_job_numbers',
  '[16749]',
  'Shop — extra HireHop job numbers kept out of OP (test/scratch shop jobs)',
  'shop',
  'json',
  80
)
ON CONFLICT (key) DO NOTHING;

UPDATE jobs SET is_deleted = true, updated_at = NOW()
 WHERE hh_job_number = 16749 AND is_deleted = false;
