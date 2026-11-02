-- 281: the hire close-out's run log (docs/HIRE-CLOSE-OUT-SPEC.md §7).
--
-- One row per step the close-out took or refused on a job: allocating a
-- deposit to an invoice in HireHop, applying the credit in Xero, completing
-- the job. No state columns on jobs — the close-out re-reads HireHop every
-- time; this is the record of what it did and why it stopped, shown on the
-- Payment Reconciliation card. user_id NULL = the automatic sweep / hook.

CREATE TABLE IF NOT EXISTS job_closeout_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  step        VARCHAR(40) NOT NULL,      -- 'preflight' | 'allocate_hh' | 'allocate_xero' | 'complete' | 'error'
  ok          BOOLEAN NOT NULL,
  detail      TEXT NOT NULL,
  hh_refs     JSONB,                     -- { invoiceId, depositId, amount, ... } — JSON.stringify on write
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_closeout_log_job ON job_closeout_log (job_id, created_at);
