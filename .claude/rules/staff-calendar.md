---
paths:
  - "backend/src/services/{staff-day-status,staff-employment,staff-balance,staff-leave,staff-overtime,staff-absence,staff-notifications,staff-settings,staff-company-days,freelancer-days}.ts"
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
| Is the company shut on this date? | `services/staff-company-days.ts` |

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

## Freelancer days are NOT staff time

`services/freelancer-days.ts` has no ledger account, no working pattern, no
entitlement, no holiday, no overtime and no absence — and must keep none of
them (spec §9.1). **If a change here needs staff-balance.ts, something has gone
wrong.** Showing a booked freelancer on a calendar is ordinary operational
information; giving them a contracted pattern or accrued leave is what creates
employment-status risk.

**The wording is load-bearing**: offered → accepted / declined. Never
"rostered", "assigned" or "shift". A decline is a recorded response, not a
penalty, and the rate is agreed per booking. Do not tidy this into something
more familiar.

**An OFFER is not cover.** `offered` shows on the calendar as a dashed
"Pending" cell and is counted separately (`+n?`), never inside the confirmed
`+n`. Same call pending leave makes: everyone needs to see it coming, and
showing it as confirmed would be a lie the person planning the week then acts
on. `BOOKING_STATUS[...].counts` in `StaffCalendarPage.tsx` is the one place
that decides which statuses are real cover.

**Nothing emails the freelancer yet** (spec §9.4, designed and not built), so
`offered` currently means "we intend to ask", not "we asked". Do not lean on it
meaning more than that until the email ships.

Only YARD days — people physically in the building. A freelancer booked to
drive a delivery lives in `quote_assignments` and does not belong here, because
the only question this answers is "have we got enough people in".

Staff and freelancers are counted **separately** on the calendar ("4 +2"),
collapsing to one number when there are no freelancers. Merging them would
claim they are interchangeable.

## Freelancer day times are quarter hours, from a `<select>`

`components/QuarterHourSelect.tsx` owns the option list. **Do not go back to
`<input type="time" step={900}>`** — it was that, and the step did nothing:
`step` drives validation and the spinner arrows, but Chrome's dropdown picker
ignores it and offers all sixty minutes, so the field took 09:07 from the one
route anybody uses.

**Overtime is the exception and stays a time input on 5-minute steps.**
`staff_overtime_entries` has a `minutes % 5 = 0` CHECK; the two are answering
different questions.

## Bank holidays and company days are different things

A **bank holiday** is computed, and under `use_allowance` is an ordinary
working day that merely gets marked. A **company day** is granted by Ooosh and
is genuinely not a working day.

**Where they land on the same date, the company day WINS** — it is the more
specific fact and the one Ooosh decided. That precedence lives in
`frontend/src/lib/companyCalendar.ts` (`splitBankHolidays`, `dayMarker`) and
nowhere else: both the staff calendar and My Time need it, and two places
deciding it is how they came to contradict each other on screen. Both are managed in the same place (Settings →
Staff time & company calendar) because staff see them as the same kind of
thing, but they must never be conflated in code: a one-off royal bank holiday
is a company day, not a bank-holiday date correction.

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

**Do not rely on the cron alone.** `ensureEntitlement(personId, year)` grants
lazily on read — from `/me/balances`, the admin team overview and the impact
preview — because the cron only fires at 06:05 and a deploy at lunchtime left
next year reading 0m for the rest of the day, beside a line saying the
allowance was already set. Same rule as the absence catch-up: the read repairs
the data. It **never touches a past year** — granting a finished year would
invent an allowance nobody can take.

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

## A company day is a layer ABOVE leave and absence

`mergeCompanyDays()` runs BEFORE the leave/absence merge in
`staff-day-status.ts`, because a company day changes whether the date is
contracted at all — the level a pattern exception works at, not the level "are
they off today" works at. One row grants it to EVERYONE, resolved at read time.

Put it there and three things need no rules of their own: leave cannot be
priced on it, coverage does not count it, and `min_headcount_by_weekday` cannot
fire on it. **Do not remodel it as a kind of leave or absence** — every one of
those becomes a special case, which is exactly how the timed marker went wrong.

A day someone was not working anyway is left **unlabelled** rather than marked
"Closed": a part-timer gains nothing from a Friday closure, and saying so on
their existing day off is noise.

Granting a day that people have already booked off means they have paid for
something they are now being given. The create response carries
`reclaimCandidates` and the UI offers to hand it back — per §7.4's mechanism, a
`correction` credit and a stamp. **Offered, never automatic.** Withdrawing a
company day deliberately does NOT re-debit what was handed back.

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

`services/display-name.ts` is the backend twin — `greetingName` for an email
greeting, `fullDisplayName` for a full name, `DISPLAY_NAME_SQL` for a name built
in the query. Use those rather than a fresh `CONCAT(p.first_name, …)` or a bare
`|| 'there'`, and remember to SELECT `preferred_name` or they quietly return the
legal name.

**Check the call sites before believing a comment that says this is done.**
`MentionComposer.tsx` claimed ActivityTimeline routed through it; it did not,
and the busiest @mention surface in the app ignored preferred names for weeks
after D0.1 shipped them "site-wide". Nothing type-checks a docstring.

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
