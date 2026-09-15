---
paths:
  - "backend/src/services/staff-{day-status,employment,balance,leave,overtime,absence,notifications}.ts"
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
5. two whole-or-half-day absences over the same date (unique index on
   `staff_absence_days(person_id, absence_date) WHERE is_active AND portion <> 'hours'`)
6. two timed markers on one day whose windows **overlap** (a trigger, not an
   `EXCLUDE` constraint — that needs `btree_gist` and a superuser). Two
   non-overlapping markers in a day are fine and expected: in late *and* away
   early is two entries.

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

Every `/absences` route is `adminOnly` (`STAFF_ADMIN_ROLES = ['admin']`), with
two deliberate exceptions: `POST /absences/marker` and
`DELETE /absences/marker/:id`, where someone records their own "out 14:00–15:00"
— that carries no health information beyond the window. `GET /me/absences`
serves a person their OWN record as dates only; reason, notes, fit-note status
and the return-to-work write-up are the employer's record and are not in it.

## Email is LIVE

Production runs `EMAIL_MODE=live` over Resend and has since mid-2026.
`EMAIL_LIVE_TEMPLATES` is the **test-mode** allowlist and is ignored when live —
a new template needs nothing added to it. Do not tell anyone to edit it. (See
`.claude/rules/email-and-notifications.md`, which says the same thing.)

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
