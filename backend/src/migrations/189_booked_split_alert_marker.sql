-- 189_booked_split_alert_marker.sql
--
-- Proactive escalation alarm for the "confirmed in OP but never Booked in
-- HireHop" split-brain (job 16513, 11 Aug 2026). A HireHop 327 rate-limit
-- storm can make the status-push after a payment fail silently, leaving a job
-- at pipeline_status='confirmed' (or further) while jobs.status stays < 2
-- (Enquiry/Provisional) in HireHop.
--
-- The booked-status reconciler (services/booked-status-reconciler.ts) heals
-- these silently on the 30-min sync, but if HireHop stays unreachable the job
-- can sit stuck indefinitely with no one told. This marker backs a scanner
-- (services/sanity-check-scanner.ts runBookedSplitScan) that emails jon@ ONCE
-- per stuck job after a 2-hour grace, so a persistent failure surfaces.
--
-- Stamp-first dedup (same pattern as the sibling sanity scanners): stamp the
-- marker BEFORE the send so a transient email failure can't re-fire on the
-- next 15-min sweep. The scanner clears the marker in-scan once the job has
-- recovered (status >= 2) or gone terminal (lost/cancelled), so a re-stuck
-- job can warn afresh.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS booked_split_alerted_at TIMESTAMPTZ;
