-- ============================================================================
-- 241: Shop sales — bound the drain's retries
-- ============================================================================
-- Step 5 of docs/SHOP-SALES-SPEC.md adds the worker that sends queued rows to
-- HireHop. A row that HireHop will never accept — a deleted stock item, a
-- malformed payload — would otherwise be retried every minute forever, filling
-- the log and hiding the genuine transient failures the retry exists for.
--
-- After `shop_push_max_attempts` tries the row goes `status = 'failed'` and
-- surfaces for a human. Failing loudly beats retrying quietly.
-- ============================================================================

ALTER TABLE shop_sales
  ADD COLUMN IF NOT EXISTS push_attempts INTEGER NOT NULL DEFAULT 0;

-- Staff-editable, because the right number depends on how flaky HireHop is
-- being that week rather than on anything in the code.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES (
  'shop_push_max_attempts',
  '5',
  'Shop — give up pushing after N attempts',
  'shop',
  'text',
  50
)
ON CONFLICT (key) DO NOTHING;
