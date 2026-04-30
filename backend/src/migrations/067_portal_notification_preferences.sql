-- Portal notification preferences on people table.
-- Replaces the Monday.com-era columns (notificationsPausedUntil, mutedJobIds)
-- so freelancers can mute job-update emails globally or per-quote from OP.
--
-- portal_notifications_paused_until: NULL = active. Future timestamp = muted
--   until that point (matches Monday's existing semantics so the settings UI
--   doesn't need rethinking). For permanent mute, use a far-future date.
-- portal_muted_quote_ids: array of quote UUIDs the user has individually muted.

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS portal_notifications_paused_until TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS portal_muted_quote_ids UUID[] NOT NULL DEFAULT '{}';

-- Seed the shared staff account muted-by-default. Anyone can re-enable via
-- the portal settings page. Uses a 100-year future date as "permanent".
UPDATE people
SET portal_notifications_paused_until = '2125-12-31 00:00:00+00'
WHERE LOWER(email) = 'info@oooshtours.co.uk'
  AND portal_notifications_paused_until IS NULL;
