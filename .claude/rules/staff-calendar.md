---
paths:
  - "backend/src/services/{staff-day-status,staff-employment,staff-balance,staff-leave,staff-overtime,staff-absence,staff-notifications,staff-settings,staff-company-days,staff-wfh,staff-ical,freelancer-days,freelancer-tasks}.ts"
  - "backend/src/routes/{staff-calendar,staff-calendar-feed,freelancer-tasks}.ts"
  - "backend/src/migrations/{206,208,209,212,213,214,269,270,276}_*.sql"
  - "frontend/src/pages/{StaffCalendarPage,StaffAdminPage,MyTimePage,StaffAbsencePage}.tsx"
  - "frontend/src/components/{StaffBalancePanel,LeaveApprovals,PayrollReportPanel,FreelancerTasksPanel}.tsx"
  - "frontend/src/components/dashboard/v2/sections/WhosIn.tsx"
---

# Staff Calendar & Time — load-bearing rules

Full design: `docs/STAFF-CALENDAR-SPEC.md` — **§18 "Where it stands" is the
handover**. This file is the "never do X" list.
**LIVE since October 2026** (earlier than the original 1 January 2027 plan;
2026 history backfilled from BrightHR). Expected to be complete — what is
deliberately not built is in spec §16.

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
| Is this person working from home? | `services/staff-wfh.ts` (merged into `StaffDay.location` by `staff-day-status.ts`) |
| What goes in somebody's calendar feed? | `services/staff-ical.ts` |

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

## Manual adjustments: for what no flow owns, and the person sees them

Staff page › Employment › balance panel › "+ Add an adjustment" (Oct 2026)
posts an `adjustment` with `source_type = 'manual'` through the existing
`POST /employees/:personId/ledger`. It is for things no flow owns — a balance
brought across from BrightHR (2025 overtime still owed at the switchover), an
agreed one-off. **Never** for holiday booked, overtime worked or a pay-out:
those have their own forms and their own entry types.

The note is REQUIRED and the person sees it: My Time lists every un-reversed
manual adjustment as a row, so the figure on the card is always explained by
the list beneath it. A mistake is undone with Reverse; the adjustment and its
reversal then cancel and neither shows.

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

**Booking one is the whole team's job** (jon, Oct 2026): every freelancer-day
route is `authorize(...STAFF_ROLES)` and the calendar's "Book a freelancer"
is ungated. That is a separate gate from `STAFF_ADMIN_ROLES` / `adminOnly`,
which guards HR records and stays admin-only — never widen one by way of the
other.

Only YARD days — people physically in the building. A freelancer booked to
drive a delivery lives in `quote_assignments` and does not belong here, because
the only question this answers is "have we got enough people in".

Staff and freelancers are counted **separately** on the calendar ("4 +2"),
collapsing to one number when there are no freelancers. Merging them would
claim they are interchangeable.

## Freelancer tasks belong to a booking or a shift — never a person (spec §21)

