-- ============================================================================
-- 243: Shop — how the weekly HireHop job is created
-- ============================================================================
-- Step 6 of docs/SHOP-SALES-SPEC.md. OP creates one "Shop Sales W/C ..." job a
-- week, permanently DISPATCHED, and writes every counter sale onto it.
--
-- WHY THE CLIENT IS AN ID AND NOT A NAME: passing a company name to
-- save_job.php risks HireHop creating a near-duplicate contact every week. The
-- existing shop-sales client is already a cautionary tale — staff edited its
-- address to raise ad-hoc invoices for one-off purchasers, which made a mess in
-- Xero. jon is creating a fresh "OP Shop Sales" contact by hand; its id goes
-- here, and nothing else ever writes to it.
--
-- Empty client id = the weekly job is NOT created and sales stay queued. That
-- is deliberate: a sale sitting in OP is recoverable, a sale on the wrong
-- HireHop client is a Xero cleanup.
-- ============================================================================

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES (
  'shop_job_client_id',
  '',
  'Shop — HireHop CLIENT_ID for the weekly shop-sales job',
  'shop',
  'text',
  70
)
ON CONFLICT (key) DO NOTHING;

-- {date} is replaced with the Monday of the week, as "28th Sep 2026".
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES (
  'shop_job_name_pattern',
  'Shop Sales W/C {date}',
  'Shop — weekly job name ({date} = the Monday)',
  'shop',
  'text',
  80
)
ON CONFLICT (key) DO NOTHING;
