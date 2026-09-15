---
paths:
  - "backend/src/services/staff-{day-status,employment,balance,leave,overtime,absence,notifications,settings}.ts"
  - "backend/src/routes/staff-calendar.ts"
  - "backend/src/migrations/{206,208,209,212,213,214}_*.sql"
  - "frontend/src/pages/{StaffCalendarPage,StaffAdminPage,MyTimePage,StaffAbsencePage}.tsx"
  - "frontend/src/components/{StaffBalancePanel,LeaveApprovals}.tsx"
  - "frontend/src/components/dashboard/v2/sections/WhosIn.tsx"
---

# Staff Calendar & Time — load-bearing rules

Full design: `docs/STAFF-CALENDAR-SPEC.md`. This file is the "never do X" list.
**Hard deadline: live 1 January 2027** (BrightHR expires; the leave year is
calendar Jan–Dec so 1 Jan is the only cutover with no balances to migrate).

## Minutes are the only stored unit

Days and hours are **display only**. One member of staff works four days of
unequal length (450 / 450 / 555 / 630 min), so "a day" is not a fixed quantity
and must never be assumed to be one. Anything that stores or compares time
stores minutes.

A person's "day" for display = weekly contracted minutes ÷ working days per
week, from the pattern **in force on the date being shown**.

## Never SUM `staff_ledger_entries` outside `services/staff-balance.ts`

That module is THE definition of every holiday and overtime figure. A second
place deriving the same number is how two screens end up disagreeing and
neither can be shown to be wrong.

| Question | THE definition |
|---|---|
| How much holiday / TOIL has someone got? | `services/staff-balance.ts` |
| Is this person in on this date? | `services/staff-day-status.ts` |
| Is this person off sick, and for how long? | `services/staff-absence.ts` |
| What is the threshold / policy / bank holiday? | `services/staff-settings.ts` |

## The ledger is append-only and the database enforces it

`staff_ledger_entries` has a `BEFORE UPDATE OR DELETE` trigger that raises.
Mistakes are fixed by posting a **reversing entry** (`reverses_entry_id`),
never by editing. Both rows stay visible — that is the point.

Entry types are constrained **per account**. `booking`/`entitlement`/
`cancellation` are holiday; `accrual`/`spend_toil`/`spend_paid`/
`year_end_cashout` are overtime. Spending the bank on a day off is
`spend_toil`, **not** `booking` — getting this wrong shipped once and the
constraint is what caught it.

Absence writes to the ledger in two places, both through `postEntry()`:
a `deducts_allowance` absence posts a **`booking`** debit with
`source_type = 'absence'` (the source is what tells it apart from a leave
request — there is no separate entry type), and reclaiming holiday overtaken
by sickness posts a **`correction`** credit per day (§7.4). A reclaimed TOIL
day credits the **overtime** account, not holiday — sending it to holiday
would quietly convert banked overtime into annual leave.

## Working patterns are effective-dated and never edited in place

Changing someone's hours **closes** the current pattern and opens a new one.
Editing would retroactively rewrite every historical calendar and past balance.
`createPattern` deletes only a pattern starting on the *same* date and bounds
the new one against the next — never `>=`, which silently destroyed later
patterns.

Leave days **snapshot** the minutes they cost at booking time, so a later hours
change cannot re-price an approved holiday.

## Warnings, not gates

Not enough balance, short notice, nobody left to cover — all shown, none
blocking. Only these hard-refuse, because they corrupt data rather than
inconvenience anyone:

1. double-booking a date (unique index on `(person_id, leave_date) WHERE is_live`)
2. requesting days someone is not contracted to work
3. paying out more overtime than is banked
4. a timed leave period longer than that day's contracted hours
5. two absences over the same date (unique index on
   `staff_absence_days(person_id, absence_date) WHERE is_active`)

## Thresholds come from `staff-settings.ts`, never from a literal

Every configurable number in spec §13 — statutory weeks, the notice warning,
the coverage floor, the absence flag, the RTW chase, the pro-rata rounding, the
bank holiday policy and dates — is seeded by migration 216 and read through
`services/staff-settings.ts`. **Do not reintroduce a hardcoded `14` or `3`.**
§17 lists nine statutory specifics that want checking with the accountants
before go-live; the whole point of them being settings is that a correction is
a settings change, not a deploy.

Every getter falls back to a documented default, so a missing or malformed row
degrades and logs rather than breaking. The seeded values and the defaults in
`DEFAULTS` are deliberately identical — change one, change the other.

Two settings that do NOT do what their name suggests:
- `staff.leave_year_start_month` is seeded for completeness; **the code assumes
  January** throughout.
- `staff.overtime_min_increment_minutes` drives the UI and the service check,
  but `staff_overtime_entries` has a `minutes % 5 = 0` CHECK. Lowering the
  setting without a migration leaves the database refusing what the form
  offers.

## Bank holidays are COMPUTED, and are DATES rather than days off

`services/bank-holidays.ts` derives England & Wales dates for any year,
substitutes included. **Do not go back to a seeded list** — 216 did, and it
lasted two days before the "who adds 2029?" question arrived.
`staff.bank_holidays.<year>` is an OVERRIDE: empty means compute.

Policy is `use_allowance`: a bank holiday is an ordinary working day here and
someone who wants it off books holiday like any other day. They are **marked**
on the calendar, nothing more.

**Never seed them as `staff_pattern_exceptions`.** That is the obvious
implementation and it would make them non-working — silently handing everyone
eight free days a year that no ledger entry ever paid for.

A one-off royal bank holiday is not a date correction. It is "the company is
shut that day", which is a company day (spec §20) and is not built yet.

