# Staff Calendar & Time Module — Spec

**Status:** Draft for build (Sep 2026). Fleshes out `docs/SPEC.md` §3.9 "Staff & HR
Management", which was written in Phase 1, scheduled into Phase 3, and then dropped out
of `ROADMAP.md` entirely. Nothing has been built.

**One-line:** Replace BrightHR with a module that (a) knows everyone's working pattern,
(b) holds one immutable ledger of holiday and overtime, (c) lets staff request time off
and log overtime for admin approval *with the operational context visible at the moment
of approval*, (d) records sickness and other absence with a proper return-to-work
process, and (e) books freelancers onto days without treating them as staff.

**Hard deadline: live 1 January 2027.** The BrightHR subscription expires around Dec
2026 and the leave year is calendar Jan–Dec. See §14.

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
- Timed appointment markers ("out 14:00–15:00") that flag absence from the building
  without deducting anything (§7.5).
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
  reason_category   VARCHAR(50)
  notes             TEXT
  self_certified    BOOLEAN NOT NULL DEFAULT false
  fit_note_received BOOLEAN NOT NULL DEFAULT false
  fit_note_expiry   DATE
  ssp_qualifying    BOOLEAN             -- flag for the accountants; we do not compute SSP
  rtw_required      BOOLEAN NOT NULL DEFAULT true
  rtw_completed_at  TIMESTAMPTZ
  rtw_by            UUID REFERENCES users(id)
  rtw_fit_to_return BOOLEAN
  rtw_adjustments   TEXT
  rtw_notes         TEXT
  created_by, created_at, updated_at

staff_absence_days
  id, absence_id, absence_date DATE, minutes INT,
  portion VARCHAR(10) NOT NULL DEFAULT 'full'
    CHECK (portion IN ('full','am','pm','hours')),
  start_time TIME,          -- set when portion = 'hours' (§7.5)
  end_time   TIME,
  UNIQUE (absence_id, absence_date)
```

`deducts_allowance` defaults false — goodwill, bereavement and sickness do not come out
of holiday. It exists so an odd case can be handled without a new type.

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
  window?: { start: string, end: string },  // set when portion = 'hours' (§7.5)
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

### 7.5 Timed appointments — "I'm at the dentist 2–3 on Tuesday"

Two different needs get conflated here, and separating them is what keeps the rules
simple:

| Need | Mechanism | Deducts? |
|---|---|---|
| **Taking time off** | Leave request | Yes — **minimum half a day**, always |
| **Flagging an absence from the building** | Timed absence marker | No, by default |

**Leave stays in half-day chunks.** `staff_leave_request_days.portion` remains
`full / am / pm` and the request UI offers nothing finer. Nobody books 40 minutes of
holiday.

**Appointments are a presence marker, not leave.** An hour at the dentist creates a
`staff_absences` row of type `medical_appointment` with `deducts_allowance = false` and a
day row of `portion = 'hours'`, 14:00–15:00. It costs nothing, needs no approval, and
exists purely so the calendar and the coverage warnings know the person is out — which is
the whole point: not discovering at 14:00 on Tuesday that the office is empty.

**Staff can create these themselves.** This is the one absence type staff may self-record
(everything else is admin-entered). Auto-approved, editable by the person while it is in
the future, and admin sees them in the approvals feed as information rather than as a
decision.

**Masking (§0.5) still applies, and matters here.** Peers see the *time window* and
nothing else:

> `Will — out 14:00–15:00`

Never the type. The time is operational information the team needs; "medical appointment"
is health-adjacent and stays admin-only. `staff-day-status.ts` returns `status: 'partial'`
with the window, and strips `detail.absenceType` for non-admin viewers.

If policy ever wants an appointment to be deducted, flipping `deducts_allowance` on that
absence posts the ledger debit — no new mechanism.

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

### 9.3 Portal

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
- Absence spells / Bradford-style flags (§7.5).
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
| **D** | Absence, sickness, RTW process, holiday reclaim, absence reports, employee directory + reviews | 2 wks | Yes |
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
