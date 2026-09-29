# To Do — the things that fall between the cracks

**Status: CLOSED 29 Sep 2026. Phases 1–4 BUILT — assigning §13, repeating
§14, lists and pull-ins §15, the closing gaps §16. Phase 5 (person /
organisation links) deliberately skipped — kept as a possibility in
`docs/reference/BACKLOG.md`.** Written straight after the staff records module closed
(`docs/STAFF-RECORDS-SPEC.md` §23), from the discussion recorded in §0; jon's
answers to §12 are recorded there.

---

## 0. The ask, in jon's words

> "Capture all the sorts of things that fall between the cracks — all those
> surfaces [job reminders, Problems, vehicle issues] are about hires or things
> that we have that are hireable. [To Do is] the other things — staff training,
> review follow-ups, but also the mundane: read the gas and electric meters, a
> shopping list of things to get next time someone goes to Tesco, when's the
> next time our recycling is getting collected, book an air con service for
> Room 1."

Decisions already agreed in that discussion:

- **Not in the Inbox.** The Inbox is things that *happened*; To Do is things
  somebody has *committed to*. The Inbox carries the bell ("Sam gave you a
  to-do") and links here.
- **Anyone can assign a single to-do to anyone.**
- **A recurring to-do set for somebody else must be accepted.**
- **"Assigned by me"** with a follow-up date the assigner can reset.
- **One owner per to-do, never several.** "Anyone can do this, once" is a
  shared list item that someone takes on, "like a pull request" (jon);
  "everyone must do this" is one copy each.
- **Recurring is calendar-style** (Google Calendar's custom recurrence), with
  one open occurrence at a time.
- **Everyone can see Everyone.**
- **Links to other records: not in v1** (§9).

---

## 1. What already exists — build on it, don't rebuild it

| Thing | Where | Notes |
|---|---|---|
| The table | `staff_tasks` (mig 233, 234) | owner `person_id`, title, detail, due, status open/done/cancelled, `source_type`/`source_id`, `next_chase_date` that re-arms |
| The rules | `services/staff-tasks.ts` | `assertCanTouch()` is the whole security surface; create/update/cancel; 22 tests |
| The page | `pages/MyTasksPage.tsx`, Me › My To Do | add, edit, tick, drop, re-open, finished list with due/done dates |
| The chaser | `runTaskChase()`, 09:45 | nudges the owner on `next_chase_date`, then re-arms |
| Review actions | `source_type = 'staff_review'` | linked since STAFF-RECORDS §22.1; "From your review" badge |
| Job reminders | `job_requirements` type `reminder` | per job, multiple people = **one row each**, own delivery settings — stays where it is |
| Problems | `job_issues` | a case file (history, photos, costs); has `assigned_to` |
| Company calendar | `lib/companyCalendar.ts`, Settings | bank holidays and company days |

**The table keeps its name.** `staff_tasks` is referenced by the review
module, the chaser and the tests; renaming it buys nothing. "To Do" is the
product name, `staff_tasks` the storage.

---

## 2. What To Do is NOT — the boundaries

The failure this spec exists to avoid is a fourth place to put the same thing.

| If it's about… | It lives in… | To Do's part |
|---|---|---|
| a job | the job's remind-me | shows *my* job reminders in Mine, read-through (phase 4) |
| something that went wrong on a hire | Problems | shows Problems *assigned to me* in Mine, read-through (phase 4) |
| a van's MOT / service / compliance | the vehicle module | nothing |
| something that happened | the Inbox | the bell that points here |
| everything else | **To Do** | owns it |

"Read-through" means the row shows in Mine with a badge and a link back to its
job or Problem, and ticking it goes through **that module's own endpoint**.
To Do never writes to `job_requirements` or `job_issues` itself — two write
paths to one row is the drift CLAUDE.md's helper rule exists to stop.

---

## 3. The three shapes of thing

jon's examples sort into three shapes. Getting this right is most of the design.

| Shape | Examples | Owner | Model |
|---|---|---|---|
| **Task** | book the aircon service, training follow-up | one person | a `staff_tasks` row |
| **Recurring task** | read the meters (every Thursday), bins, recycling | one person, or a list | a **series** that produces one open task at a time (§6) |
| **List item** | Tesco shopping, "someone fix the loo roll holder" | nobody, until taken | a task with a **list** and no owner (§7) |

**Several people** is never one row:
- *"Anyone, once"* → a list item. Someone takes it on and it becomes theirs.
- *"Everyone must"* (read the new policy) → one copy per person, created
  together, each ticked on its own — the same as job reminders already do.

A to-do with several owners is exactly the ambiguity that loses things: when
it's ticked, did everyone do it, or one person?

---

## 4. The surface — one page, tabs as views

**Placement — jon's call (§12.3):** it stays on the Me page, as its **first
tab and the default**: `/me?tab=todo`, with the views below as a second row of
tabs in `&view=mine|assigned|everyone` so a bell can deep-link. (The spec had
proposed a top-level `/todo`; the Me page keeps it where people already look.)

| Tab | Shows | Who |
|---|---|---|
| **Mine** | everything I own: my to-dos, review actions, (phase 4) my job reminders and my Problems | everyone |
| **Assigned by me** | what I gave to other people, with my follow-up date (§5.2) and their progress | everyone |
| **Lists** | the shared lists and their items; add, tick, "I'll take it" | everyone |
| **Everyone** | every open to-do, grouped by owner, filterable | everyone (jon: "everyone should see everyone"), minus private ones (§8) |

The old `/me?tab=todo` link — already in bells — lands on Mine.

Every tab is a **view of the same rows**, not a different kind of thing — how
Asana, Linear and Todoist do it. The distinction between the tabs is only
"whose, and from where".

---

## 5. Assigning

### 5.1 Anyone to anyone

- Any staff member can put a one-off to-do on anyone's list. It lands
  directly, with a bell to the new owner. (Asking someone to "accept" buying
  milk is friction with no protection in it.)
- `created_by` is the assigner; that is what "Assigned by me" reads.
- **The assigner can edit or drop what they assigned**, as can the owner and
  any admin. `assertCanTouch()` gains the assigner case — and its tests with it.
- The owner can **hand it back**: a decline with a reason, which returns it to
  the assigner's list and bells them. Nothing silently disappears.

### 5.2 The assigner's follow-up — a second clock

The owner's nudge (`next_chase_date`) answers "did I do it?". The assigner
needs a different one: "did they do it?". So each task assigned to somebody
else carries `follow_up_on`, the **assigner's** date:

- default: the due date, or a fortnight out when there isn't one (the same
  default as the owner's nudge)
- on that date the assigner gets a bell: "Will's 'Book the refresher' — still
  open"
- "reset the follow-up" = move the date; ticking the task clears it and tells
  the assigner it's done

Two dates, two people, two questions — never one date doing both jobs.

---

## 6. Recurring

### 6.1 The rule — Google Calendar's custom recurrence

- **Repeat every** N **day / week / month / year**
- **Weekly:** on which weekdays (M T W T F S S)
- **Monthly:** on day N of the month, **or** on the Nth (1st–4th, or last)
  *weekday* — "first Tuesday", "last Friday" (jon: yes please)
- **Ends:** never / on a date / after N occurrences

Stored as a small JSON rule on the series, parsed by one function with its own
tests. No iCal library: the subset above is a few dozen lines, and a library
would bring the whole RRULE language, most of which nobody here would use.

### 6.2 Two modes — both needed

| Mode | Means | Example |
|---|---|---|
| **On a schedule** | dates come from the calendar, whenever the last one was done | read the meters every Thursday; first Monday of the month |
| **After the last one** | the next is N after the last one actually happened | **bins and recycling**: monthly, but calling them in early resets the next visit |

jon's bins are the second kind, and they are why this can't be calendar-only.

### 6.3 One open occurrence at a time

A series has **at most one open task**. The next one is created when the open
one is ticked or dropped:

- *On a schedule*: the next rule date after today (so a missed Thursday
  doesn't breed a backlog of three overdue meter readings after a holiday)
- *After the last one*: the date it was ticked + the interval

**The next date can be moved by hand at any time** — "we've called the bins in
early for Wednesday": move the open occurrence to Wednesday; when it's ticked,
the following one counts from Wednesday. That is jon's "things to be set".

**Ticking can't run ahead** (29 Sep 2026 — clicking the box walked a weekly
to-do five weeks forward). On a schedule, an occurrence can only be ticked
from the day after the previous one was due; before that its box is greyed
with "opens Wed 30 Sept", and the server refuses the tick. `opens_on` in
`SELECT_TASKS` is the one place this is worked out. Dropping ("skip this one")
is not limited, and "after the last one" repeats never needed it — their next
counts from today.

### 6.4 Accepting a recurring to-do

- Setting a series on **yourself** starts it immediately.
- Setting one on **somebody else** creates it as *proposed*: they get "Sam
  wants to give you a recurring to-do: 'Read the meters', every Thursday — OK?"
  with **Accept** / **Decline (with a reason)**. Declined goes back to Sam with
  the reason.
- A series on a **list** (§7) needs no acceptance — nobody is being committed.

### 6.5 Leavers

A person marked as left on the Staff page with an active series shows on
**Needs attention**: "Will has 2 recurring to-dos — re-assign". Otherwise the
meters stop being read the day someone leaves.

---

## 7. Shared lists

- Named lists — e.g. **Shopping**, **Building**. Any staff member can add a
  list, add items, tick them off.
- A list item has **no owner**. "I'll take it" moves it onto your own list
  (it keeps a note of the list it came from).
- Items can carry a due date and a note; the shopping list mostly won't.
- **A recurring series can live on a list** — Bins and Recycling as named,
  owner-less series on *Building*, each with its own next date that anyone can
  move. Shown with the next date prominent, on Lists and on Everyone.

Who, if anyone, is nudged about an owner-less item is open question 1.

---

## 8. Privacy

"Everyone sees everyone" with one exception: **a to-do can be private** —
visible only to its owner, whoever set it, and admins.

- **Review actions are private by default.** "Book Will's counselling" came out
  of a conversation §5.4 of the staff records spec protects on purpose; putting
  it on a team-wide list would undo that.
- Anything else defaults to **not** private; the owner or setter can tick it.

---

## 9. Links to other records — not in v1

| Link to | Benefit | Risk | Verdict |
|---|---|---|---|
| Job | none | duplicates job remind-mes | **never** |
| Vehicle | "get the dent looked at" | overlaps vehicle issues and servicing | not v1 |
| Person / organisation | context, shows on their page | low — neither has a task system of its own | **later, if wanted** |
| Room / venue | "aircon in Room 1" | little gain over the title | no |

v1 puts context in the title. The data model leaves room: `source_type` /
`source_id` already means "where it came from"; a later `about_type` /
`about_id` would mean "what it's about" — deliberately a different pair.

---

## 10. Data model sketch

Changes to `staff_tasks`:

```
person_id        → NULLABLE (a list item has no owner)
list_id          UUID → staff_task_lists     (NULL unless on a list)
series_id        UUID → staff_task_series    (NULL unless an occurrence)
is_private       BOOLEAN NOT NULL DEFAULT false
follow_up_on     DATE        -- the assigner's clock (§5.2)
follow_up_chased_at TIMESTAMPTZ
declined_reason  TEXT        -- handed back (§5.1)
CHECK (person_id IS NOT NULL OR list_id IS NOT NULL)
```

New:

```
staff_task_lists:  id · name · created_by · archived_at
staff_task_series: id · title · detail · person_id (NULL on a list) · list_id
                   · mode ('schedule' | 'after_done') · rule JSONB · starts_on
                   · ends_on · ends_after · occurrences_made
                   · status ('proposed' | 'active' | 'declined' | 'ended')
                   · decline_reason · is_private · created_by
```

Backfill: existing review actions get `is_private = true`.

---

## 11. Build order

| # | Phase | Delivers on its own |
|---|---|---|
| 1 | **The To Do page** — Mine / Assigned by me / Everyone; anyone assigns to anyone; hand back; the assigner's follow-up; private flag | the whole team's one-off to-dos, visible and followed up |
| 2 | **Recurring** — the rule, both modes, one open occurrence, accept/decline, leavers | meters, bins, recycling |
| 3 | **Lists** — named shared lists, take it on, series on a list | Tesco, Building |
| 4 | **Pull-ins** — my job reminders and my Problems in Mine, read-through | the one-stop glance |
| 5 | **Person / organisation links** — only if still wanted | context on those pages |

---

## 12. Decisions on the open questions (jon, 24 Sep 2026)

1. **Owner-less recurring items (bins):** **watchers** — a list has people who
   get the nudge.
2. **Lists to start with:** Shopping and Building — **plus an easy way to add
   more** (phase 3).
3. **Placement:** the Me page, To Do as the first and default tab (§4).
4. **Pull-ins:** **tick from Mine**, through the job module's own endpoint.

---

## 13. Phase 1 build log — assigning (24 Sep 2026)

Migration `255_staff_tasks_assigning.sql` (written as 253; renumbered on merge — main had taken 253–254 for shop receipts): `follow_up_on` /
`follow_up_chased_at` (the setter's clock), `handed_back_by` / `_reason` /
`_at`, `is_private` (backfilled true for review actions), an index on
`created_by`.

**The permission rule moved, in one place.** `assertCanTouch()` now allows the
owner, **the setter** (`created_by`) and admins, and returns which of the three
the caller is. The owner can't move the setter's follow-up or give the task to
somebody else — the person being chased must not be able to switch off the
chasing — so they **hand it back** instead (`handBackTask()`, owner only, needs
a reason, moves it to the setter's list and bells them).

**Reading is wider than touching.** `listEveryone()` shows every open task to
every staff member except private ones (owner, setter, admins only);
touching any of them still goes through `assertCanTouch()`.

**Follow-up defaults.** A task given to somebody else gets the setter's
follow-up = its due date, or a fortnight out. **Not for review actions** — the
review's check-in already follows those up, and a bell per action would be
noise.

**Bells** (`staff-notifications.ts`): assigned (to the new owner), handed back
and done (to the setter), and `runTaskFollowUpChase()` at 09:45 beside the
owner's chase. All bells; the escalation scheduler emails per preference.

**The picker** (`GET /staff-tasks/people`) offers active non-freelancer logins
with a person behind them, minus the platform's service account — a person
with no login would never see the task or get the bell.

Verified on a real Postgres over HTTP as three users: assign with bell;
private hidden from a colleague, visible to owner and setter; a colleague's
edit refused as "not found"; the owner refused on the follow-up; follow-up
fires once and re-arms on a move; hand back returns it with the reason;
reassign bells the new owner; done bells the setter.

---

## 14. Phase 2 build log — repeating to-dos (25 Sep 2026)

Also in this pass, from jon's phase 1 testing: **dates look forward** — a due
date, reminder or follow-up can't be SET in the past (an untouched stored date
is kept, so editing an overdue task still works; `assertForward` in
`staff-tasks.ts`), with **Today / +7 / +14** shortcuts under every date
(`components/ForwardDateInput.tsx`); and a task you **hand back stays in your
recently finished**, greyed, "handed back to Sam".

**The engine** — `services/task-recurrence.ts`, pure, 20 tests. Every rule in
§6.1 (every N day/week/month/year; weekdays; day N or the Nth/last weekday;
day 31 lands on the month's last day; 29 Feb → 28 Feb), both modes, and the
§6.3 "next after close" rule. Weekdays are 0 = Monday. THE ONE PLACE date
arithmetic for repeats happens: the form asks it through
`POST /staff-tasks/series/preview` rather than computing its own.

**The series** — `staff_task_series` (migration 257 — written as 256, renumbered on merge: main took 256 for the shop week close),
`services/staff-task-series.ts`. Each occurrence is an ordinary task with
`source_type = 'staff_task_series'` — no new column, the existing source hook
— so ticking, nudging, privacy and the Everyone view needed nothing new.

- **One open occurrence.** Ticking or dropping one makes the next
  (`onOccurrenceClosed`, called from `updateTask` / `cancelTask`); the INSERT is
  guarded so a double tick can't make two.
- **Proposed → Accept / Decline** for a series set for somebody else, with a
  reason on decline; bells both ways. The owner can accept, decline or stop,
  but not rewrite what they were asked — only the setter or an admin can.
- **Occurrences can't be handed back or reassigned singly** — stop or reassign
  the series. Reassigning a series drops the open occurrence and proposes it
  to the new owner.
- **No setter follow-up or done bell per occurrence** — a bell every Thursday
  that the meters were read is noise. "Assigned by me" shows last done / next.
- **Leavers** (§6.5): Needs attention lists repeating to-dos still on somebody
  who has left; the Everyone view's Repeating section lets an admin (or the
  setter) change who it's for.
- **Safety net**: 09:45 `ensureSeriesOccurrences()` repairs an active series
  left with no open occurrence, counting on from its LAST occurrence.

**Caught in testing, before shipping:** the safety net first counted from the
series' start date and re-made a date that was already done; and the proposal
bell lower-cased the whole rule ("every week on fri"). Both fixed.

Verified on a real Postgres over HTTP as three users (proposal, accept,
decline-with-reason, one-open-only under a double tick, drop → next, ends
after N, reassign, privacy, leaver prompt, permission refusals, the repair),
and in a real browser (Playwright) through the whole create → propose →
accept → first occurrence flow, with no console errors.

---

## 15. Phases 3–4 build log — lists and pull-ins (28 Sep 2026)

Also in this pass, from jon's phase 2 testing:

- **Date boxes line up.** The form rows align to the top, so every input sits
  in one line under its label and the Today / +7 / +14 shortcuts hang beneath.
- **"Me" means me.** The "For" picker listed "Me" and then your own name —
  two options, one person. `GET /staff-tasks/people` now also returns `me` and
  the picker leaves you out. (The "Me" itself was already right: blank
  resolves server-side to the caller, the same rule the job remind-me uses.)
- **Everything twice.** An occurrence showed as a task AND under "Repeating".
  The repeat's words and its change / stop now sit on the occurrence's own row
  (↻ Every week on Tue); the Repeating section lists only series with nothing
  open right now (waiting to be accepted, or between after-done occurrences).

**Lists (phase 3)** — migration `258_staff_task_lists.sql`:
`staff_task_lists`, `staff_task_list_watchers`, and `list_id` on both
`staff_tasks` and `staff_task_series`, whose `person_id` becomes nullable under
a CHECK that one of the two is set. Shopping and Building are seeded; "+ New
list" adds more (names unique, case-insensitive, among live lists).

- An item has **no owner** until "I'll take it" (`takeTask`, only if still
  untaken — two people can't both take the milk). It moves to the taker's
  Mine marked "from Shopping", and **Put back** returns it (`releaseTask`, the
  taker or an admin). It can't be handed back — nobody set it FOR you.
- **Anyone can tick or drop an untaken item** (`assertCanTouch` answers
  `'list'`). Once taken it follows the normal owner / setter / admin rule. No
  done bell for list items — "Sam bought the milk" isn't news.
- **Repeating to-dos on a list** (the bins): owned by nobody, active at once
  with no accept step, and anyone may change or stop them. Their occurrences
  are list items.
- **Watchers** (§12.1): `runListItemChase` at 09:45 bells every watcher about
  dated items nobody has taken, then re-arms like a normal task chase. The bell
  opens the list (`/me?tab=todo&view=lists&list=…`). Undated items (most
  shopping) never nudge.
- **Archive** refuses while anything untaken or a repeating to-do is still on
  the list — an archived list would hide them from everybody.
- Untaken items stay off Everyone and Assigned by me; taken ones show on
  Everyone under the taker.

**Pull-ins (phase 4)** — `services/staff-task-pullins.ts`, read-through only,
shown in Mine under **From jobs**:

- **Job reminders** that are mine — assigned to me, or created by me with
  nobody assigned (the remind-me form's "Me") — gated like every requirements
  reader: not on a lost / cancelled job unless kept, no `[Suspended:` markers.
  **Ticked from Mine** (§12.4) through the job module's own
  `PATCH /requirements/:id`, so its own side effects still run.
- **Problems** assigned to me that aren't closed, with their status and an
  **Open** link. Not tickable: a Problem has an eight-state workflow (quote,
  action, resolve, write off) that belongs on its own page — and that
  lifecycle is due a rework (jon, 28 Sep 2026), so To Do links rather than
  wiring itself to states that will change.

Verified on a fresh Postgres (all migrations) over HTTP as three users: take /
double-take refused / put back (taker only) / no hand-back; anyone ticks an
untaken item; duplicate list name refused; archive refused with items, allowed
empty; a list series starts active with no owner and stays off Everyone; the
watcher chase bells the watcher only, deep-links to the list, re-arms, and
doesn't repeat; pull-ins hide dead-job, suspended and resolved rows. And in a
real browser: the picker without "me", the form boxes on one line, a reminder
ticked from Mine, take → "from Shopping" → put back, a new list, each
repeating to-do shown once on Everyone — no console errors.

---

## 16. Closing — the §7 gaps, and what is deliberately not built (29 Sep 2026)

Re-reading §7 against what shipped found three gaps; all closed:

- **List items can be edited** — title, note, due date, and the watchers'
  nudge date — by anyone while untaken (the same `'list'` answer from
  `assertCanTouch`). This is how "anyone can move" one bin day: edit that
  occurrence's date; the repeat itself is changed with "change" beside it.
- **List items carry a note** ("the 13A fuses, not the 5A") — on the add
  form and the edit row.
- **Dated list items show on Everyone**, grouped after the people as "On
  Shopping — nobody on it yet". *Dated* only — the bins, not the milk:
  undated shopping would swamp a view grouped by person. This supersedes §15's
  "untaken items stay off Everyone". The list's repeating to-dos still stay
  out of Everyone's Repeating section; their open occurrence is the row.

**Deliberately not built:**

- **Phase 5, person / organisation links** (§9, §11) — nobody has missed it
  yet and the title carries the context. The shape is recorded in
  `docs/reference/BACKLOG.md` for when somebody does.
- **Ticking a Problem from Mine** — Problems link to their own page; their
  lifecycle is being reworked (§15).
- **Links to jobs** — never (§9): job remind-mes already are that.

Verified in a real browser as a user who neither added nor took the items:
an item added with a note, an item renamed and noted, one bin occurrence moved
a week on, Everyone showing the dated items under "On Shopping" and not the
undated ones — no console errors. The watcher bell was verified on a test
database in §15; jon is confirming it on production.
