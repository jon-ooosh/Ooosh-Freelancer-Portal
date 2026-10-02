-- ============================================================================
-- 246: Shop — the contact name on the weekly job
-- ============================================================================
-- save_job.php lists `name` as REQUIRED when creating a job ("Name of the
-- customer (required for new)"). Creating the weekly shop job without it
-- returned error 3.
--
-- `client_id` identifies the company in HireHop's address book; `name` is the
-- person on the job. For the shop-sales contact they are the same words, but
-- they are different fields and HireHop wants both.
-- ============================================================================

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES (
  'shop_job_contact_name',
  'OP Shop Sales',
  'Shop — contact name on the weekly job',
  'shop',
  'text',
  75
)
ON CONFLICT (key) DO NOTHING;
