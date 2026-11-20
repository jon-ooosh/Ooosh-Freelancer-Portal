-- 360: one Wise transfer split across several jobs (services/incoming-split.ts).
-- Born from #2501093374: £2,363.64 from O I B RE, reference "MUTATIONS X 3" — one
-- payment for three jobs, which the queue could only record onto ONE job.
--
-- One row per line. A line either RECORDS money on its job (through
-- services/record-payment.ts, like Record) or LINKS to a payment someone already
-- recorded by hand. The transfer becomes 'recorded' only when its lines add up to it
-- to the penny. A line is written ('recording') BEFORE the money moves, so a crash
-- can never leave money recorded with no line; a line that fails stays as 'failed'
-- for the record and never counts. Never deleted.
CREATE TABLE IF NOT EXISTS incoming_bank_payment_splits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incoming_id     UUID NOT NULL REFERENCES incoming_bank_payments(id),
  job_id          UUID REFERENCES jobs(id) ON DELETE SET NULL,
  hh_job_number   INTEGER,
  payment_type    VARCHAR(20) NOT NULL CHECK (payment_type IN ('deposit', 'balance', 'excess')),
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  status          VARCHAR(20) NOT NULL CHECK (status IN ('recording', 'recorded', 'linked', 'failed')),
  job_payment_id  UUID REFERENCES job_payments(id) ON DELETE SET NULL,
  hh_deposit_id   INTEGER,
  hh_push_error   TEXT,
  error           TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incoming_splits_incoming ON incoming_bank_payment_splits (incoming_id, created_at);

-- A job payment belongs to at most one split line (recorded or linked).
CREATE UNIQUE INDEX IF NOT EXISTS uq_incoming_splits_job_payment
  ON incoming_bank_payment_splits (job_payment_id) WHERE job_payment_id IS NOT NULL;
