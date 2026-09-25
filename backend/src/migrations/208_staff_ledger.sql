-- ============================================================================
-- 208: Staff Calendar & Time — Phase B (the ledger)
-- ============================================================================
-- See docs/STAFF-CALENDAR-SPEC.md §0.2, §3.4. This is the load-bearing table
-- of the whole module: every holiday and overtime figure anyone ever sees is a
-- SUM over these rows.
--
-- THERE IS NO BALANCE COLUMN, HERE OR ANYWHERE. A stored balance drifts the
-- first time a request is cancelled, an approval reversed, or an allowance
-- changed mid-year — the codebase's most recurring failure mode (CLAUDE.md,
-- "There is probably already a helper"). Balances are derived, always, by
-- services/staff-balance.ts reading v_staff_balances. Nothing else may SUM
-- this table.
--
-- APPEND-ONLY, ENFORCED BY THE DATABASE. Mistakes are fixed by posting a
-- reversing entry (reverses_entry_id), never by editing or deleting one. Two
-- reasons this is a constraint rather than a convention:
--   1. Payroll may already have paid on a past entry. A silent edit destroys
--      the evidence of what was paid and why.
--   2. The explainable balance — click a number, see every entry behind it —
--      is only trustworthy if entries cannot be rewritten after the fact.
-- ============================================================================

CREATE TABLE IF NOT EXISTS staff_ledger_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,

  -- Two separate currencies. Holiday minutes and banked overtime minutes are
  -- never mixed: a TOIL day off debits 'overtime', a holiday debits 'holiday'.
  account           VARCHAR(20) NOT NULL CHECK (account IN ('holiday','overtime')),

  -- Calendar year the entry BELONGS TO, which is not always the year it was
  -- posted in: a correction made in January can apply to the previous year.
  leave_year        INT NOT NULL CHECK (leave_year BETWEEN 2000 AND 2200),

  entry_type        VARCHAR(30) NOT NULL,

  -- SIGNED minutes: positive credits, negative debits. Never absolute values
  -- plus a direction flag — that invites a SUM that forgets the direction.
  minutes           INT NOT NULL,

  -- The date the entry counts against (the day taken, the day worked), which
  -- is not created_at (when it was recorded).
  effective_date    DATE NOT NULL,

  source_type       VARCHAR(30) CHECK (source_type IS NULL OR source_type IN
                      ('leave_request','overtime_entry','absence','manual','import','system')),
  source_id         UUID,

  -- Set on the reversing half of a correction, pointing at what it undoes.
  reverses_entry_id UUID REFERENCES staff_ledger_entries(id),

  note              TEXT,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Entry types are per-account. Mixing them (an 'accrual' against holiday,
  -- a 'booking' against overtime) would make every aggregate meaningless, and
  -- it is the kind of mistake only a constraint reliably catches.
  CONSTRAINT staff_ledger_entry_type_matches_account CHECK (
    (account = 'holiday'  AND entry_type IN
      ('entitlement','adjustment','booking','cancellation','correction','carry_over'))
    OR
    (account = 'overtime' AND entry_type IN
      ('accrual','spend_toil','spend_paid','year_end_cashout','adjustment','correction'))
  ),

  -- Directional sanity. These types can only ever go one way; a positive
  -- 'booking' would silently hand someone extra holiday.
  CONSTRAINT staff_ledger_sign CHECK (
    CASE entry_type
      WHEN 'entitlement'      THEN minutes >= 0
      WHEN 'cancellation'     THEN minutes >= 0
      WHEN 'accrual'          THEN minutes >= 0
      WHEN 'booking'          THEN minutes <= 0
      WHEN 'spend_toil'       THEN minutes <= 0
      WHEN 'spend_paid'       THEN minutes <= 0
      WHEN 'year_end_cashout' THEN minutes <= 0
      ELSE true                 -- adjustment / correction / carry_over: either way
    END
  )
);

CREATE INDEX IF NOT EXISTS idx_staff_ledger_person_year
  ON staff_ledger_entries(person_id, account, leave_year);
CREATE INDEX IF NOT EXISTS idx_staff_ledger_source
  ON staff_ledger_entries(source_type, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_ledger_effective
  ON staff_ledger_entries(effective_date);

-- ── Append-only enforcement ─────────────────────────────────────────────────
-- A row trigger, so it fires per attempted row and names what was attempted.
-- DROP TABLE is unaffected (migrations still roll back); TRUNCATE is not
-- covered by row triggers, which is acceptable — it is not something any
-- application path does.
CREATE OR REPLACE FUNCTION staff_ledger_entries_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'staff_ledger_entries is append-only (attempted % on id %). Post a reversing entry with reverses_entry_id instead.',
    TG_OP, OLD.id
    USING HINT = 'See docs/STAFF-CALENDAR-SPEC.md §0.4 — the past is corrected, never edited.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_staff_ledger_immutable ON staff_ledger_entries;
CREATE TRIGGER trg_staff_ledger_immutable
  BEFORE UPDATE OR DELETE ON staff_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION staff_ledger_entries_immutable();

-- ── The balance ─────────────────────────────────────────────────────────────
-- THE definition. services/staff-balance.ts is the only reader; nothing else
-- may SUM staff_ledger_entries (spec §4.1).
CREATE OR REPLACE VIEW v_staff_balances AS
  SELECT person_id,
         account,
         leave_year,
         SUM(minutes)                                        AS balance_minutes,
         SUM(minutes) FILTER (WHERE minutes > 0)              AS credited_minutes,
         -SUM(minutes) FILTER (WHERE minutes < 0)             AS debited_minutes,
         COUNT(*)                                             AS entry_count
    FROM staff_ledger_entries
   GROUP BY person_id, account, leave_year;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON staff_ledger_entries TO ooosh_backup;
    GRANT SELECT ON v_staff_balances     TO ooosh_backup;
  END IF;
END $$;
