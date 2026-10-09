-- 221_gmail_manager_mailboxes.sql
-- Auto-Chase Phase 1.5 — multi-mailbox ingestion (Sep 2026).
--
-- Seeds the admin-editable list of MANAGER mailboxes to ingest alongside the
-- primary info@ (spec §6). Stored as a JSON array of @oooshtours.co.uk addresses,
-- edited from the admin-only "Manager mailboxes" Settings section — no deploy or
-- env change to add one. The same domain-wide-delegation grant that impersonates
-- info@ already covers every mailbox in the domain (gmail.readonly), so adding a
-- mailbox is pure config.
--
-- Manager mailboxes run in "matched-only" mode: an email that doesn't
-- deterministically match a job is dropped, NOT parked in the unmatched review
-- queue — so a director's / manager's non-job mail never surfaces anywhere
-- (the confidentiality trade jon accepted). The primary info@ stays full
-- (matched + unmatched queue).

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('gmail_manager_mailboxes', '[]',
   'Manager mailboxes ingested alongside info@ (matched-only) — JSON list of @oooshtours.co.uk addresses',
   'chase', 'text', 40)
ON CONFLICT (key) DO NOTHING;
