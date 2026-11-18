-- 352_account_credits.sql
-- Credit on account (jon, 18 Nov 2026 — docs/CREDIT-ON-ACCOUNT-SPEC.md, PR 1).
--
-- A client has paid more than a finished hire needed and asks us to keep it for
-- their next one. The money is REAL and stays exactly where it is: unallocated on
-- the hire payments (HireHop deposits) of the job it was paid on. This table is
-- only OP's note that it is being held for the client rather than waiting to be
-- refunded, and which later job it has been put aside for.
--
-- NOT a voucher (goodwill_credits): a voucher is a promise that becomes a
-- discount; this is the client's own cash, with no VAT, no use-by date and
-- nothing that lapses. Nothing here touches HireHop or Xero.
--
-- One live hold per source job, covering ALL of that job's unallocated hire
-- money (it can sit across several payments). `amount` is the figure last read
-- from HireHop — the close-out plan refreshes it on every live read, so a refund
-- or an application made anywhere brings it down. A hold whose amount has
-- reached zero reads as spent (derived on read; only stored when the same job is
-- held again later, to free the one-live-hold index).
-- Never deleted. Read and written ONLY through services/account-credit.ts.

CREATE TABLE IF NOT EXISTS account_credits (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The job the money was paid on (and still sits on in HireHop).
  source_job_id      UUID NOT NULL REFERENCES jobs(id),
  -- The paying client (that job's client_id when it was held) — it follows the
  -- payer, never the band.
  organisation_id    UUID NOT NULL REFERENCES organisations(id),
  amount             NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  amount_checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note               TEXT,
  held_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  held_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             VARCHAR(20) NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'spent')),
  -- Put aside for one later job of the same client.
  reserved_job_id    UUID REFERENCES jobs(id) ON DELETE SET NULL,
  reserved_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  reserved_at        TIMESTAMPTZ,
  -- "Stop holding" — back to money to sort on the source job.
  released_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  released_at        TIMESTAMPTZ,
  released_reason    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_account_credits_live_source
  ON account_credits(source_job_id) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS idx_account_credits_org
  ON account_credits(organisation_id) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS idx_account_credits_reserved
  ON account_credits(reserved_job_id) WHERE reserved_job_id IS NOT NULL;
