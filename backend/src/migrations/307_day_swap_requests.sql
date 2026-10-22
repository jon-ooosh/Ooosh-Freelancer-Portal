-- Swapping a day, asked for and approved like holiday (staff calendar spec
-- §8.2, jon Oct 2026). "I usually work Saturday — can I work Friday instead?"
--
-- A swap was already modelled on staff_pattern_exceptions (migration 206): two
-- rows sharing a swap_group_id, the day OFF and the day IN. Only the admin
-- route existed, auto-approved. Asking for one needs what the other requests
-- (leave, working from home) already carry:
--
--   * who decided, when, and why — a decline gives a reason the person sees;
--   * 'withdrawn' — the person takes back their own request, which is not the
--     same as an admin calling off an approved one ('cancelled');
--   * usual_minutes — the minutes this date was worth on the working pattern
--     when the change was asked for. A SNAPSHOT, like a leave day's minutes, so
--     the approver can see "1h longer than the day given up" and a later hours
--     change cannot rewrite what was asked. NULL on rows made before this.
--
-- Widening only: every existing row already satisfies the new status list.

ALTER TABLE staff_pattern_exceptions
  ADD COLUMN IF NOT EXISTS decided_by    UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS decided_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision_note TEXT,
  ADD COLUMN IF NOT EXISTS usual_minutes INT CHECK (usual_minutes IS NULL OR usual_minutes >= 0);

-- The status CHECK was written inline in 206, so Postgres named it. Find it by
-- what it says rather than trusting the generated name, so a differently named
-- copy cannot survive and go on refusing 'withdrawn'.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'staff_pattern_exceptions'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%declined%'
  LOOP
    EXECUTE format('ALTER TABLE staff_pattern_exceptions DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE staff_pattern_exceptions
  ADD CONSTRAINT staff_pattern_exceptions_status_check
  CHECK (status IN ('pending','approved','declined','cancelled','withdrawn'));
