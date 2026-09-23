-- ============================================================================
-- 242: Shop — the job that availability questions are asked against
-- ============================================================================
-- `picklist_get_availability.php` is job-scoped: the captured call from
-- HireHop's own UI carries `job=16735` alongside the rows. Without it the call
-- returns no rows at all, which is why the till kept saying "reservations
-- unavailable" (docs/SHOP-SALES-SPEC.md §2.3).
--
-- A walk-in has no job, so the till needs one to ask against. The right answer
-- once step 6 lands is the weekly shop job: permanently DISPATCHED, dated now,
-- which is exactly the context a counter sale wants. Until then this is
-- settable by hand so availability can be tested — point it at the scratch job.
--
-- Empty means "don't ask". The till then shows the shelf count alone and says
-- so, rather than implying nothing is reserved.
-- ============================================================================

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES (
  'shop_availability_job',
  '',
  'Shop — HireHop job number used for availability lookups',
  'shop',
  'text',
  60
)
ON CONFLICT (key) DO NOTHING;
