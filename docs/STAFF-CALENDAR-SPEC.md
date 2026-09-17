# Staff Calendar & Time Module — Spec

**Status (15 Sep 2026): Phases A, B1, B2 and C are BUILT, deployed and in use.**
Phases D, E and F remain. See §18 for exactly what is done, what changed during
the build, and what is left.

Fleshes out `docs/SPEC.md` §3.9 "Staff & HR Management", which was written in
Phase 1, scheduled into Phase 3, and then dropped out of `ROADMAP.md` entirely.

**One-line:** Replace BrightHR with a module that (a) knows everyone's working
pattern, (b) holds one immutable ledger of holiday and overtime, (c) lets staff
request time off and log overtime for admin approval *with the operational
context visible at the moment of approval*, (d) records sickness and other
absence with a proper return-to-work process, and (e) books freelancers onto
days without treating them as staff.

**Hard deadline: live 1 January 2027.** The BrightHR subscription expires around
Dec 2026 and the leave year is calendar Jan–Dec. See §14.

**Load-bearing rules for anyone picking this up:**
`.claude/rules/staff-calendar.md` (loads automatically on the module's files).

---

## 0. The load-bearing principles

Five decisions everything else hangs off. Getting any of these wrong is expensive to
undo once there is a year of real data in the table.

### 0.1 The unit of account is the MINUTE. Always.

Every stored quantity — entitlement, a booked day off, an overtime chunk, a contracted
shift — is an integer count of minutes. Days and hours are a **display** concern only.

Ooosh has three staff on non-standard patterns, including one (Will Parish) working a
compressed week across four days of **unequal length**. For him a day off is emphatically
not "a day":

| Day | Hours | Gross | Break | Net |
|---|---|---|---|---|
| Mon | 08:30–16:30 | 8h 00 | 30 min | **450 min** (7h 30) |
| Tue | 08:30–16:30 | 8h 00 | 30 min | **450 min** (7h 30) |
| Wed | 09:15–19:00 | 9h 45 | 30 min | **555 min** (9h 15) |
| Thu | — | — | — | not scheduled |
| Fri | 08:00–19:00 | 11h 00 | 30 min | **630 min** (10h 30) |
| | | | | **2,085 min = 34h 45m** |

Against the standard week (Mon–Fri, 40h gross less 5 × 1h lunch = 35h paid = 2,100 min),
that is **15 minutes short per week** — about 13 hours a year. Invisible if you count in
days; unmissable the moment you count in minutes. Confirm against his contract before
entering the pattern (§17.7); the pattern is data, so whatever the contract says is what
gets typed in.

Comparative entitlement (5.6 statutory weeks × weekly contracted minutes):

| Person | Weekly | Statutory entitlement | Shown as |
|---|---|---|---|
| Standard Mon–Fri (7h paid/day) | 2,100 min | 11,760 min | 28.0 days / 196.0 h |
| Will (compressed, unequal) | 2,085 min | 11,676 min | ≈22.4 days / 194.6 h |
| 4-day Thu–Sun (4 × 7h) | 1,680 min | 9,408 min | 22.4 days / 156.8 h |

**Display rule:** always show both — `"≈22.4 days (194.6 hours)"`. A person's nominal
"day" for display = weekly contracted minutes ÷ working days per week, from the pattern in
force *on the date being displayed*. For Will that nominal day is 521 min (8h 41m) — a
number he never actually works, which is exactly why hours lead and days follow.

*(Working Time Regulations sanity check on the long Friday: an 11-hour day with a
30-minute break is fine — the entitlement is a 20-minute uninterrupted break over 6
hours. Daily rest between shifts is 16h 45m at the tightest, weekly rest is three clear
days, and the week totals 34h 45m against the 48h limit. Nothing to flag.)*

**Unequal days: a deliberate consequence, not a bug.** A leave day is charged at the
*actual* minutes of that weekday (§0.3). So Will's Friday off costs 630 minutes and his
Monday off costs 450. Spending his whole entitlement on Mondays would yield ~25.9 days
away; on Fridays, ~18.5. That is correct — in both cases he is relieved of exactly 194.6
hours of work, which is what the entitlement is. Do **not** "fix" this by charging an
average day: that would make a Friday off cheaper than it costs and a Monday off dearer,
and staff would (rightly) notice. Any clustering it causes is an operational matter for
the coverage warnings in §11, not an accounting one.

### 0.2 Balances are DERIVED from an immutable ledger. There is no balance column.

There is no `holiday_days_remaining` anywhere. A stored balance drifts the first time a
request is cancelled, an approval reversed, or an allowance changed mid-year — this is
the codebase's single most recurring failure mode (see CLAUDE.md, "There is probably
already a helper").

Instead: `staff_ledger_entries` is append-only, and `v_staff_balances` sums it. Same
architecture as `v_excess_held`.

`staff_ledger_entries` is protected by a DB trigger that **raises on UPDATE and DELETE**.
Not a convention — a constraint. Mistakes are fixed by posting a reversing entry (§0.4).

The payoff is the feature that makes staff trust the system: **an explainable balance**.
Click "12.5 days" and see every entry that produced it, dated and attributed. That kills
most of the disputes systems like this generate.

### 0.3 Working patterns are EFFECTIVE-DATED.

"Bob works Mon–Thu" is only true between two dates. If one current pattern is stored,
every historical calendar retroactively lies the day Bob changes his hours, and past
balance maths silently breaks.

So: `staff_working_patterns` carries `effective_from` / `effective_to`, and every
calculation asks "what was true on *this* date". This also gives 2-week alternating
cycles for free.

**Corollary — booked days snapshot their minutes.** When a leave request is created,
each covered day gets a row in `staff_leave_request_days` with the minutes taken *from
the pattern in force at the time of booking*. A later pattern change must never
retroactively change the cost of an already-approved holiday.

### 0.4 The past is CORRECTED, never edited.

Staff cannot alter anything in the past. Admin cannot either — admin posts a
**correction**: a reversing ledger entry (`reverses_entry_id`) plus a replacement. The
original row is never touched.

A blanket "past is locked" rule would be wrong, because of one case that is a legal
right rather than an edge case: **if someone falls ill during booked holiday, they may
reclaim that holiday as sick leave.** That is a retrospective type change and the system
must support it (§7.4). Correction-not-edit gives it to us cleanly, with an audit trail.

The other reason: payroll may already have paid on a past entry. A silent edit destroys
the evidence of what was paid and why.

### 0.5 Absence detail is two-tier, by law.

Sickness and parental data is **special-category health data** under UK GDPR. Maternity
is frequently confidential before an announcement.

| Viewer | Sees |
|---|---|
| Any staff member, global calendar | `Absent` — no type, no reason |
| Admin | Everything: type, category, notes, fit notes, RTW record |

This is enforced **at the API layer** — the global calendar endpoint returns the masked
shape. Full records are never sent to the browser and hidden in React.

---

## 1. Scope

**In scope:**
- Employment records for the 7 staff: hours, pattern, start date, salary history,
  review scheduling, right-to-work, emergency contacts (admin-only directory, built on
  the existing `people` columns — see §3.1).
- Effective-dated working patterns, incl. 2-week cycles and compressed hours.
- One-off pattern exceptions and self-swaps; manager-created person-to-person swaps.
- Holiday entitlement, requests, approval, cancellation, corrections, half days.
- Overtime logged in 5-minute increments into a **bank**, drawn down as either TOIL
  time off or payroll cash-out, at whatever moment the person decides.
- Unpaid leave.
- Sickness, parental, bereavement, goodwill and other absence, with return-to-work.
- Global "who's in" calendar + dashboard strip + personal calendar.
- Approval flow with operational context attached.
- Monthly payroll change report for the accountants.
- Freelancer day bookings with expected invoice totals, surfaced in the freelancer portal.
- Reports: absence patterns, balances, liability, audit.

**Out of scope (v1):**
- Person-to-person swap *consent workflow*. The data model supports it from day one
  (§8.3); the UI does not. Admin creates both legs after the two of them have agreed it
  verbally. Revisit if volume justifies it — see §16.
- Coverage *intelligence* (comparing staffing to prep/job volume). Phase F.
- Team-wide iCal export. Personal feed only — a team feed subscribed into a private
  Google account exports colleagues' absence data outside the company, irreversibly.
- SSP calculation. We flag qualifying days for the accountants; we do not compute pay.
- Rota *building* (assigning staff to shifts). This module records who is contracted to
  work and who is absent — it does not schedule work.

---

## 2. What already exists that this reuses

| Existing | Used for |
|---|---|
| `users.person_id → people` | Staff identity. No new user table. |
| `studio_sitter_shifts` (mig 153) | The pattern freelancer day bookings copy: one row per calendar date, one assignee, status lifecycle, `fee`, partial unique index on the live assignment. |
| `src/app/shift` + `/portal/studio-sitter/shifts/:date` | The portal UI pattern for a date-scoped booking. Day bookings mirror it. |
| `quote_assignments` | The freelancer-money pattern — `agreed_rate`, `rate_type`, `invoice_amount`, `invoice_received`, `invoice_queried`. Day bookings copy the columns; they can't reuse the table (it is quote-scoped, a day booking has no quote). |
| `dashboard/v2/registry.ts` | The who's-in strip registers as a section. Per PLATFORM-CONVENTIONS, do not build a parallel dashboard surface. |
| `Layout.tsx` avatar dropdown | Menu entry point, alongside Inbox / My Documents / My Profile. |
| `system_settings` | All policy config (§13). No new env vars. |
| `notifications` + `email-service.ts` | Approval requests, RTW prompts, reminders. |
| `audit_log` | Every state change. |

---

## 3. Data model

All new tables. Migration numbers taken at build time (next free after 201).

### 3.1 Employment & directory (admin-only)

**Most of the employee record already exists on `people` — do not duplicate it.** Per the
CLAUDE.md "there is probably already a helper" rule, the employee module is a *view* over
existing columns plus the genuinely employment-specific tables below.

Already on `people`, reused as-is:

| Field | Origin |
|---|---|
| `date_of_birth`, `home_address` | mig 001 |
| `emergency_contact_name`, `emergency_contact_phone` | mig 001 |
| `licence_number`, `licence_issued_by`, `licence_expiry`, `licence_passed_date`, `dvla_check_date`, `licence_categories` | mig 184 / 194 |
| `passport_expiry` | mig 184 |
| `files` (JSONB) — contracts, certificates, letters | mig 001 |
| `phone` / `mobile`, `preferred_name`, `skills`, `tags` | mig 001 / 184 |

Genuinely missing, added here:

```sql
ALTER TABLE people ADD COLUMN IF NOT EXISTS emergency_contact_relationship TEXT;
ALTER TABLE people ADD COLUMN IF NOT EXISTS emergency_contact_2_name  VARCHAR(255);
ALTER TABLE people ADD COLUMN IF NOT EXISTS emergency_contact_2_phone VARCHAR(50);
ALTER TABLE people ADD COLUMN IF NOT EXISTS emergency_contact_2_relationship TEXT;

-- Right to work. Legally required to hold and produce; nothing covers it today.
ALTER TABLE people ADD COLUMN IF NOT EXISTS rtw_checked_on     DATE;
ALTER TABLE people ADD COLUMN IF NOT EXISTS rtw_document_type  VARCHAR(50);
ALTER TABLE people ADD COLUMN IF NOT EXISTS rtw_expires_on     DATE;   -- time-limited leave
ALTER TABLE people ADD COLUMN IF NOT EXISTS rtw_checked_by     UUID REFERENCES users(id);

-- NI number: identity PII. ENCRYPTED via services/encryption.ts, like driver licence
-- data. Never plaintext, never in a list view, never in an export.
ALTER TABLE people ADD COLUMN IF NOT EXISTS ni_number_encrypted TEXT;
```

**Bank details are deliberately NOT stored.** The accountants already hold them for
payroll, so keeping a second copy adds real fraud exposure (payroll-diversion attacks
target exactly this) for no operational benefit. This is a decision, not an oversight —
do not add them later "for completeness".

`rtw_expires_on` joins the existing document-expiry scanner alongside licence and
passport expiry, so time-limited right to work chases itself.

```sql
staff_employment
  id                UUID PK
  person_id         UUID NOT NULL UNIQUE REFERENCES people(id)
  employment_status VARCHAR(20) NOT NULL DEFAULT 'employed'
                      CHECK (employment_status IN ('employed','left'))
  start_date        DATE NOT NULL
  end_date          DATE
  job_title         TEXT
  department        VARCHAR(50)         -- operations / warehouse / sales / accounts
  bank_holiday_policy VARCHAR(20)       -- NULL = inherit global setting
                      CHECK (bank_holiday_policy IN ('use_allowance','granted'))
  entitlement_weeks NUMERIC(4,2)        -- NULL = inherit staff.statutory_weeks (5.6)
  notes             TEXT                -- admin only
  created_at, updated_at

staff_salary_history            -- append-only; an increase is a new row
  id, person_id, annual_amount NUMERIC(10,2), effective_from DATE,
  reason TEXT, created_by, created_at

staff_reviews
  id, person_id, review_type VARCHAR(20) CHECK IN ('quarterly','annual','probation','ad_hoc'),
  scheduled_for DATE, completed_at TIMESTAMPTZ,
  notes TEXT, outcome TEXT, next_review_due DATE,
  created_by, created_at, updated_at
```

**Salary is plaintext, not encrypted, and admin-gated at the API.** Deliberate: it is not
special-category data, it already lands in nightly backups regardless, and encrypting it
would block the sorting and reporting the directory exists for. `services/encryption.ts`
is for identity PII (licence numbers, passports), not this. Revisit only if a
non-admin ever needs directory access.

A nightly scheduler task raises a notification when `scheduled_for` is within 14 days
and `completed_at` is null.

### 3.2 Working patterns

```sql
staff_working_patterns
  id                UUID PK
  person_id         UUID NOT NULL REFERENCES people(id)
  effective_from    DATE NOT NULL
  effective_to      DATE                -- NULL = current
  cycle_weeks       INT NOT NULL DEFAULT 1 CHECK (cycle_weeks IN (1,2))
  notes             TEXT
  created_by, created_at
  UNIQUE (person_id, effective_from)

staff_working_pattern_days
  id                UUID PK
  pattern_id        UUID NOT NULL REFERENCES staff_working_patterns(id) ON DELETE CASCADE
  cycle_week        INT NOT NULL DEFAULT 1
  weekday           INT NOT NULL CHECK (weekday BETWEEN 0 AND 6)   -- 0 = Monday
  is_working        BOOLEAN NOT NULL DEFAULT true
  start_time        TIME
  end_time          TIME
  break_minutes     INT NOT NULL DEFAULT 0
  minutes           INT NOT NULL DEFAULT 0    -- computed on write, never at read time
  UNIQUE (pattern_id, cycle_week, weekday)
```

`minutes` is written by the service, not derived in queries — every read path depends on
it and recomputing per row is how the compressed-hours case gets quietly rounded wrong.

Overlapping effective ranges per person are rejected in the service on write. (A
`daterange` EXCLUDE constraint would be stronger but needs `btree_gist`; the service
check plus the unique index is sufficient at 7 staff.)

### 3.3 Pattern exceptions & swaps

```sql
staff_pattern_exceptions
  id              UUID PK
  person_id       UUID NOT NULL REFERENCES people(id)
  exception_date  DATE NOT NULL
  is_working      BOOLEAN NOT NULL
  start_time      TIME
  end_time        TIME
  break_minutes   INT NOT NULL DEFAULT 0
  minutes         INT NOT NULL DEFAULT 0
  reason          TEXT
  swap_group_id   UUID          -- links the legs of a swap; NULL for a one-off
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','declined','cancelled'))
  requested_by, approved_by, approved_at, created_at, updated_at
  UNIQUE (person_id, exception_date) WHERE status IN ('pending','approved')
```

A **self-swap** ("I usually work Tue not Wed, I want to flip them") is two rows sharing a
`swap_group_id`: one setting Tue non-working, one setting Wed working. Approve or decline
the group, never a single leg.

A **person-to-person swap** is four rows across two people sharing one `swap_group_id`.
The model handles it from day one; v1 has admin create it in one action rather than
building a two-party consent workflow (§16).

### 3.4 The ledger

```sql
staff_ledger_entries
  id                UUID PK
  person_id         UUID NOT NULL REFERENCES people(id)
  account           VARCHAR(20) NOT NULL CHECK (account IN ('holiday','overtime'))
  leave_year        INT NOT NULL              -- calendar year
  entry_type        VARCHAR(30) NOT NULL
  minutes           INT NOT NULL              -- SIGNED: + credit, − debit
  effective_date    DATE NOT NULL
  source_type       VARCHAR(30)               -- 'leave_request' | 'overtime_entry'
                                              -- | 'absence' | 'manual' | 'import'
  source_id         UUID
  reverses_entry_id UUID REFERENCES staff_ledger_entries(id)
  note              TEXT
  created_by        UUID REFERENCES users(id)
  created_at        TIMESTAMPTZ DEFAULT NOW()
```

`entry_type` by account:

| account | entry_type | sign | posted when |
|---|---|---|---|
| holiday | `entitlement` | + | leave-year rollover, or on joining (pro-rated) |
| holiday | `adjustment` | ± | admin grants/removes, opening balance at cutover |
| holiday | `booking` | − | leave request approved |
| holiday | `cancellation` | + | approved request cancelled |
| holiday | `correction` | ± | admin correction, incl. sickness reclaim (§7.4) |
| overtime | `accrual` | + | overtime entry approved |
| overtime | `spend_toil` | − | TOIL leave request approved |
| overtime | `spend_paid` | − | cashed out to payroll |
| overtime | `year_end_cashout` | − | 31 Dec sweep (§6.3) |
| overtime | `adjustment` / `correction` | ± | admin |

**Trigger:** `BEFORE UPDATE OR DELETE ON staff_ledger_entries → RAISE EXCEPTION`.

```sql
CREATE VIEW v_staff_balances AS
  SELECT person_id, account, leave_year, SUM(minutes) AS balance_minutes
  FROM staff_ledger_entries
  GROUP BY person_id, account, leave_year;
```

### 3.5 Leave requests

```sql
staff_leave_requests
  id            UUID PK
  person_id     UUID NOT NULL REFERENCES people(id)
  leave_type    VARCHAR(20) NOT NULL
                  CHECK (leave_type IN ('holiday','toil','unpaid'))
  start_date    DATE NOT NULL
  end_date      DATE NOT NULL
  total_minutes INT NOT NULL          -- sum of the day rows below
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','declined','cancelled','withdrawn'))
  request_note  TEXT
  requested_at  TIMESTAMPTZ DEFAULT NOW()
  decided_by, decided_at, decision_note
  cancelled_at, cancelled_by, cancellation_reason
  created_at, updated_at

staff_leave_request_days
  id            UUID PK
  request_id    UUID NOT NULL REFERENCES staff_leave_requests(id) ON DELETE CASCADE
  leave_date    DATE NOT NULL
  minutes       INT NOT NULL          -- SNAPSHOT of the pattern at booking time (§0.3)
  portion       VARCHAR(10) NOT NULL DEFAULT 'full'
                  CHECK (portion IN ('full','am','pm'))
  reclaimed_absence_id UUID REFERENCES staff_absences(id)   -- §7.4
  UNIQUE (request_id, leave_date)
```

Non-working days inside a date range get **no day row** — request Fri→Mon and a Sat/Sun
non-worker is charged two days, not four.

`unpaid` leave writes **no ledger entry** (nothing is deducted) but still creates day
rows, so it shows on the calendar and reaches the payroll report.

*Migration ordering note:* `reclaimed_absence_id` references `staff_absences` (§3.7), so
add that FK in a later statement of the same migration, after the absences table exists.

### 3.6 Overtime

```sql
staff_overtime_entries
  id            UUID PK
  person_id     UUID NOT NULL REFERENCES people(id)
  work_date     DATE NOT NULL
  start_time    TIME              -- informational
  end_time      TIME
  minutes       INT NOT NULL CHECK (minutes > 0 AND minutes % 5 = 0)
  reason        TEXT NOT NULL
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','declined','cancelled'))
  submitted_at, decided_by, decided_at, decision_note
  created_at, updated_at
```

**No unique constraint on (person_id, work_date)** — deliberately. "In an hour early,
stayed 30 minutes late" is two entries, which is simpler than a multi-segment editor and
matches how people actually remember their day.

### 3.7 Absence

```sql
staff_absences
  id                UUID PK
  person_id         UUID NOT NULL REFERENCES people(id)
  absence_type      VARCHAR(30) NOT NULL CHECK (absence_type IN
                      ('sickness','maternity','paternity','shared_parental','adoption',
                       'bereavement','compassionate','goodwill','jury_service',
                       'medical_appointment','other'))
  start_date        DATE NOT NULL
  end_date          DATE                -- NULL = still open
  is_open           BOOLEAN NOT NULL DEFAULT true
  deducts_allowance BOOLEAN NOT NULL DEFAULT false
  total_minutes     INT                 -- computed on close
  working_days      NUMERIC(5,2)        -- computed on close, for reporting
  -- ADMIN ONLY from here down:
  status            VARCHAR(20) NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','cancelled'))
  reason_category   VARCHAR(50)
  notes             TEXT
  self_certified    BOOLEAN NOT NULL DEFAULT false
  fit_note_received BOOLEAN NOT NULL DEFAULT false
  fit_note_expiry   DATE
  ssp_qualifying    BOOLEAN             -- flag for the accountants; we do not compute SSP
  rtw_required      BOOLEAN NOT NULL DEFAULT true
  rtw_date          DATE                -- when the conversation happened…
  rtw_completed_at  TIMESTAMPTZ         -- …as against when it was recorded
  rtw_by            UUID REFERENCES users(id)
  rtw_fit_to_return VARCHAR(20) CHECK (IN 'yes','yes_with_adjustments','no')
  rtw_adjustments   TEXT
  rtw_notes         TEXT
  rtw_chased_at     TIMESTAMPTZ         -- so the 7-day chase fires ONCE
  cancelled_by, cancelled_at, cancellation_reason
  created_by, created_at, updated_at

staff_absence_days
  id, absence_id, person_id, absence_date DATE, minutes INT,
  portion VARCHAR(10) NOT NULL DEFAULT 'full'
    CHECK (portion IN ('full','am','pm')),        -- 'hours' removed, mig 215 (§7.5)
  start_time TIME,          -- always NULL since mig 215; kept, constrained
  end_time   TIME,
  is_active  BOOLEAN NOT NULL DEFAULT true,   -- kept in step with the parent status
  UNIQUE (absence_id, absence_date)
```

`deducts_allowance` defaults false — goodwill, bereavement and sickness do not come out
of holiday. It exists so an odd case can be handled without a new type.

Four things differ from the first draft of this table, all settled while building:

- **`rtw_fit_to_return` is a VARCHAR, not a BOOLEAN.** §7.3 asks "yes / yes with
  adjustments / no" and a boolean cannot hold the middle one — which is the answer that
  actually carries an obligation.
- **`rtw_chased_at`** exists because §7.3's "chases once" needs somewhere to record that
  it fired. Without it the chase either never runs or runs every morning forever.
- **`status`** — an absence entered against the wrong person has to be retractable, and
  per CLAUDE.md we soft-cancel rather than delete. `is_active` on the day rows is kept in
  step by a trigger, exactly as `is_live` is on `staff_leave_request_days`.
- **`person_id` and `is_active` on the day rows** are denormalised for the same reason
  leave's are: a unique index cannot reach through a join.

`is_open` is derivable from `end_date` and a CHECK constraint ties them together, so the
two cannot drift into disagreeing about whether the absence has finished.

### 3.8 Freelancer day bookings

Strictly separate from everything above. No ledger account, no working pattern, no
entitlement. See §9 for why that separation is load-bearing.

```sql
freelancer_day_bookings
  id              UUID PK
  person_id       UUID NOT NULL REFERENCES people(id)   -- is_freelancer = true
  booking_date    DATE NOT NULL
  start_time      TIME
  end_time        TIME
  duration_type   VARCHAR(10) NOT NULL DEFAULT 'full_day'
                    CHECK (duration_type IN ('full_day','half_day','hours'))
  rate_type       VARCHAR(20) NOT NULL DEFAULT 'day'
                    CHECK (rate_type IN ('day','half_day','hourly','fixed'))
  agreed_rate     NUMERIC(10,2)      -- SNAPSHOT. The truth for this booking.
  expected_total  NUMERIC(10,2)      -- computed on write
  status          VARCHAR(20) NOT NULL DEFAULT 'offered'
                    CHECK (status IN ('offered','accepted','declined','cancelled','completed'))
  offered_at, responded_at, response_note
  notes           TEXT
  invoice_received BOOLEAN NOT NULL DEFAULT false
  invoice_amount   NUMERIC(10,2)
  invoice_queried  BOOLEAN NOT NULL DEFAULT false
  invoice_query_notes TEXT
  created_by, created_at, updated_at

freelancer_day_booking_tasks
  id, booking_id REFERENCES freelancer_day_bookings(id) ON DELETE CASCADE,
  task_type VARCHAR(30) CHECK IN ('van_prep','van_checkin','warehouse','delivery','rehearsal','other'),
  job_id UUID REFERENCES jobs(id),
  vehicle_id UUID,
  description TEXT,
  status VARCHAR(20) DEFAULT 'assigned' CHECK IN ('assigned','in_progress','done'),
  completed_at, created_at
```

Plus, on `people`:
```sql
ALTER TABLE people ADD COLUMN IF NOT EXISTS default_day_rate      NUMERIC(10,2);
ALTER TABLE people ADD COLUMN IF NOT EXISTS default_half_day_rate NUMERIC(10,2);
```
`people.day_rate_note` (mig 184) stays as the free-text note it is — it cannot compute
totals. The numeric defaults **pre-fill** a booking; `agreed_rate` on the booking is the
truth, because rates change and historical bookings must keep the rate that was agreed.

---

## 4. The two definitions everything else calls

Per CLAUDE.md's "There is probably already a helper" rule, these are added to that table
in the root CLAUDE.md when this ships. Nothing else may re-derive either fact.

### 4.1 `services/staff-balance.ts` — "How much has this person got?"

```ts
getBalance(personId, account, leaveYear): {
  balanceMinutes, entitlementMinutes, takenMinutes, bookedMinutes,
  displayDays, displayHours, entries: LedgerEntry[]   // the explainability payload
}
```
Reads `v_staff_balances` plus the entries for the drill-down. **No other file may SUM
`staff_ledger_entries`.**

### 4.2 `services/staff-day-status.ts` — "Is this person in on this date?"

Three sources answer "in or out": the working pattern (+ exceptions), approved leave, and
absence. Three sources means drift, so exactly one resolver merges them:

```ts
getDayStatus(personId, date): {
  scheduledMinutes: number,
  status: 'working' | 'not_scheduled' | 'leave' | 'absent' | 'partial',
  portion?: 'full' | 'am' | 'pm' | 'hours',
  window?: { start: string, end: string },  // set when portion = 'hours' — timed LEAVE
  detail?: { leaveType?, absenceType? }     // ADMIN ONLY — stripped for peers
}
getTeamDayStatus(date, viewerRole): TeamDayStatus[]   // masking applied here
```

The global calendar, dashboard strip, clash detection, iCal feed and the approval
context panel all call this. None of them query the underlying tables directly.

---

## 5. Holiday

### 5.1 Entitlement

- Leave year: **calendar, 1 Jan – 31 Dec** (`staff.leave_year_start_month = 1`).
- Default entitlement: `staff.statutory_weeks` (5.6) × the person's weekly contracted
  minutes, from the pattern in force on 1 Jan. Overridable per person via
  `staff_employment.entitlement_weeks`.
- **Bank holidays are normal working days** (`staff.bank_holidays_policy =
  'use_allowance'`) — current Ooosh policy. Staff wanting one off book holiday or TOIL
  like any other day. The setting is global with a per-person override on
  `staff_employment`, so a future contract can differ without a code change. Bank holiday
  dates are seeded per year into `system_settings` and shown as a marker on the calendar
  (informational only, since they are working days).
- **Pro-rata rounds UP to the nearest half day** (`staff.pro_rata_rounding =
  'up_half_day'`). Rounding to nearest can put a mid-year starter below their statutory
  minimum; rounding up costs at most half a day per starter and removes the argument.
- **Nothing carries over.** A scheduled task on 1 Jan posts the new `entitlement` credit;
  the prior year's balance simply ends with that year. (Carry-over would need a
  `carry_over` entry type — reserved in §3.4, unused.)

