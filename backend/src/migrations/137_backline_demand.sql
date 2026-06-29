-- Backline demand tracker — replaces Monday board 2227909940.
--
-- One row per normalised equipment request. Every search through the Backline
-- Matcher upserts here: bumps the count, adds the potential hire-days, records
-- the job number, and stores Claude's last "do we have it?" verdict. This is
-- purchasing intelligence — "what do clients keep asking for that we don't
-- stock". The have_it_status is the LAST verdict (a snapshot from search time),
-- not live truth; live availability is checked at search time inside /match.
--
-- Migrated from Monday columns:
--   item name            -> display_request (+ normalised_request key)
--   numeric_mkzn9zfy     -> request_count
--   numeric_mkznq7p3     -> total_hire_days
--   text_mkzn1fqj        -> job_refs (comma list -> text[])
--   date4                -> last_requested_at
--   date_mkznfpvx        -> first_requested_at
--   color_mkznsdrp       -> have_it_status (Yes/No/Sort of -> yes/no/sort_of)

CREATE TABLE IF NOT EXISTS backline_demand (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  normalised_request  TEXT NOT NULL UNIQUE,
  display_request     TEXT NOT NULL,
  request_count       INTEGER NOT NULL DEFAULT 1,
  total_hire_days     INTEGER NOT NULL DEFAULT 0,
  job_refs            TEXT[] NOT NULL DEFAULT '{}',
  have_it_status      VARCHAR(10) NOT NULL DEFAULT 'no'
                        CHECK (have_it_status IN ('yes', 'no', 'sort_of')),
  notes               TEXT,
  source              VARCHAR(20) NOT NULL DEFAULT 'matcher',  -- matcher | monday_import | manual
  first_requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_requested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sort surfaces on the demand table: most-requested, recent, by status.
CREATE INDEX IF NOT EXISTS idx_backline_demand_count ON backline_demand (request_count DESC);
CREATE INDEX IF NOT EXISTS idx_backline_demand_last ON backline_demand (last_requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_backline_demand_status ON backline_demand (have_it_status);