`services/freelancer-tasks.ts` is the only place that decides whose a task is.
A task has NO person and NO date: both come from its owner (a day booking, or a
sitter shift's LIVE assignment), so a reassigned sitter inherits the evening's
tasks and an amended booking moves its tasks. Never add either column.

- Not To Do (staff-only) and never for freelancers on driving jobs.
- **No email per change.** "Send update" is a deliberate staff press; the only
  automatic email is the 16:00 sitter summary, and only when tasks changed.
- **A van prep is ticked by saving the prep** (`save-event` → `autoTickPrep`),
  not by a portal button — the portal refuses it.
- Soft-cancel only (`status = 'cancelled'`); there is no DELETE.

## Freelancer day times are quarter hours, from a `<select>`

`components/QuarterHourSelect.tsx` owns the option list. **Do not go back to
`<input type="time" step={900}>`** — it was that, and the step did nothing:
`step` drives validation and the spinner arrows, but Chrome's dropdown picker
ignores it and offers all sixty minutes, so the field took 09:07 from the one
route anybody uses.

**Overtime owns its options too, on 5-minute steps** (Sep 2026 My Time
redesign): an hour `<select>` and a minute `<select>` offering only 00, 05 … 55,
in `LogOvertime` (`MyTimePage.tsx`). `staff_overtime_entries` has a
`minutes % 5 = 0` CHECK, and the old `<input type="time" step={300}>` had the
same hole as above. The ceil-to-5 snap is kept as a guard but is now a no-op.

**Overtime cannot be logged into the future.** On today's date the end time may
be at most 15 minutes past now (log "until 18:00" at 17:55 on the way out).
It is a browser-side check on the person's own clock — the server's timezone is
not theirs. Unlike the leave warnings this one blocks: overtime that has not
happened yet is a mistake, not a judgement call.

**Past midnight is ONE entry** (Oct 2026): To at or before From means the
shift ran into the next day — 22:00–02:00 is 4h, dated the day it started.
The selects stop at 23:55, so splitting at midnight was not possible. The
16h cap still applies.

**Nor inside contracted hours.** On a plain working day (`StaffDay.status =
'working'`) an entry overlapping that day's start–end is refused — the unpaid
break included: working through lunch is not overtime here (jon, Sep 2026).
Days off, leave days and `partial` days are not checked — we know a part-day
person was in for SOME of it but not which part. Checked in the browser (read
from `/staff-calendar/me`; if that read fails the form blocks nothing) AND in
`POST /staff-calendar/overtime`, so a stale bundle cannot get round it. The
"not in the future" check is browser-only on purpose — see above.

## The freelancer offer link is a bearer credential, and the GET never writes

`services/freelancer-day-offer.ts` owns the token; `routes/freelancer-days.ts`
is the public, unauthenticated half. Rules that are not negotiable:

- **A GET must never record a response.** Mail scanners (Outlook Safe Links,
  corporate filters) follow every URL in a message before a human sees it, so a
  one-click accept URL accepts on the freelancer's behalf. The email carries the
  intent (`?r=accept`); only an explicit POST writes.
- **A backdated booking is NEVER emailed.** The form calls it "Record the day"
  for a reason — asking somebody whether they are free last Tuesday is nonsense.
- **A dead link must say WHY.** `resolveResponseToken` returns a reason —
  passed / answered / cancelled / completed / unknown — and the page has a
  sentence for each, ending with the office number. Somebody is in a corridor
  with their phone working out whether they are expected tomorrow; a 404 does
  not answer that.
- **The token stays live after they answer** (a departure from §9.4's original
  "cleared on response"). Reopening the email to check your start time is
  ordinary, and a cleared token answers it with "we do not recognise that link".
  It cannot double-record — resolve refuses anything that is not still
  `offered` — and it dies when the date passes.
- `offer_email_sent_at` means **we actually told them**. Never stamp it without
  checking `result.success`; see the email rules.

## An unanswered offer is never auto-declined — but it must be closeable

`runFreelancerOfferChase` (daily 09:05) nudges the freelancer ONCE
(`offer_chased_at`), then alerts ADMIN the day before (`admin_alerted_at`).
Neither leg touches `status`: somebody who has not replied may still turn up,
and removing them silently is the worse error (§9.4 decision 1).

- **Stamp a chase only when the send actually succeeded.** A stamp on a failed
  send burns the single chase that booking gets and nobody ever finds out.
- **Never chase a booking with `offer_email_sent_at IS NULL`** — the send failed
  or it is a backdated record that is never emailed. Chasing somebody about an
  email they never got reads as gibberish. That is the resend button's job.
- **`lapsed` is not `cancelled` and not `declined`.** Cancelled is Ooosh calling
  the day off; declined is them saying no; lapsed is nobody ever answering.
  Conflating them loses the only signal that says "we asked and heard nothing".
  It is not a live status, so a written-off day frees the slot for a rebooking.

## Amending a yard day: the DAY and the HOURS re-ask; the rate and notes tell

`PATCH /freelancer-days/:id` → `amendBooking`. Moving the day or the hours is a
different commitment, so the status goes back to `offered`, the acceptance is
cleared and the offer email goes again. Changing the rate or the notes sends
`freelancer_day_updated`, which deliberately has NO buttons.

- **A re-offer must reset `offer_chased_at` and `admin_alerted_at`.** Those
  stamps are per QUESTION, not per booking — leaving them set means the new
  question never gets its nudge and never reaches the day-before alert.
- **Switching a timed day to a whole one has to null the times**, or the
  `freelancer_day_times` CHECK rejects the update.
- **Four statuses mean four different things and none of them may be merged:**
  `declined` (never wanted it) · `withdrew` (accepted, then pulled out) ·
  `cancelled` (Ooosh called it off) · `lapsed` (nobody ever answered).
  `recordResponse` refuses `accepted → declined` for exactly this reason.

## A new kind of freelancer work has to be added to the history view

`GET /people/:id/freelancer-history` merges FOUR sources — crew/transport
assignments, studio-sitter shifts, driven vehicle assignments and yard days.
Yard days were missing for weeks after the module shipped, so somebody whose
only work with us was yard days had an EMPTY Freelancer tab, which reads as "we
have never used them" rather than "this list does not know about that kind of
work".

Add any new kind of freelancer work here as well as to its own module, and give
its statuses a `statusLabel` and a `statusPillClass` in
`FreelancerHistorySection.tsx` or they render raw.

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
recomputed figure for a human. The sweep stays a button.

**It sends ONCE, on 2 January, for the year just ended** (§17.2, settled with
jon 21 Sep 2026): whatever is banked at 31 December goes into JANUARY payroll,
which must be in before the 5th for the 10th pay run. Until Oct 2026 it also
sent on 8 December (`staff.overtime_cashout_reminder_day`, now unused) and
waited until the 5th in January — asking for a pay-out before December's
overtime was in, and following up after the payroll deadline had passed. Do
not bring either back. It stamps `staff.overtime_cashout_reminded_year`
(`2026:jan`) so it cannot nag every morning — same lesson as `rtw_chased_at`.

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

## A company day on your day off is a day in lieu (§20.5b, Oct 2026)

`syncCompanyDayLieu()` (`staff-company-days.ts`) credits ONE nominal day to
anyone whose RAW pattern has them off on a company day — same number of days
for everyone, not pro-rata (jon). It runs inside `syncEntitlement()`, so the
06:05 sync and "Update entitlement" keep it right, and adding or withdrawing a
company day refreshes it at once. Credited in advance, dated on the company day.

- **Its own `source_type`, `company_day_lieu`** (migration 278). Never `system`
  — `syncEntitlement` sums that for its own delta and would correct the lieu
  away — and never `manual`, or it cannot tell its own postings apart.
- **It follows the calendar**: idempotent per date, posting the difference, so
  a change of working days or a withdrawn company day TAKES THE DAY BACK. This
  is deliberately unlike the reclaim (a company day over a BOOKED holiday),
  which is offered by a human and never re-debited.
- Read the raw contract (`includeCompanyDays: false`) — with company days
  applied every one of those dates reads "not scheduled" for everybody.
- Shown on My Time as a "Day in lieu" row.

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

## The calendar shows "Off" — one colour for leave AND absence

Leave and absence are the same violet and the same word on the team calendar
(jon, Oct 2026). A separate colour for sickness would tell everybody WHY
somebody is not in, which is what `maskForViewer` exists to prevent; admins
get the reason on hover from `detail`. Do not split them back apart.

A **requested** (not yet approved) day is `status: 'partial'` with
`pending: true` — still counted in, because nothing is agreed — and shows as a
dashed "Requested", never "Part". "Part" is only a genuinely part day.

## An admin's list calls must say whose

`GET /leave` and `GET /overtime` with no `personId` return EVERYBODY's records
to an admin — the approvals list depends on it. A page showing one person's
time must pass `personId=` or `mine=1`; My Time once listed the whole team's
leave as an admin's own. The Staff page's Time off tab is `MyTimePage
personId={…}` — one page, two viewers, so the figures cannot drift.

## Working from home is a LOCATION on a working day, not leave

Spec §19 (Oct 2026, migration 269). `StaffDay.location = 'home'` comes from the
pattern's `at_home` tick (a regular day, admin-set) or an APPROVED
`staff_wfh_requests` row (a one-off, asked for and approved like holiday).
`mergeWfhLayer()` is the ONE place they are applied, after the absence merge.

- **Nothing here touches the ledger, a balance or an absence.** If a WFH
  change needs `staff-balance.ts`, something has gone wrong.
- **Only on a day actually worked.** A day off, on leave or off sick carries no
  location — the merge strips it.
- **Pending is not home.** A request waiting is `homePending`; until somebody
  says yes they are expected in, and they still count as on site.
- **Two states, whole days** (jon): in the building, or working but not here.
  Do not add `on_site` / `travelling` / half days without asking.
- **Cover counts the BUILDING.** `getImpact()` coverage and
  `staff.min_headcount_by_weekday` count `status === 'working' && location !==
  'home'`. The calendar footer shows the on-site number, plus `+n⌂` only when
  somebody is home; the dashboard strip does the same.
- Not special-category — every viewer sees it.

## The calendar feed is the person's OWN time — nothing else, ever

`services/staff-ical.ts` is the only thing that decides what is in a feed
(spec §10, migration 270). Own approved + requested time off, own home days,
company days. **Never** a colleague's time, never overtime, never absence: a
calendar app syncs and shares far beyond this platform, and what has left
cannot be recalled. The token is a credential — `/me/calendar-feed` takes no
`personId`, admin or not, and resolves only while the person is `employed`.

## The payroll report emails itself on the 1st

`runPayrollReportEmail()` (08:20 daily) emails last month's figures to every
admin from the 1st, once — jon submits to payroll before the 4th. It stamps
`staff.payroll_report_sent_month` only after a send SUCCEEDS (a failed day
retries tomorrow); clear that setting to resend. Figures come from
`getPayrollReport()` — never a second SUM.

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

## `rtw_` means TWO different things — check which table

A genuine trap, live in the schema since Sep 2026:

| Column | Table | Means |
|---|---|---|
| `rtw_checked_on` · `rtw_document_type` · `rtw_expires_on` · `rtw_checked_by` | `people` (mig 206) | **RIGHT TO WORK** — the legal check |
| `rtw_required` · `rtw_date` · `rtw_chased_at` | `staff_absences` (mig 214) | **RETURN TO WORK** — the post-sickness conversation, and the 08:50 chase |

Nothing is renamed (both are live and referenced), so never assume from the
prefix. `runRtwChase()` in `staff-notifications.ts` is return-to-work; anything
reading `people.rtw_*` is right-to-work and is admin-only.

## The private columns on `people` never go out through a people response

`people` is read by the whole team — `routes/people.ts` is gated on
`STAFF_ROLES` and both its GETs `SELECT p.*`. Migration 206 added right-to-work
and NI columns to that table, so until Sep 2026 every staff member, general
assistant and weekend manager got a colleague's immigration-status fields and NI
ciphertext with any person record they opened.

**`services/people-private-fields.ts` is THE list**, and both people GETs run
their rows through it. Add a private column to `people` and you must add it
there too — the admin-gated staff surfaces read those columns by name, so
redacting the general response costs them nothing.

Write them through `updateKeyData()` in `staff-employment.ts` only. The NI
number itself leaves the server through exactly one route
(`GET /staff-calendar/employees/:personId/ni-number`), which writes an
`audit_log` row with action `read` on every call. Every other read returns
`has_ni_number` as a boolean.

## Never restore a CHECK constraint on `audit_log.action`

Migration `032_fix_audit_log_action_constraint` **deliberately dropped** the
original `create | update | delete` CHECK and widened the column to VARCHAR(50),
because the platform writes `resolve_referral`, `merge`, `mark_washed`,
`override_document_gate`, `correct_mileage` and more — several from call sites
that INSERT into `audit_log` directly rather than through `logAudit()`.

Migration 232 tried to re-impose a four-value CHECK as a side effect of an
unrelated feature. Postgres refused it (`is violated by some row`), which was
the correct outcome — had those rows not existed it would have succeeded and
begun rejecting live writes. The whole migration rolled back and took an
unrelated column with it, breaking a shipped feature. See
`docs/STAFF-RECORDS-SPEC.md` §13.6.

Two rules from it:
- **`action` is open free text.** Add a value by using it; `logAudit`'s union
  type is a hint, not the set.
- **One migration, one concern.** A feature's schema change must never share a
  transaction with an unrelated change to a core table, or one blocks the other.

## A failed load must never render as an empty one

`StaffRecordFiles` showed "No files yet." when its fetch 500'd, and
`StaffKeyData` rendered nothing at all — indistinguishable from "this person
isn't an employee". Three failing requests looked calm on screen for a whole
testing round because of it.

Any component that fetches needs three states, not two: loading, failed, and
genuinely empty. Track the error separately from the data and say which it is.

## The staff document check is NOT the driver system

Two things share the words "DVLA check" and must never be merged:

| | `services/driver-validity.ts` | `services/staff-doc-cycles.ts` |
|---|---|---|
| About | self-drive-hire **clients** | **employees** |
| Asks | "insurable for this hire, today?" | "have we looked at it this year?" |
| Window | **30 days** from the check | the record's own `action_on` — pre-filled as **12 months** per `doc_type` |
| If it fails | hard gate on dispatch | a nudge |

jon's decision, Sep 2026, and it settled a design question the spec had been
circling: the cheapest answer to "how do we share this?" was "we don't".
Nothing in the staff module reads `drivers`. See `docs/STAFF-RECORDS-SPEC.md`
§19.1.

## One date per staff record — `action_on` is the only clock

Since migration 243 a staff record file fires on ONE date, `action_on`, with
`action_kind` remind | delete, `action_delivery` bell / email / both and
`action_user_id` (NULL = every admin). It replaced two clocks — printed expiry
and re-check cycle — that could nag twice about one passport.

- **The per-type intervals are a PRE-FILL, not a clock.** `getReviewIntervals()`
  and the expiry lead feed `suggestActionDate()` in `StaffRecordFiles.tsx`; the
  stored date is all `runRecordActionChase()` reads. Don't re-add a derived scan.
- **`expiry_chased_at` / `review_chased_at` are legacy** — nothing reads them.
- **"Delete" never deletes.** It flags the record; a human presses Delete.
- **Re-arm only on a real change.** The PATCH compares old against new
  (`IS DISTINCT FROM`) before clearing `action_chased_at`, because the edit form
  sends every field and an untouched save must not re-fire a sent reminder.

## Review actions must carry `reviewId`

`POST /api/staff-tasks` with `reviewId` stores `source_type = 'staff_review'`.
Without it the action is a plain manual to-do, and silently misses the
follow-up email, the "From your review" badge and the check-in list — which is
exactly how every review action was saved before Sep 2026 (spec §22.1).

## Absence detail expires; the absence does not

`runAbsenceDetailPurge()` nulls `reason_category`, `notes` and the
return-to-work narrative 12 months after a spell ends, then stamps
`detail_purged_at`.

**`absence_type` is NOT purged, and must not be.** `getSicknessMinutes()`
filters on `absence_type = 'sickness'` and the payroll report reads it —
purging the type would silently zero everybody's sickness figures instead of
anonymising them. Day rows, minutes and ledger effects stay for the same
reason.

Right-to-work evidence past its retention (employment + 2 years) is **surfaced
on the attention list, never swept**: destroying it is irreversible, and the
clock runs off a hand-typed leaving date.