## The entitlement grant runs daily; the cash-out only reminds

`runEntitlementSync` is on a DAILY cron, not an annual one on 1 January. An
annual job has a one-year retry interval, and 1 Jan 2027 is a Friday bank
holiday. It is idempotent, so it grants once and no-ops after — and picks up a
mid-year hours change for free.

It syncs the current leave year **and the next one**, so booking January from
December has a balance to draw on rather than reporting the whole of next
year's allowance as a shortfall.

`runCashOutReminder` **emails the figures and posts nothing.** Paying out
banked overtime is money out the door, and the platform rule is to surface a
recomputed figure for a human. The sweep stays a button. Its deadline is
DECEMBER payroll (§17.2), not 31 December, which is why the reminder defaults
to the 8th. It stamps `staff.overtime_cashout_reminded_year` so it cannot nag
every morning — same lesson as `rtw_chased_at`.

It also runs in **January, for the year just ended**, because the sweep does
not close a year, it empties it at a moment in time: overtime worked between
the cash-out and New Year accrues to the swept year and nothing would ever look
at it again. The stamp carries year *and* phase (`2027:dec`, `2027:jan`) so the
December send does not silence the January follow-up.

## An absence is a whole day, a morning or an afternoon — never timed

Migration 215 removed timed absence and the self-recorded "out 14:00–15:00"
marker that came with it. **Do not put it back without asking.** It deducted
nothing, was approved by nobody and belonged to no account — a presence tracker
wearing an absence row's clothes, and every future rule in this module would
have had to say "…except markers". The database refuses it now:
`staff_absence_days.portion IN ('full','am','pm')` and
`start_time IS NULL AND end_time IS NULL`.

**Timed LEAVE is a different thing and still exists.** "Leaving at 15:00 on
Thursday" (`staff_leave_request_days.portion = 'hours'`, migration 212) deducts
and is approved, which is exactly what a marker did not do. Someone who goes
home ill after lunch is a `pm` absence.

`StaffDay.windows` is therefore always length 0 or 1. It is an array because a
day could once carry several markers; it is kept because API shapes only ever
gain fields.

## Absence wins the calendar, and both rows survive

`mergeAbsenceLayer()` in `staff-day-status.ts` is the ONLY place leave and
absence are reconciled. Absence beats leave on the same date, because that is
the sickness-during-holiday case (§7.4): the reclaim deliberately leaves the
approved leave request intact, so both rows legitimately exist. Admin sees
both in `detail`; peers see neither.

## Open absences materialise lazily, on the read

A sickness with no end date cannot have its day rows written up front.
`materialiseDays()` is idempotent and is called from every absence read AND
from `getAbsenceOverlay()`, so **the read repairs the data**. Deliberately not
a nightly job: one that stops is noticed in March. It never writes past today
— and an absence that *starts* in the future opens with no day rows at all,
which is what the catch-up then fills.

`getAbsenceOverlay()` lives in `staff-day-status.ts`, next to
`getLeaveOverlay()` and not in `staff-absence.ts`, because `staff-absence.ts`
reads the calendar to price days — a static import both ways is a cycle.

## Special-category data is masked in the service, not the browser

Sickness and parental data is masked inside `staff-day-status.ts`
(`maskForViewer`), so an unmasked shape never reaches a route. Peers see
`Absent` or a time window — never a type or reason. Do not "fix" a calendar by
returning full records and hiding them in React.

**Every `/absences` route is `adminOnly`** (`STAFF_ADMIN_ROLES = ['admin']`),
with no exceptions. Staff have exactly two things to do in this module: log
overtime, and request time off as holiday or TOIL. Absence is recorded for
them, not by them.

## Email is LIVE

Production runs `EMAIL_MODE=live` over Resend and has since mid-2026.
`EMAIL_LIVE_TEMPLATES` is the **test-mode** allowlist and is ignored when live —
a new template needs nothing added to it. Do not tell anyone to edit it. (See
`.claude/rules/email-and-notifications.md`, which says the same thing.)

## Anything that prices leave must be PER LEAVE YEAR

`approveRequest` has always debited one entry per day into that day's own
`leave_year`, so a request straddling 31 December hits two accounts. Anything
that previews, validates or reports on that request has to split the same way —
`getImpact` did not, and a 28 Dec–4 Jan request was checked entirely against
December's balance and then quietly put January into deficit. `LeaveImpact.perYear`
is the split; the top-level figures are the first year's, kept for the common case.

## Display names come from `lib/displayName.ts`

`people.preferred_name` is what somebody is CALLED. The avatar, the @mention
list, the dashboard greeting and "Posting as …" all read it through
`displayFirstName` / `displayFullName` / `displayInitials`, so the answer cannot
drift between surfaces. It is served by `/auth/login`, `/auth/me` and `/users`.

**Not for anything legal or financial** — payroll, the hire agreement,
right-to-work records and carnets want the passport name and build it
themselves.

## API response shapes only ever GAIN fields

`/me/balances` dropped `balanceMinutes` when the breakdown landed, and every
browser still holding the previous JS bundle rendered `NaNh NaNm`. A cached
bundle is the normal state right after a deploy. Add fields; don't remove them.

## A login and a staff record can point at different people

Everything hangs off `staff_employment.person_id`. If `users.person_id` points
elsewhere, My Time reads zero and every request is refused. The Staff page
shows this as **No login** on the employee, with a *Link a login* action that
moves `users.person_id`. The reverse is impossible — the ledger cannot be
UPDATEd. The person-merge in `routes/duplicates.ts` does **not** remap any
staff table; do not use it to fix this.
