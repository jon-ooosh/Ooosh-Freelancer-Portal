-- 159_quote_van_leg_started.sql
--
-- "Started but not completed" tracking for the freelancer van leg (§7.3).
--
-- van_leg_started_at   — stamped when a freelancer RESOLVES a book-out or
--                        check-in token (they've arrived on OP to do the van
--                        leg). The freelancer having "started" is the signal we
--                        watch: if the van leg never completes (no vehicle event
--                        lands), staff should learn proactively rather than from
--                        an 11am client chase (Lewis, HH 15933).
-- van_leg_alert_sent_at — dedup marker so the stalled-leg scanner alerts info@
--                        at most once per quote.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS van_leg_started_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS van_leg_alert_sent_at TIMESTAMPTZ;
