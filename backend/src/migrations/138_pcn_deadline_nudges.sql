-- 137_pcn_deadline_nudges.sql
-- Step 6 (deadline/NIP nudges) + Step 8 (dashboard buckets).
--
-- `deadline_nudge_sent_for` is the per-PCN stamp-first dedup key for the
-- internal deadline/NIP nudge (mirrors receipt_chase_sent_for for the
-- pay-direct ladder). It stores the deadline date string (or 'nip') so the
-- nudge fires once per deadline; if the deadline changes, it re-nudges.
--
-- These nudges are INTERNAL ONLY (info@ + the dashboard buckets) — they never
-- email a client, so historical/imported PCNs can't trigger a client flurry.

ALTER TABLE pcns ADD COLUMN IF NOT EXISTS deadline_nudge_sent_for TEXT;

-- Issuer-deadline warning window (days before the reduced/final deadline that
-- we start flagging a still-unactioned PCN). NIP urgency stays its own setting
-- (pcn_police_nip_urgency_days), seeded in migration 130.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('pcn_deadline_warning_days', '7', 'PCN issuer-deadline warning window (days)', 'pcn', 'text', 45)
ON CONFLICT (key) DO NOTHING;