### 5.2 Requesting

Staff pick a date range, a type (`holiday` / `toil` / `unpaid`), and optionally mark the
first and/or last day as a half day. The system builds the day rows from the pattern,
skipping non-working days, and shows the cost in both days and hours before submitting.

**The impact preview is shown before the request is sent**, not just to the approver:
- balance now → balance if approved
- who else is off those days
- headcount vs `staff.min_headcount_by_weekday`
- a warning (never a block) if notice is under `staff.notice_days_warning`

Insufficient balance is a **warning, not a block** — per the platform rule, warnings not
hard gates. The request goes to admin with the shortfall shown plainly.

### 5.3 Approval

Approval posts the ledger `booking` debit (except `unpaid`, which posts nothing).
Decline posts nothing. See §11 for the approval surface — the context is the point.

### 5.4 Cancelling and changing

- **Future, unapproved:** staff withdraw freely.
- **Future, approved:** staff request cancellation; admin approves; a `cancellation`
  credit reverses the booking. Changing a future booking from holiday to unpaid (or vice
  versa) is a cancel + rebook, which is exactly what the ledger records.
- **Past:** staff cannot touch it. Admin posts a correction (§0.4).

---

## 6. Overtime and the bank

### 6.1 Logging

Staff log overtime against a date in 5-minute increments with a reason. Multiple entries
per date are normal and expected. Admin approves or declines.

