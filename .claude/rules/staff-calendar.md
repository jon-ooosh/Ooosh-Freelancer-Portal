---
paths:
  - "backend/src/services/staff-{day-status,employment,balance,leave,overtime,notifications}.ts"
  - "backend/src/routes/staff-calendar.ts"
  - "backend/src/migrations/{206,208,209,212,213}_*.sql"
  - "frontend/src/pages/{StaffCalendarPage,StaffAdminPage,MyTimePage}.tsx"
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

## The ledger is append-only and the database enforces it

`staff_ledger_entries` has a `BEFORE UPDATE OR DELETE` trigger that raises.
Mistakes are fixed by posting a **reversing entry** (`reverses_entry_id`),
never by editing. Both rows stay visible — that is the point.

Entry types are constrained **per account**. `booking`/`entitlement`/
`cancellation` are holiday; `accrual`/`spend_toil`/`spend_paid`/
`year_end_cashout` are overtime. Spending the bank on a day off is
`spend_toil`, **not** `booking` — getting this wrong shipped once and the
constraint is what caught it.

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
blocking. Only four things hard-refuse, because they corrupt data rather than
inconvenience anyone:

1. double-booking a date (unique index on `(person_id, leave_date) WHERE is_live`)
2. requesting days someone is not contracted to work
3. paying out more overtime than is banked
4. a timed leave period longer than that day's contracted hours

## Special-category data is masked in the service, not the browser

Sickness and parental data is masked inside `staff-day-status.ts`
(`maskForViewer`), so an unmasked shape never reaches a route. Peers see
`Absent` or a time window — never a type or reason. Do not "fix" a calendar by
returning full records and hiding them in React.

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