### 6.2 The bank

An approved entry posts an `accrual` credit into the `overtime` account. **No decision
about what it becomes is made at that point** — during a busy run, nobody knows yet
whether they want the day off or the pay, and forcing the choice at approval is the main
thing wrong with how this usually gets built.

The bank is drawn down two ways, both debits against the same account:

| Drawdown | Mechanism | Ledger |
|---|---|---|
| Time off | A leave request with `leave_type = 'toil'` | `spend_toil` |
| Pay | Admin cashes out N minutes into a payroll period | `spend_paid` |

The row is never mutated; the decision is a new entry. Staff see one number ("14h 25m
banked") and can spend it either way from their own page (a TOIL request) or ask for it
in cash (which admin actions).

Taking a TOIL day slightly larger than the bank is allowed with a warning — warnings, not
gates. The balance goes marginally negative and clears on the next accrual.

### 6.3 Year end — cash out, do not expire

On 31 December a scheduled task posts a `year_end_cashout` debit for any remaining
positive overtime balance and adds it to the December payroll report.

**Not expiry.** Unused holiday above the statutory minimum can lapse; hours already
*worked* cannot simply be deleted, because that is forfeiting earned pay. Auto-cash-out
gives the same "doesn't roll over" outcome, removes the annual awkward conversation, and
means nobody has to remember the rule. `staff.overtime_year_end` can be set to `expire`
if policy ever changes, but the default is `cash_out` and changing it should be a
deliberate, advised decision.

`accrual` entries carry `minutes` at face value (1.0 multiplier). If a premium rate is
ever introduced, it belongs on the payroll export as a rate column, not as inflated
minutes in the bank — inflating minutes would corrupt TOIL time-off maths.

---

## 7. Absence

### 7.1 Recording

Admin opens an absence with a type, a start date, and no end date if it is ongoing. Day
rows are generated against the working pattern as the absence runs, so an open sickness
shows correctly on the calendar every day it continues.

Closing an absence sets `end_date`, computes `total_minutes` / `working_days`, and — for
sickness — raises the return-to-work task.

### 7.2 What staff see

`Absent`. Nothing else. Ever. (§0.5)

### 7.3 Return to work — the standard process

On closing a sickness absence, a notification goes to admin with a short structured form:

1. RTW conversation date
2. Fit to return? (yes / yes with adjustments / no)
3. Adjustments needed (free text)
4. Notes
5. Fit note received / expiry, if applicable

Stored on the absence, admin-visible only, fully audited. An absence with
`rtw_required = true` and no `rtw_completed_at` after 7 days chases once.

### 7.4 Sickness during booked holiday

When an absence is created that overlaps approved leave days, admin is prompted:

> "This overlaps 3 booked holiday days (Tue 14 – Thu 16 Jul). Reclaim them to the
> holiday allowance?"

Accepting posts a `correction` credit for those days' minutes and stamps
`staff_leave_request_days.reclaimed_absence_id`. The original leave request is untouched
and still shows in history — the reclaim is visible as its own ledger line, which is
exactly what you want if it is ever questioned.

### 7.5 Timed appointments — REMOVED, and why

**This section described a feature that was built and then taken out four days
later (migration 215). It is kept as a record of the reasoning, not as a
design. Do not build it again without asking.**

The original idea separated two needs:

| Need | Mechanism | Deducts? |
|---|---|---|
| **Taking time off** | Leave request | Yes |
| **Flagging an absence from the building** | Timed absence marker | No |

The second one was the mistake. An hour at the dentist created a
`staff_absences` row of type `medical_appointment` with
`deducts_allowance = false` and a day row of `portion = 'hours'`, 14:00–15:00.
Staff could record it themselves, it needed no approval, and it cost nothing.
The argument for it was operational: so the calendar and the coverage warnings
knew the office was short at 2pm, rather than discovering it at 2pm.

**Why it came out.** This module answers two questions — how much time has
someone worked, and how much time are they taking off. A marker answers
neither. It deducted nothing, was approved by nobody and belonged to no
account, which made it a presence tracker wearing an absence row's clothes.
Carrying it would have meant every future rule in this module having to say
"…except markers", and it had already started: a partial unique index with a
`portion <> 'hours'` carve-out, an overlap trigger that existed only for it,
and a `windows` array on `StaffDay` that only it could populate. jon's call,
and the right one — the operational need is real but it is a thing you say out
loud in an office of seven, not a row in an HR system.

**What covers the ground instead:**

- **Timed leave** (`portion = 'hours'`, migration 212, decision 3 in §18).
  "Leaving at 15:00 on Thursday" is time off: it deducts and it is approved.
  That is the thing people actually asked for, and it stays.
- **Half-day absence** (`am` / `pm`). Someone who goes home ill after lunch is
  a `pm` absence. That is what the portion column is for.

**The database enforces the removal**, so a stray insert cannot put the
calendar back into a state the merge layer no longer understands:
`portion IN ('full','am','pm')` and `start_time IS NULL AND end_time IS NULL`.
If it is ever genuinely wanted, relaxing those two constraints is the whole of
the change — the columns are still there, nullable and empty.

---

### 7.6 Reporting

Admin-only. Per person and team-wide, over a rolling window:
- number of separate absence **spells** and total days (spells matter more than days —
  five one-day absences is a different signal from one five-day absence)
- a configurable flag, default 3 spells in a rolling 3 months
- sickness days in a period, for the payroll report
- open absences with no RTW record

Never surfaced outside admin.

---

## 8. Working patterns, exceptions and swaps

### 8.1 Patterns

Admin sets each person's pattern: per weekday, working or not, start/end/break. 2-week
cycles supported for alternating patterns. Changing a pattern closes the current row
(`effective_to`) and opens a new one — it never edits in place.

### 8.2 Self-swap

Staff request "work Wed instead of Tue this week". Two exception rows, one
`swap_group_id`, one approval. No ledger involvement — a swap costs no allowance, it just
moves which day is contracted.

### 8.3 Person-to-person swap

Modelled (four rows, one group) but **not built as a self-service workflow in v1**. Two
people agree it between themselves; admin creates the swap in one action; both see it on
their calendars. At 7 staff this is the right trade — a two-party consent state machine
where any leg can later unwind is the single most complex thing in this module and the
least frequently used.

---

## 9. Freelancer day bookings

### 9.1 Why they are structurally separate

Showing a booked freelancer on the calendar is ordinary operational information and there
is nothing wrong with it. What creates employment-status risk is treating them like
staff: holiday entitlement, a contracted working pattern, or mandatory shifts.

So freelancers get **no ledger account, no working pattern, no entitlement**, and the
language throughout is **offered → accepted / declined**, never "rostered". A decline is
recorded as a response, never as a penalty. The agreed rate is per booking, negotiated,
not imposed by a schedule.

On the calendar they appear in a **separate, visually distinct lane** labelled
`Freelance (contracted)`, below the staff lanes.

### 9.2 What it does

- Book a person for a date: full day / half day / specific hours.
- Rate pre-fills from `people.default_day_rate` and is then fixed on the booking.
- `expected_total` computed and shown — a day's expected spend, and a month's, roll up
  for forecasting.
- Attach tasks: a van prep, a check-in, a warehouse job, an ad-hoc description. Tasks may
  reference a `job_id` or a vehicle.
- Invoice tracking mirrors `quote_assignments`: expected vs received vs queried.

### 9.2b What shipped (migration 222)

Booking and displaying, which is what was asked for. On the **staff calendar**,
not a page of its own: the moment you decide you need an extra pair of hands is
the moment you are looking at the week and seeing a thin day.

- A distinct amber lane below the staff rows, one row per freelancer booked in
  the window.
- The headcount row reads **"4 +2"** — staff and freelancers counted separately,
  collapsing to a single number on a day with nobody freelance. Merging them
  would claim they are interchangeable.
- Offered → accepted / declined recorded by admin; the freelancer-facing
  version below is NOT built.
- Expected spend for the window, and a count of completed days still waiting on
  an invoice.
- **One live booking per person per day** (unique index). Two stints in a day
  is one booking with the wider window and a note — the same call the leave
  design made, and for the same reason.
- `freelancer_day_booking_tasks` (§3.8) is **not built**. Per-booking task
  breakdown does not help answer "are there enough people in", which is what
  this is for; the booking's note covers "what are they doing" for now.

### 9.4 The offer email — DESIGNED, NOT BUILT

**SIGNED OFF (17 Sep 2026), not yet built.** jon agreed all four decisions
below as written. It sends mail to people outside the company, which is why it
waited; it no longer waits. Everything below is ready to build.

Today "Offer the day" writes a row and tells nobody. The freelancer finds out
when somebody rings them, which makes the status field a fiction — it says
`offered` when nothing has been offered.

**Shape**

- `response_token` on the booking: long random, indexed, mirroring
  `vehicle_hire_assignments.ooh_parking_token` (mig 072) rather than inventing
  a scheme. Cleared on response and dead after the booking date.
- A public route `/api/freelancer-days/respond/:token` — no login, GET renders
  the day and POST records accept or decline. Same posture as the OOH parking
  form and the storage T&Cs: a link in an email is a bearer credential, and the
  worst a stolen one does here is mis-set one day's availability, which the
  person turning up or not immediately contradicts.
- The email goes through `services/email-service.ts` like everything else, with
  two buttons and the day, times, what they are doing and the agreed rate.

**The chase, which is the bit that earns its keep**

| When | What | Who |
|---|---|---|
| On offer | The offer, with both buttons | The freelancer |
| +1 day, no reply | One chase, same links | The freelancer |
| Day before, still no reply | "Nobody has confirmed for tomorrow" | Admin, not the freelancer |

Stamped like every other chase in this module (`rtw_chased_at`,
`staff.overtime_cashout_reminded_year`) so each fires once. Intervals as
`system_settings`, defaulting to 1 day.

**Decisions taken, worth challenging**

1. **An unanswered offer is never auto-declined.** The date passing with no
   reply leaves it `offered` and surfaces to admin. Auto-declining would
   silently remove somebody who may well be planning to turn up.
2. **The last chase goes to ADMIN, not the freelancer.** Two emails is a
   reminder; three is nagging somebody who does not work for us. By then the
   problem is Ooosh's to solve, not theirs to answer.
3. **Declining is one click and needs no reason.** A reason box invites
   justification, and a decline is a response rather than something to excuse.
   There is an optional note for anyone who wants to add one.
4. **Cancelling a booking emails them too.** Somebody who has accepted a day
   and rearranged around it must not find out by looking at a calendar they
   cannot see.

**Three things that must land WITH the email, not after it**

Raised by jon on sign-off. Each is cheap now and awkward to retrofit once mail
is going out.

5. **A passed, unanswered offer needs a way to be closed.** Decision 1 says
   never auto-decline, which is right — but it leaves an `offered` day with no
   terminal state at all, so it sits in the admin list forever. Six months in
   the list is long enough that nobody reads it, which defeats the point of not
   auto-declining. One click on a passed offer: *they came anyway* (→
   `completed`) or *it did not happen* (→ a closed state). The safety net has
   to be clearable or it rots.

6. **There is no way to AMEND a booking — there is no update endpoint at all.**
   Today, changing a time, a rate or a date means cancel-and-rebook, which
   throws away the acceptance and re-offers the day. That is merely annoying
   now; once an email fires on every offer it means emailing somebody twice to
   move a start time by an hour. Needs `PATCH /freelancer-days/:id` with an
   explicit rule about which fields re-open the offer and which do not —
   proposed: **date and times re-offer** (they have to agree to the new day),
   **rate and notes do not** (tell them, do not re-ask). Amending a `cancelled`
   or `completed` booking stays refused.

7. **"Pulled out after accepting" is not the same fact as "declined".**
   `recordResponse` currently allows `accepted → declined`, so a freelancer
   dropping out the day before is recorded identically to one who never wanted
   the day. Those are different facts operationally — one left a hole at short
   notice — and under decision 4 they should send different mail. Wants its own
   status (`withdrew`) rather than overloading `declined`. Note `LIVE_STATUSES`
   and `BOOKING_STATUS[...].counts` both need it, and it is not cover either
   way.

### 9.3 Portal — NOT BUILT

**One decision needed before building, and only one:** is the portal
read-only-plus-respond, or can a freelancer also PROPOSE a change — "I can do
it, but not until 11"? That single answer changes the shape of the page. A
counter-offer is a third response alongside accept and decline, and it needs
somewhere to land, which is item 6 above; without it, "not until 11" has to go
through a phone call anyway. Do not start the page until this is answered.

New endpoints on `routes/portal.ts` mirroring the studio-sitter shape:

```
GET  /portal/day-bookings              → my upcoming bookings
GET  /portal/day-bookings/:date        → detail + tasks for that day
POST /portal/day-bookings/:date/respond → accept / decline
POST /portal/day-bookings/:date/tasks/:id/complete
```

New Next.js page `src/app/day/[date]` built on the existing `src/app/shift` patterns.
A booked freelancer with a van-prep task deep-links into the existing prep flow.

---

## 10. Surfaces

| Surface | Route | Who |
|---|---|---|
| Global staff calendar | `/staff/calendar` | All staff. Month + week. In/out only for peers. |
| My time | `/staff/me` | All staff. Balances (explainable), my requests, book time off, log overtime, my calendar. |
| Admin | `/staff/admin` | Admin. Approvals queue, employee directory, entitlements, patterns, absence, reports. |
| Dashboard strip | dashboard section `WhosIn` | All staff. Compact: today's names + status pips, plus a 7-day mini heat row. |
| Avatar menu | `Layout.tsx` | "My Time" for everyone; "Staff Calendar" (admin) alongside it. |
| Freelancer portal | `src/app/day/[date]` | Booked freelancers. |
| iCal | `GET /staff/ical/:token.ics` | Personal feed only. |

**The dashboard gets a strip, not a month grid.** The dashboard is already dense and has
user-ordered sections; a full calendar belongs at its own route. Registered via
`dashboard/v2/registry.ts` per PLATFORM-CONVENTIONS §"Dashboard extension points", with
aggregate data added to `GET /api/dashboard/operations` in a backwards-compatible shape.

**iCal:** per-user revocable token in `users.preferences.ical_token`. The feed contains
the person's own entries in full plus the team's in/out with no types or reasons. No team
export (§1, out of scope).

---

## 11. Approval — the bit BrightHR gets wrong

Today a BrightHR email shows the request and nothing else, so approving is a guess. The
whole differentiator here is that the approval surface carries the context.

Email → deep link to an approval page showing, for the requested dates:

- **Balance:** now → after approval, in days and hours, with a link to the full ledger.
- **Who else is off** those days, and who is scheduled in.
- **Headcount** per day vs `staff.min_headcount_by_weekday`, with a plain-language
  warning: *"Approve this and there is no warehouse cover on Thursday 12th."*
- **Operational load:** jobs going out and returning those days, and preps due — read
  from the existing dashboard aggregate, not a new query path.
- **Notice given**, flagged if under the configured threshold.

Every one of those is a **warning**. Nothing blocks approval. Admin decides.

Approvals are gated by a single helper, `canApproveStaffRequests(role)`, currently
`role === 'admin'`. One chokepoint, mirroring the `hasManagerRole()` pattern in
`lib/roles.ts` — widening it later to managers is a one-line change rather than an audit
of every call site.

---

## 12. Reports & payroll

### 12.1 Monthly payroll report

The thing that actually retires BrightHR: your accountants ask each month what changed,
and this answers it without re-keying.

`GET /staff/reports/payroll?from=&to=` → on-screen table + CSV, one row per person:

| Column | Source |
|---|---|
| Paid overtime (hours) | ledger `spend_paid` + `year_end_cashout` in range |
| Unpaid leave (days) | `staff_leave_request_days` where request type `unpaid`, approved |
| Sickness (days) | `staff_absence_days` where type `sickness` |
| Other absence (days) | remaining absence types, by type |
| Notes | free text |

Generation is **idempotent and derived from the date range** — re-running the same period
produces the same CSV. `staff_payroll_batches (period_start, period_end, generated_at,
generated_by, sent_at)` records what was generated and when it went, without stamping the
immutable ledger.

A scheduler task on the 1st of each month notifies admin that the previous month's report
is ready.

### 12.2 Other reports

- Balances and remaining liability across the team (holiday and banked overtime).
- Absence spells / repeat-absence flags (§7.6).
- Full audit trail per person: every ledger entry, request, decision, correction.

---

## 13. Settings (`system_settings`)

| Key | Default | Notes |
|---|---|---|
| `staff.leave_year_start_month` | `1` | Calendar year |
| `staff.statutory_weeks` | `5.6` | Per-person override on `staff_employment` |
| `staff.bank_holidays_policy` | `use_allowance` | Current Ooosh policy; per-person override |
| `staff.bank_holidays.<year>` | seeded list | England & Wales dates |
| `staff.pro_rata_rounding` | `up_half_day` | Never round below statutory |
| `staff.overtime_year_end` | `cash_out` | `expire` available, not advised (§6.3) |
| `staff.overtime_min_increment_minutes` | `5` | |
| `staff.min_headcount_by_weekday` | `{}` | Drives coverage warnings |
| `staff.notice_days_warning` | `14` | Warning only |
| `staff.absence_flag_spells` / `_months` | `3` / `3` | Repeat-absence flag |
| `staff.rtw_chase_days` | `7` | |

---

## 14. Migration & cutover

The timing is unusually favourable and should be aimed at deliberately:

- BrightHR expires ~Dec 2026.
- The leave year is calendar Jan–Dec.
- Neither holiday nor overtime carries over.

Therefore **on 1 Jan 2027 every balance legitimately starts at zero**, and there are *no
opening balances to migrate*. That is the smallest possible cutover — and it only exists
if we hit 1 Jan. A cutover in, say, March would mean hand-reconciling part-year accrual
for 7 people.

Plan:

1. **Oct–Dec 2026 — parallel run.** Patterns and the calendar go live first (Phase A is
   useful on its own). Staff log requests in both systems for a few weeks to shake out
   differences.
2. **Import 2026 history as read-only.** CSV export from BrightHR → ledger and absence
   rows flagged `source_type = 'import'`, marked non-authoritative, for reporting and
   audit continuity only. They are not summed into 2027 balances.
3. **1 Jan 2027 — entitlement task posts 2027 credits.** BrightHR read-only, then
   cancelled.
4. Verify the imported 2026 absence records before cancelling, since after that they are
   only in OP.

---

## 15. Phasing

16 weeks from Sep 2026 to the 1 Jan 2027 deadline.

| Phase | Content | Est. | Ships value alone? |
|---|---|---|---|
| **A** | `staff_employment`, patterns + exceptions, `staff-day-status.ts`, read-only global calendar, dashboard strip, avatar menu | 2 wks | Yes — "who's in today" |
| **B** | Ledger + trigger + `staff-balance.ts`, entitlement, leave requests, impact preview, approval with context, explainable balance | 3 wks | The core |
| **C** | Overtime entries, the bank, TOIL drawdown, cash-out, payroll report | 2 wks | Yes |
| **D** | Absence, sickness, RTW process, holiday reclaim, absence reports, employee directory + reviews | 2 wks | Yes — **shipped**, see §18 |
| — | Parallel run, BrightHR import, fixes | 3 wks | → **live 1 Jan 2027** |
| **E** | Freelancer day bookings + portal + expected invoice totals | 2 wks | **Independent of A–D** |
| **F** | Coverage intelligence (staffing vs prep/job volume), personal iCal | later | Post-go-live |

**Phase E depends on nothing in A–D** and can be pulled forward if booking freelancers
hurts more day to day than holiday admin does. It is the only phase that can move.

Phase F's coverage intelligence is the "compare things happening to staff in, flag
shortfalls" idea from the original brief. It needs the calendar to exist first and it
needs a season of real data to calibrate against, so it is correctly last.

---

## 16. Deferred, with reasons

- **Person-to-person swap consent workflow** (§8.3). Modelled, not built. Four legs, two
  consents, one approval, any leg unwindable. Admin creates both sides in v1. Revisit if
  it happens more than monthly.
- **Team iCal export.** A team feed in a personal Google account exports colleagues'
  absence data outside the company and cannot be recalled.
- **SSP calculation.** We flag qualifying days; the accountants compute. Building SSP
  logic means owning its correctness, which is not worth it for 7 people.
- **Carry-over.** Entry type reserved, no UI. Policy is that nothing carries over.
- **Manager-tier approval.** Helper chokepoint in place (§11); currently admin only.
- **Encrypted salary.** Deliberate — admin-gated at the API instead (§3.1).

---

## 17. To verify before go-live

Mechanics are ours; the statutory specifics should get a sanity check from the
accountants or an HR advisor. All of these are `system_settings` values, so a correction
is a settings change and not a deploy — that is why they are settings.

1. **Pro-rata rounding up** — confirm acceptable, and that no current contract rounds
   differently.
2. **Year-end overtime cash-out** — confirm with the accountants that banked overtime
   paid in December is handled cleanly in that month's payroll.
3. **Bank holidays not granted** — confirm the staff contracts say what the system will
   say. If a contract implies bank holidays are given, the setting must match the
   contract, not the other way round.
4. **The compressed-hours contract** — confirm entitlement is expressed in hours, not
   days. If the contract says "28 days", it is ambiguous for an unequal-length week and
   should be restated in hours at the next review.
5. **Will Parish's 15-minute weekly shortfall** (§0.1). His stated hours total 34h 45m
   against a 35h week. Either the contract says something different from the hours he
   works, or one day needs 15 minutes adding. Resolve before entering the pattern — it is
   a data question, not a design one, but it will be visible in every report once live.
6. **The standard working day.** The spec assumes 9–5 with a 1h unpaid lunch = 7h paid
   (35h week), inferred from the "40 hours less 5 × 1h lunch" framing. Confirm, because
   it sets everyone's entitlement. Note Will takes 30-minute lunches against the standard
   hour — fine under WTR (a 20-minute break covers a 6h+ day), but it should be what his
   contract says.
7. **Right-to-work records** (§3.1) — check what evidence is currently held for the 7
   staff and where, since the module will expect to hold it.
8. **NI numbers** — confirm they are wanted in OP at all before building the encrypted
   column. If payroll is the only consumer and the accountants already hold them, the
   safest version of this field is the one that does not exist.
9. **Sickness data retention** — how long absence records are kept. Feeds the outstanding
   GDPR retention policy item in `ROADMAP.md`.
10. **Payroll report format** — show the accountants a sample CSV before Phase C ships and
   shape the columns to what they actually want.


---

## 18. Build log — what is done, what changed, what is left

*Written 15 Sep 2026. Phases D, D0, D0.1, §20 and E appended over the following
two days, each after jon used the previous one in production and fed back.*

**HANDING OVER — read this first.** Every phase A–E has SHIPPED and is running
on `staff.oooshtours.co.uk`. The module is in use by jon alone, testing ahead of
the Oct–Dec parallel run, so live data is his test data and there is no staff
rollout yet. What is left is listed under **Still to build** below; the next
thing to build is the freelancer OFFER EMAIL (§9.4), which jon signed off on
17 Sep 2026 along with three items that must ship WITH it — a way to close out a
passed unanswered offer, an amend endpoint (there is none at all today), and
separating "pulled out after accepting" from "declined". §9.4 items 5–7.

### Shipped

| Phase | What | Migrations |
|---|---|---|
| **A** | Employment records, effective-dated working patterns, pattern exceptions / swaps, salary history, reviews, the who's-in calendar, the dashboard strip | 206 |
| **B1** | The append-only ledger, derived balances, entitlement (per pattern-period, pro-rated), the explainable balance UI | 208 |
| **B2** | Leave requests, impact preview, approval with operational context, cancel / decline / withdraw, My Time | 209 |
| **C** | Overtime in 5-minute steps, the bank, TOIL drawdown, cash-out, year-end sweep, payroll CSV, timed leave | 212 |
| — | Consolidation: Team Members + COT card register moved onto the Staff page; login linking; notifications and the daily digest | 213 |
| **D** | Absence and sickness, two-tier visibility, return-to-work + its one chase, holiday reclaim, absence reporting by spell, sickness on the payroll report | 214 |
| — | Timed absence markers removed — built in D, taken out on review (§7.5, decision 10) | 215 |
| **D0** | The §13 settings created and read, bank holidays seeded and marked, entitlement and the cash-out reminder on the scheduler, My Time by leave year | 216 |
| **D0.1** | Bank holidays computed rather than seeded; next year's entitlement granted in advance; cross-year request pricing; the post-sweep overtime residual; preferred name used site-wide | 218 |
| **§20** | Company days — granted to everyone, recurring or one-off, with the reclaim prompt and an annual November ask | 219 |
| **E** | Freelancer day bookings ("yard days") — booked and displayed on the staff calendar, agreed rate snapshot, expected spend, invoice tracking | 222 |

### Decisions taken during the build that CHANGE this spec

These were settled in conversation with jon and are now the design. Where they
contradict an earlier section, this list wins.

1. **Overtime is BANKED, not dispositioned at approval** (§6.2, as written).
   The original draft had the approver choose TOIL-or-pay at approval; jon
   pushed back — during a busy run nobody knows yet. Approval credits the bank;
   the choice is a later, separate debit. This was the right call and the ledger
   design absorbed it without change.

2. **Year end CASHES OUT, it does not expire** (§6.3). Hours already worked
   cannot be forfeited. The sweep is idempotent.

3. **Leave can be a timed PERIOD, not just a whole or half day.** The spec
   originally held leave to a half-day minimum with timed *appointments* as a
   separate non-deducting concept (§7.5). Staff also wanted to book "leaving at
   15:00", which with minutes as the unit costs nothing to support. `portion`
   is now `full | am | pm | hours`. The non-deducting appointment marker of
   §7.5 was built in Phase D and then removed — see decision 10, which
   supersedes this sentence.

4. **Rounding applies only to PRO-RATED entitlement.** Rounding a full year up
   to the half day inflated it — 5.6 weeks of an unequal four-day week is 22.4
   of that person's days, not a whole number of halves.

5. **Alerts are in-app AND email per request, plus a daily digest.** The
   original design was digest-only; jon correctly said a bell you have to be
   looking at is not an alert.

6. **Holiday allowance is entered in days OR weeks** and stored in **weeks** —
   a fixed day count goes wrong the moment someone changes their days per week.

7. **The Staff page is a UNION** of people with a login and people with an
   employment record, two-tier gated: account section at manager level (matching
   the access the old Settings list gave), everything else admin.

8. **Absence WINS over leave on the same date** (§7.4). Both rows legitimately
   exist — the reclaim deliberately leaves the approved holiday intact — so the
   merge had to choose, and what actually happened to the person that day is
   the absence. Admin sees both in `detail`; peers see neither, because the
   masking strips `detail` entirely. jon's steer: the staff-facing calendar
   shows whether someone is in, never why.

9. **Open absences materialise their day rows LAZILY, on the read** (§7.1). The
   spec implied a nightly job. A scheduled task that stops silently is noticed
   in March, so instead `materialiseDays()` is idempotent and every read calls
   it — the read repairs the data and it cannot drift. No new moving part.

10. **Timed absence markers were built, then REMOVED four days later**
   (migration 215, §7.5). They shipped as "two timed markers in one day are
   allowed, overlapping ones are not", which needed a `portion <> 'hours'`
   carve-out in the unique index and a trigger that existed for nothing else.
   jon then read it back and said it was blurring what the module is for, and
   he was right: it deducted nothing, was approved by nobody and belonged to
   no account. **Staff have exactly two things to do here — log overtime, and
   request time off as holiday or TOIL.** An absence is now whole, morning or
   afternoon, enforced by a CHECK. *The lesson is that a spec section can be
   internally coherent and still be the wrong feature; §7.5 argued its case
   well and had never been put in front of the person who would use it.*

11. **A deducting absence posts `booking` with `source_type = 'absence'`**, not
   a new entry type. The source is what distinguishes it from a leave request;
   inventing an entry type nobody would remember the rules for is how the one
   ledger bug in this module happened.

12. **Absence is admin-only, with no exceptions.** Raised as a
   single-point-of-failure risk — with one admin, nobody can record a sick day
   while jon is away. His call was to keep §0.5 strict and revisit the RBAC if
   it bites. The one exception used to be a person's own timed marker; decision
   10 removed it, so the rule is now simply "absence is recorded for staff, not
   by them".

13. **The 1 January entitlement grant runs DAILY, not annually.** §5.1 says
   "a scheduled task on 1 Jan", and an annual cron is a single point of failure
   with a one-year retry interval — a server down that morning means nobody has
   any holiday until somebody notices, and 1 Jan 2027 is a Friday bank holiday.
   `syncEntitlement` is idempotent, so a daily run grants once and no-ops
   thereafter, and picks up a mid-year hours change for free.

14. **The year-end cash-out REMINDS; it does not sweep.** Paying out banked
   overtime is money out the door, and the platform rule is that a recomputed
   figure gets surfaced for a human to decide on (CLAUDE.md). A cron that
   debited seven banks unattended is the thing that rule exists to prevent, and
   the ledger being append-only means an unwanted sweep is corrected with
   reversing entries rather than undone. The scheduler removes the "I forgot"
   failure, which is the one that actually bites: it emails every figure on
   `staff.overtime_cashout_reminder_day` (default 8 December, because §17.2 has
   this landing in DECEMBER's payroll), and the sweep stays a button.

15. **Bank holidays are seeded as DATES, never as pattern exceptions.** Under
   `use_allowance` they are ordinary working days. Seeding them as non-working
   exceptions would have been the obvious implementation and would have handed
   everyone eight free days a year that no ledger entry ever paid for.

16. **Bank holidays are COMPUTED, not stored.** 216 seeded 2026–2028, which
   immediately raised "who adds 2029?" — nobody, and the calendar quietly stops
   marking them. Seven of the eight are arithmetic and the eighth is Easter, so
   `services/bank-holidays.ts` derives any year and the setting became an
   override for the year the arithmetic is ever wrong. One-off royal bank
   holidays are deliberately not this file's problem: a coronation is "the
   company is shut", which is §20.

17. **Next year's entitlement is granted in ADVANCE.** Booking January from
   December showed the requester the whole of next year's allowance as a
   shortfall, because next year had no credit yet. It never blocked the
   request, but a blood-red warning over an ordinary two weeks reads as a
   refusal. Entitlement is deterministic from the patterns and the sync is
   idempotent, so granting it early costs nothing and corrects itself.

18. **The cash-out reminder chases a CLOSED year too.** jon's catch: take half
   the bank as TOIL, cash the rest out on the 20th, then work a long night on
   New Year's Eve — those minutes accrue to a leave year that has already been
   swept and that nothing ever looks at again. The reminder now runs in
   December for the current year and in January for the previous one, stamping
   year *and* phase so December's send does not silence January's follow-up.

19. **A company day is a layer ABOVE leave and absence, not beside them.** It
   changes whether the day is contracted at all, which is the level a pattern
   exception works at. Putting it there meant three things needed no rules of
   their own: leave cannot be booked on it, it does not count toward coverage,
   and the min-headcount floor cannot fire on it. Every one of those would have
   been a separate special case had it been modelled as a kind of leave.

20. **Next year became bookable, which is why it had been read-only.** My Time
   gated a future year read-only with "book against this year from the picker
   above", which jon rightly called confusing. The real cause was duller than
   the message suggested: the booking form seeded its dates from TODAY, so
   picking 2027 and opening the form gave you a 2026 date. Seeding the form
   from the year being viewed fixed it, and with next year's entitlement now
   granted in advance there was no reason left to gate it at all. *A gate put
   up to hide an awkward default outlives the awkwardness and then reads as a
   rule.*

21. **Freelancer days are "yard days" only.** jon: "I don't want to see where
   we've booked freelancers in for deliveries, just this new class of yard
   work." The distinction is whether they are physically in the building,
   because the calendar answers one question — have we got enough people in —
   and a freelancer on the road does not help with it. Delivery and driving
   assignments stay in `quote_assignments` and are untouched.

22. **Staff and freelancers are counted SEPARATELY and shown as "4 +2".**
   Following the §19 agreement: collapse to one number when there are no
   freelancers, show both when there are. Merging them into a single headcount
   would quietly claim they are interchangeable, and the whole reason the lane
   is visually distinct is that they are not.

23. **The portal side of §9.3 is deliberately NOT built.** jon asked for "a
   surface and mechanism for booking and displaying non-staff people", so
   accepted/declined is recorded by admin for now. The wording is already
   offered → accepted / declined throughout, so the freelancer-facing version
   is an additional route rather than a remodelling.

### Bugs found during the build, and what they teach

Kept because each one is a trap the next person could fall into.

- **`booking` posted against the overtime account.** Entry types are per
  account; spending the bank is `spend_toil`. Shipped in B2 and caught by the
  B1 constraint when a TOIL request was first approved. *Unit tests approved
  holiday and never TOIL — test the other branch.*
- **`syncEntitlement` was not idempotent for claw-backs**, so the 1 Jan
  scheduler would have drained a balance a little further every year. Fixed by
  counting what it had granted via `source_type = 'system'` rather than
  `entry_type`.
- **`createPattern` deleted every LATER pattern**, not just the one being
  replaced.
- **Coverage double-counted people already off** — right with two people,
  wrong with four.
- **`buildDays` priced against the leave-overlaid calendar**, so already-booked
  days silently vanished from a request instead of surfacing as a clash.
- **A `42P08`** from reusing one pg parameter in two type contexts.
- **`/me/balances` dropped a field** and every cached browser bundle rendered
  `NaNh NaNm`.
- **A timed leave period rendered as a whole-day `leave`**, so a two-hour early
  finish counted as absent all day in the coverage warnings.
- **`cancelAbsence` swept up its own credits.** It reversed every un-reversed
  ledger entry the absence had posted — which includes the CREDITS it and
  `closeAbsence` post. It tried to write a negative `cancellation`, and the
  sign constraint from migration 208 refused it. *The constraint was right and
  the code was wrong; that is the second time that table has caught a bug the
  type checker could not. Filter by `entry_type`, not just by source.*
- **`closeAbsence` materialised days before it wrote the end date**, so
  re-closing an absence LATER (a correction, "actually he was off until the
  10th") never generated the extra days. They then appeared on the next read,
  by which point they had missed their debit and were covered but free. The
  end date is now written first, so the catch-up sees the real range.
- **Bank holidays and company days contradicted each other on screen.** Adding
  Christmas Day as a company day left My Time still announcing that 25 December
  was a normal working day everyone would have to book off. Two overlapping
  facts with no stated precedence, surfaced in two places. A company day now
  wins — it is the more specific fact and the one Ooosh decided — and the rule
  lives in `lib/companyCalendar.ts` rather than in either page. *Whenever two
  features can describe the same date, one of them has to be told it loses.*
- **Next year's allowance read 0m for a day after the deploy.** The advance
  grant lived only on the 06:05 cron, so deploying it at lunchtime meant next
  year stayed empty until the following morning — with My Time saying "next
  year's allowance is already set" directly beside the zero. Fixed by granting
  lazily on read as well, bounded so a finished year is never granted
  retroactively. *A scheduled job is not a guarantee about state, it is a
  guarantee about eventual state, and the UI was asserting the former. Where a
  read can repair the data cheaply, it should — the same conclusion the absence
  catch-up reached.*
- **"Nothing left" and "nothing granted" rendered identically.** The My Time
  nudge showed "All of your 2027 holiday is booked or taken" for a year with no
  entitlement at all, because both come out as a zero balance. They are
  different facts and now read differently.
- **A leave request straddling 31 December was mispriced** (D0.1, found while
  investigating a report that January could not be booked at all). `getImpact`
  checked the WHOLE request against the start year's balance, while
  `approveRequest` had always debited per day into each day's own leave year.
  So a 28 Dec–4 Jan request was previewed entirely against December and then
  quietly put January into deficit on approval. *The preview and the ledger are
  two places deriving the same fact, which is this codebase's signature failure
  — and the reported symptom (a scary shortfall on a January booking) was a
  different, milder problem sitting on top of it.*
- **An override that could never be created.** `setSystemSetting` deliberately
  refuses an unknown key so a typo cannot invent one, which meant the new
  per-year bank holiday override was impossible for any year not already
  seeded — precisely the years it exists for. Fixed with an explicit
  `upsertSystemSetting` for the handful of genuinely open-ended keys. *A guard
  that is right for one caller can be exactly wrong for the next one.*
- **A notification passed a YEAR where a uuid was expected** (D0). The
  year-end reminder set `entity_id` to `'2027'` on a `uuid` column. Because
  `notify()` wraps its insert in `.catch()` so a bell failure can never take
  down an email, this failed *silently*: the email went out, the in-app
  notification simply never appeared. Fixed by typing the parameter
  `string | null` and passing null for anything that is about no single row.
  *A deliberately non-fatal catch still needs to say what it swallowed — the
  log line now names the notification type.*
- **A day whose debit had been reversed could never be charged again.** The
  "have I already debited this date?" check matched any entry on the day,
  reversal included. Shorten an absence and lengthen it back and those days
  came back free.

- **A future-dated OPEN absence could not be opened at all** (Phase D, caught by
  the scratch-database run, invisible to the type checker and to every unit
  test). `createAbsence` handed `buildAbsenceDays` today's date as the range
  end for an absence with no end date; for maternity starting next month that
  end is *before* the start, so it threw "the end date must be on or after the
  start date". The catch-up had the mirror of the same mistake, clamping *up*
  to the start date and so materialising a day that had not happened yet. Both
  now: an open absence runs start → today, and a spell that has not begun has
  no day rows at all. *The lesson is the old one — the fixture has to include
  the case where today is not inside the range.*

- **`<input type="time" step={900}>` did nothing.** The freelancer booking form
  was moved to quarter hours and still offered every minute, because `step`
  governs validation and the spinner arrows but Chrome's dropdown picker — the
  control people actually click — ignores it. The field was therefore happily
  accepting 09:07 from the only route into it anybody uses. Replaced with a
  `<select>` of the 96 quarter hours (`components/QuarterHourSelect.tsx`), so the
  granularity is ours rather than the browser's. *A constraint expressed only as
  an attribute hint is not a constraint. If the rule matters, own the options.*
  It also survived a review because the diff looked obviously correct — the bug
  was in a browser, not in the code.

- **A docstring claimed a refactor that had not happened.**
  `MentionComposer.tsx` said ActivityTimeline's two composers routed through it.
  They did not, so when preferred names were adopted site-wide in D0.1, the
  busiest mention surface in the app — Job, Person, Organisation and Venue — kept
  building names from `first_name` and quietly ignored them, as did every
  display name in `routes/interactions.ts`. Someone called Will was "Will" on
  the Inbox and "William Parish" on the job he was actually being mentioned on.
  *Comments describing structure go stale silently and are believed, because
  nothing type-checks them. When a note says work is finished, check the call
  sites before trusting it — and prefer wording that says what IS true over what
  was intended.*

### Still to build

**Phase E, the freelancer-facing half.** Booking and displaying shipped
(migration 222). What is missing is the part where the freelancer hears about
it at all:

- **The offer email with accept / decline links (§9.4)** — designed, costed and
  SIGNED OFF 17 Sep 2026. This is the next thing to do. It brings three
  companions with it (§9.4 items 5–7): closing out a passed unanswered offer,
  `PATCH /freelancer-days/:id` so a booking can be amended without
  cancel-and-rebook, and a `withdrew` status distinct from `declined`.
- **The portal page (§9.3)**, deliberately after the email — the email is the
  thing that actually reaches somebody. One question to answer first: whether a
  freelancer can counter-offer, or only accept and decline (§9.3).
- `freelancer_day_booking_tasks` (§3.8) — skipped on purpose; a per-booking task
  breakdown does not help answer "are there enough people in".

**Phase F — coverage intelligence and personal iCal** (§10, §16). Post-go-live,
and it wants a season of real data to calibrate against.

**Working location** (§19) — agreed in principle with jon, including that the
headcount shows two numbers and collapses to one when they match, and that the
calendar needs a location filter. Phase F; must NOT land before the parallel
run, because moving what "In" means mid-run muddies the comparison.

**Carried over:**
- Absence retention. §17.9 asks how long sickness records are kept; nothing
  expires them yet, and it feeds the open GDPR retention item in `ROADMAP.md`.
- Port My Time into Quick Actions (in `BACKLOG.md`, deferred until E–F land so
  the surface is not moved twice).
- A single home for freelancer RATES (`BACKLOG.md`) — today a rate lives in
  three unconnected places. Wanted, but it spans quoting and driver assignment
  as well, so it is its own piece.
- `staff.leave_year_start_month` is seeded but **the code assumes January**.
- `staff.overtime_min_increment_minutes` drives the UI and the service check,
  but `staff_overtime_entries` has a `minutes % 5 = 0` CHECK. Lowering the
  setting without a migration leaves the database refusing what the form offers.

**Not code — jon's to do before go-live:** the ten items in §17, which want a
sanity check from the accountants or an HR advisor, and the §14 cutover plan
(Oct–Dec parallel run, then the BrightHR import as read-only history).

### Verification approach — please keep doing this

Every phase was verified against a **real Postgres 16** with all migrations
applied from scratch and realistic fixtures, not only unit tests. Six of the
eighteen bugs above were invisible to unit tests and surfaced the moment real SQL
ran — including Phase D's, which no amount of type checking would have found.
Unit tests cover the pure date, entitlement and merge logic
(`staff-day-status.test.ts`, `staff-balance.test.ts` — 60 tests); everything
touching the database gets a scratch-database run.

Phase D's run is **kept in the repo** as
`backend/src/scripts/__verify-phase-d.ts` — 67 assertions over a fixture using
the unequal four-day week, covering the hard refusals, the masking, the lazy
catch-up, the reclaim, and the shorten/re-lengthen/cancel unwind that found
three of the four Phase D bugs. It refuses to run against a
`DATABASE_URL` that does not name a scratch database, because it writes
fixtures and momentarily relaxes two NOT NULL constraints to seed them:

```bash
createdb ooosh_scratch
DATABASE_URL=postgresql://…/ooosh_scratch npx tsx src/migrations/run.ts up
DATABASE_URL=postgresql://…/ooosh_scratch npx tsx src/scripts/__verify-phase-d.ts
```

There are six: `__verify-phase-d.ts` (66), `__verify-d0.ts` (40),
`__verify-d0b.ts` (30), `__verify-company-days.ts` (38),
`__verify-lazy-entitlement.ts` (10) and `__verify-freelancer-days.ts` (36).
**Give each its own database.** Several of the things
they check are team-wide — the cash-out reminder sums everyone, coverage
warnings count everyone — so one script's fixtures change another's answers.
Running all three against one database produced two failures that were purely
that, and it took a solo re-run to tell them from real ones.

---

## 19. Proposed — working location ("boots on the ground")

**Not agreed, not built.** Raised by jon after the timed markers came out (§7.5),
as a better answer to the need that feature was reaching for.

### Is this the marker again?

It is the first question to ask, and the answer is no — but only because of one
structural difference, and it is worth being precise about it or this gets
rejected for the wrong reason.

The marker was an **absence row that was not an absence**. It deducted nothing,
was approved by nobody, belonged to no account, and yet lived in
`staff_absences` and had to be special-cased out of every rule that table has.

A working location is an **attribute of a working day**. The person IS working,
IS contracted, IS counted, IS paid. Nothing about leave, absence or the ledger
is involved, so nothing has to say "…except locations". It sits orthogonally to
the whole in/out question rather than pretending to be part of it.

The honest counter-argument is that both are "a thing staff type in that costs
nothing", and the marker proved that is a weak reason to build something. The
difference that rescues this one is that **it changes a number somebody uses**:
headcount. That is a testable claim, and §19.3 is where it gets tested.

### 19.1 The need

"Who is in" currently answers *who is contracted and not off*. It does not
answer *who is in the building*, and for a warehouse those are different
questions: someone working from home cannot take a delivery, prep a van, or let
a client in. Coverage warnings that count a WFH day as cover are quietly wrong.

### 19.2 Shape

```sql
staff_work_locations
  id, person_id, location_date DATE, person_id + date UNIQUE,
  location VARCHAR(20) CHECK IN ('office','home','on_site','travelling'),
  note TEXT,                      -- "at Brighton Dome all day"
  created_by, created_at
```

Plus a **default per pattern day**, so "Tom is home on Fridays" is stated once
rather than typed every week — `staff_working_pattern_days.default_location`,
following the same effective-dated rule as everything else on that table
(§0.3). A row in `staff_work_locations` overrides the pattern default for that
date, exactly as a pattern exception overrides the pattern.

Merging happens in `mergeAbsenceLayer()`'s sibling in `staff-day-status.ts` —
**the one attachment point**, per the rule that has now held through two phases.
A `location` field is added to `StaffDay`; it is set only when `status` is
`working` or `partial`, because a location on a day off is meaningless.

**Staff record their own**, and this time that is right: where you are working
is not special-category data, it costs nothing, and the person who knows is the
person typing.

### 19.3 The bit that needs deciding first

**What does "In" mean on the calendar footer and the dashboard strip?**

Today it is one number. With locations it is two — contracted-and-working, and
physically-here — and they will disagree. Options:

1. **"In" stays as-is, location is a chip on the cell.** Smallest change;
   coverage warnings keep counting a WFH day as cover, so the warnings stay
   subtly wrong and the feature is decoration.
2. **"In" becomes "in the office"**, with WFH shown separately. Answers the
   real question; changes the meaning of a number people have been reading
   since Phase A, and changes what §5.2's coverage warnings and
   `staff.min_headcount_by_weekday` count.
3. **Two numbers: "Working 5 · In the office 3".** Honest, no silent
   redefinition, slightly busier.

**Option 3 is the recommendation**, with `staff.min_headcount_by_weekday`
switched to count office presence — that setting exists precisely to say "we
want two bodies here on a Monday", and bodies is what it means.

**Agreed with jon**, plus two refinements from him:

- **Collapse to one number when they agree.** "Working 5 · In the office 5"
  is noise; on a day nobody is remote it should just read "5". The two-number
  form should be the exception that draws the eye, not the permanent state.
- **The calendar needs a location FILTER**, so "show me who is on site" is a
  view rather than a sum done in someone's head.

Until that is decided the rest is not worth building, because the whole value
is in the number.

### 19.4 Why it is not urgent

It is Phase F work (§15): coverage intelligence, post-go-live. It changes no
balance, blocks no cutover, and wants a season of real data to calibrate
against. It should NOT go in before the Oct–Dec parallel run — that run exists
to shake out leave and patterns, and moving what "In" means mid-run would
muddy the comparison it is there to make.

---

## 20. Company days ("bonus" days off) — SHIPPED (migration 219)

Raised by jon: he grants a couple of extra days off a year that should not come
out of anyone's allowance — Christmas Day being the standing example, since
under `use_allowance` it is otherwise an ordinary working day.

### 20.1 Why not just use what exists

Two mechanisms look like they would do it and both are wrong:

- **A pattern exception per person.** `staff_pattern_exceptions` already makes
  a date non-working, and the calendar already reads it. But it stores a
  *person* fact, and a company day is a *company* fact: seven rows to grant one
  day, nothing to edit when it changes, and a new starter silently does not get
  it. Recurring ("every Christmas Day") cannot be expressed at all.
- **Leave with a type that does not deduct.** This is the timed-marker mistake
  again — a leave request nobody requested and nobody approved.

### 20.2 Shape

```sql
staff_company_days
  id, day_date DATE, label TEXT NOT NULL,        -- "Christmas Day", "Office closed"
  recurs BOOLEAN NOT NULL DEFAULT false,         -- same month + day, every year
  status VARCHAR(20) DEFAULT 'active' CHECK IN ('active','cancelled'),
  created_by, created_at
  UNIQUE (day_date) WHERE status = 'active'
```

One row grants it to everybody, resolved at read time, so a new starter gets it
without anyone remembering. It merges in `staff-day-status.ts` — the same
single attachment point — **before** leave and absence, because it changes
whether the day is contracted at all, exactly as a pattern exception does. A
company day makes the day `not_scheduled` with a reason.

It also subsumes the `granted` bank-holiday policy (§5.1): if that setting ever
flips, the computed bank holidays become company days through the same path
rather than a second mechanism.

### 20.3 The part that needs care

**Somebody will already have booked holiday on it.** Grant Christmas Day in
November and anyone who had already booked it off has paid for a day the
company has now given them. Silently leaving that is the mirror image of
"never silently move money" — it silently fails to give it back.

The mechanism already exists: §7.4's reclaim, which posts a `correction` credit
per day and stamps the leave day. Adding a company day should therefore do what
opening an absence does — **show which approved leave days it collides with and
offer to reclaim them**, per day, defaulting to all. Not automatic: giving
allowance back is a decision, and the platform rule is that a recomputed figure
gets surfaced for a human.

### 20.4 The three questions, answered

1. **Applies to everyone, always** — jon's answer. A part-timer who does not
   work Fridays gains nothing from a Friday closure; that is inherent, and the
   merge leaves such a day unlabelled rather than writing "Closed" over a day
   they already had off.
2. **Recurring on a fixed date, PLUS an annual prompt.** jon: "25th Dec will
   always be Christmas Day, but it won't always be a working day for everyone
   — perhaps an annual review to input the company days for the coming year?"
   Both, therefore: `recurs` handles the fixed ones and a scheduled prompt each
   November asks for the year's one-offs, which are the ones nobody remembers.
3. **Does not count toward `min_headcount_by_weekday`** — agreed. It falls out
   rather than needing a rule: the day resolves to `not_scheduled`, so it never
   reaches the coverage list at all.

### 20.5 Where it is controlled

**Settings → Staff time & company calendar**, alongside bank holidays, because
from a staff member's point of view they are the same kind of thing: days that
are not normal working days. The staff calendar carries an admin link to it,
since noticing you need one and configuring it are different moments and only
the second wants a form.

### 20.6 What 29 February does

A recurring day on 29 February is **skipped** in a common year rather than slid
to the 28th. Sliding would invent a day off nobody agreed to; skipping is
visible on the calendar and a one-off covers it if that was the intent.
