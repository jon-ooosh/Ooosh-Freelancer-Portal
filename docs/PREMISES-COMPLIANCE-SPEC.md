# Premises & compliance — spec

**Status: ALL PHASES BUILT (1, S, 2, 3a, 3b), 20 Nov 2026 — §12–§16 are what shipped and where it differs
from the plan; read them first.** "Later" in §9 is what's left. Mockups (v1, before the decisions below):
https://claude.ai/artifact/GnedY9eyyMDydPUKMg2tJK — Mockup A's place chips, visibility and "Book the next
visit" are described here, not drawn there yet.

**What it is.** Operations › **Premises & compliance** (`/operations/premises`): everything that keeps the
two buildings, the yard and the company itself legal, insured and serviced — the checks that come round on
a cycle, the certificate from every visit, who looks after each one, the meter readings, and the documents
that go with the premises (lease, plans, insurance schedules). Born from jon, 19 Nov 2026: "store
documents relating to our building / premises … gas meter readings (triggered through a To Do to someone I
assign), elec readings, periodical things like air con servicing, 5-year electrical inspection, annual gas
inspection … importantly … all the relevant documents, ie inspection certificates."

**The analogy.** A building is a van that doesn't move. Van compliance (MOT, tax, service) already does
"a thing that comes round, a date it's due, someone chased, a record of it done" — this is the same idea
pointed at the premises, with the certificate kept against each visit.

---

## §1 Settled decisions (jon, 19 Nov 2026)

1. **Its own section under Operations**, named **"Premises & compliance"**. Not Staff Documents (that is
   for things people must read or sign) and not the staff calendar (that is people's time). It ties into
   both, read-through only (§7).
2. **A check is the unit.** Everything on the register is a check of one of four kinds (§3): a contractor
   **visit**, an in-house **test**, a meter **reading**, or a **renewal** date.
3. **Places.** Every check belongs to one place: **Building 1, Building 2, Yard, Whole site, Company**
   (names editable; Ooosh leases two adjoining buildings and one yard). "Company" holds what isn't about a
   building — employers' and public liability, the ICO fee, music licences. "Whole site" is for what spans
   both buildings (a fire risk assessment, an alarm system covering both).
4. **Headings** group checks on the register (Fire, Gas & electrical, Insurance …). Admins add, rename,
   reorder and retire headings and places from the page's settings — no deploy needed.
5. **Visibility per check: Everyone, Managers, or Admins.** "Everyone" means every staff login
   (`STAFF_ROLES`), never freelancers. Managers = `MANAGER_ROLES`. A check's visit files follow the check;
   a library document has its own setting (§6). **A check you can't see does not exist for you** — not on
   the register, not in search, not as a reminder. So a check's owner must be able to see it (enforced on
   save: an admin-only check can only be owned by an admin).
6. **Reminders are To Do items**, made by this module (`staff_tasks.source_type = 'premises_check'`,
   `source_id` = the check) — the same pattern as social posts (`marketing-content.ts`
   `syncPostReminder()`). **ONE open reminder per check, at most**: a fortnight's holiday never leaves three
   overdue meter readings behind it. Never a `staff_task_series` (§4 says why).
7. **When a check is next due** comes from `services/task-recurrence.ts` — the existing engine, never a
   second one. "Every 12 months from the last visit" is its `after_done` mode; "every Thursday" is its
   `schedule` mode. **A date given on the certificate wins** (an EICR may say "next in 3 years", not 5):
   typed when the visit is recorded and shown as "from the certificate". Never "keep the later date" — the
   same rule as the DVSA MOT date.
8. **Recording a visit can book the next one.** "Book the next visit now" (date + time, who's letting
   them in) — for when the engineer says "same time next year". It puts the visit on the staff calendar and
   turns the reminder from "Book it" into "Northside are coming on 14 Dec — let them in".
9. **Advisories become To Dos when someone asks.** Each advisory on a visit has "Make it a To Do"; a
   **Fail** makes one straight away ("Get it fixed"), to the check's owner. A full repairs log is later
   (§9).
10. **Retire, don't delete.** Retiring takes a check off the register and stops its reminders; its visits
    and certificates stay (the insurer, the end of the lease). A true delete only for a check added by
    mistake with nothing recorded on it. Same for places, headings and folders.
11. **Contractors are organisations in the Address Book**, type **Supplier** (§8 keeps them out of the
    client pickers).
12. **Costs are linked, never retyped.** A visit points at the contractor's bill already in Costs
    (`costs.id`). No amount is stored here.
13. **Files live under a new R2 prefix, `premises/`**, gated in `GET /api/files/download` by the file's own
    row (§6) — never under `files/`, which every staff login can read.
14. **Smart meters later**: when they arrive, the meter's reading check is changed to "every 6 months" as a
    sanity check, or paused. History stays.
15. **Not here:** van insurance, MOT and service (the vehicle module), the staff DVLA/document check
    (`staff-doc-cycles.ts`), policies staff must read (Staff Documents), and breakdowns / repairs (later,
    §9).

---

## §2 The screen

One page, three tabs: **Checks · Meter readings · Documents** (Repairs greyed until §9).

**Places are filter chips, not tabs** (jon asked, 19 Nov 2026): `All · Building 1 · Building 2 · Yard ·
Whole site · Company`, above the register, remembered per person. Tabs are for different *kinds* of thing;
the question asked most is "what's due, anywhere?", which tabs-per-place would split five ways — and a
"Whole site" check would belong to no building's tab. Also on the bar: a heading filter, "Due soon / Overdue
only", and "Mine".

- **Checks** — the register (Mockup A): one row per check, grouped by heading, with place, how often, last
  done, next due, a red / amber / green status pill, who looks after it, and the current certificate. Counts
  at the top (overdue · due soon · up to date). "+ Add a check" and "Record a visit".
- **A check's page** (Mockup B) — about this check (how often, ours or the landlord's, contractor, owner,
  reminder lead, where it physically is, why we do it, visibility), the history of every visit with its
  outcome, certificates and linked bill, and the actions: Record a visit · Book a visit · Retire.
- **Record a visit** — date done, done by (contractor or person), outcome (Pass / Pass with advisories /
  Fail), certificates (drop a PDF or take a photo), next due (pre-filled, editable, "from the certificate"),
  link a bill from Costs (optional, can be done when the bill arrives), notes and advisories, and "Book the
  next visit now". The form changes with the check's kind (§3).
- **Meter readings** (Mockup C) — one card per meter (grouped by place), last reading and use since the one
  before, a weekly-use chart.
- **Documents** — §6.

Status colours: **Overdue** red; **Due soon** amber (inside the check's reminder lead); **OK** green;
**Booked** blue (a visit is booked before the due date); **Landlord's** grey when the check is the
landlord's and we only keep the copy.

---

## §3 The four kinds of check

| Kind | Examples | Recording one | Reminder |
|---|---|---|---|
| **Visit** (a contractor comes) | gas safety, EICR, air con, fire alarm service, extinguishers, LOLER, roller doors | date, done by, outcome, certificate(s), next due, bill, advisories, book next | default 30 days before due: "Book the gas safety inspection" |
| **Test** (we do it ourselves) | weekly fire alarm call-point test, monthly emergency lighting flick test, first aid kits, water temperatures | a quick phone form: OK / not OK, a note; for the alarm, which call point (rotated, shown as "last tested: CP3") | on the day: "Test the fire alarm (call point 4)" |
| **Reading** (a number) | gas, electric, water meters | the reading, a photo of the dial, "meter replaced" tick | on the day: "Read the meters" — one To Do for every reading check due that day owned by the same person, opening one form |
| **Renewal** (a date and a document) | buildings & contents, employers' liability, public liability, lease break / rent review, ICO fee, music licence, EPC | the new date, the policy / schedule / certificate, the bill | default 30 days before: "Renew employers' liability (via the broker)" |

**The fire alarm test is the log book.** The fire officer asks for it; this replaces the paper one. A "not
OK" on any test makes a To Do to the owner straight away.

**Readings are checked as they're typed**, never refused (warnings, not gates): lower than last time
("meter replaced?"), or more than three times the usual week. A "meter replaced" reading starts the meter's
count afresh rather than showing a huge negative week. A day/night meter is two meters.

---

## §4 Why not a repeating To Do

The To Do module already has repeating to-dos (`staff_task_series`) and the TASKS spec even uses "read the
meters" as its example. It isn't enough here because **ticking a To Do records that it was done, not what was
found** — no reading, no certificate, no outcome, no next date from the certificate. So Premises owns the
schedule and the record; the To Do is only the nudge, and its button opens the right form. Ticking the To Do
by hand without recording asks "Did you record it? Record now / It wasn't done".

If anyone has already set up a "read the meters" repeating to-do, it is stopped when the meter checks go live
(Phase 2), by hand, with the owner told.

---

## §5 Data (sketch — settled at build)

Next free migration at build time (354 is the latest on `main` today).

| Table | What | Notes |
|---|---|---|
| `premises_places` | Building 1, Building 2, Yard, Whole site, Company | `name`, `sort`, `retired_at` |
| `premises_headings` | Fire, Gas & electrical … | `name`, `sort`, `retired_at` |
| `premises_checks` | one row per check | `title`, `kind` (`visit`/`test`/`reading`/`renewal`), `heading_id`, `place_id`, `visibility` (`all`/`managers`/`admins`), `owner_person_id`, `contractor_org_id`, `responsibility` (`ours`/`landlord`), `recurrence` JSONB (`RecurrenceRule` + mode; NULL = one-off date), `remind_days_before`, `next_due` DATE, `next_due_source` (`computed`/`certificate`/`typed`), `location_note`, `why_note`, reading-only `unit` + `meter_serial`, test-only `points` (call points to rotate), `retired_at`, `retired_reason` |
| `premises_records` | one row per visit / test / reading / renewal done | `check_id`, `done_on`, `done_by_org_id` / `done_by_person_id`, `outcome` (`pass`/`advisories`/`fail`/NULL), `reading_value` NUMERIC, `meter_replaced`, `point` (which call point), `notes`, `cost_id` (FK `costs`, nullable), `recorded_by`, `created_at` |
| `premises_advisories` | an advisory on a record | `record_id`, `text`, `task_id` (when made a To Do), `done_at` |
| `premises_bookings` | a booked visit | `check_id`, `starts_at` TIMESTAMPTZ, `letting_in_person_id`, `note`, `status` (`booked`/`done`/`cancelled` — soft-cancel) |
| `premises_folders` | the document library's folders | `name`, `visibility`, `sort`, `retired_at` |
| `premises_files` | every file | `r2_key` (`premises/…`), `filename`, `record_id` OR `folder_id` (CHECK: exactly one), `visibility` (NULL = inherit), `uploaded_by`, `archived_at` |

**Who may do what** (proposed — confirm, §10): see a check → its visibility; **record** on a check → anyone
who can see it; **add / edit / retire** a check → managers (admins for an admin-only check); places,
headings and folders → admins.

**The reminder service** (`services/premises-reminders.ts`): `syncCheckReminder(checkId)` keeps the one open
To Do right (made, re-titled, moved to a new owner, or cancelled) — called after every write, plus a daily run
(proposed 09:17, next to the social post reminders). Retired checks and retired places make nothing.

---

## §6 Files and who can open them

- **One prefix, `premises/`, gated per file.** `GET /api/files/download` today gates whole prefixes
  (`staff-records/`, `claims/`, `calls/`); this is the **first prefix gated by the file's own row**: look up
  `premises_files` by `r2_key`, work out its visibility (its own, else its folder's or check's), and refuse
  with 403 unless the caller's role meets it. A key with no row is refused. Kept in the download route so
  `useAuthedFileUrl` / `openAuthedFile` keep working unchanged.
- **Certificates are filed against their visit**, so "the current gas certificate" is one click and last
  year's is never overwritten. They also show in Documents › Certificates, read-through.
- **The library** (Documents tab) is folders for what isn't a check: Lease & legal, Insurance, Risk
  assessments, Plans & drawings (asbestos survey here if the landlord gives us one), Manuals & warranties,
  Utility accounts. Each folder has a visibility; a single document can be set tighter (never looser) than
  its folder. A new upload replaces nothing — older versions stay, newest first.
- **Backups:** the 02:00 backup is the database only; the files have no second copy. Captured in
  `docs/reference/BACKLOG.md` as a platform-wide job (jon: "lets not get distracted here").

---

## §7 How it ties in (read-through only)

- **To Do** — reminders as above; the To Do's button opens the right form ("Enter readings", "Record the
  visit", "Open the check"). Source chip "Premises".
- **Staff calendar** — **booked visits only, never due dates**: "Gas engineer on site 10:00 · Northside ·
  Sam letting in", a new read-through layer on `routes/staff-calendar.ts` `GET /calendar`, the way company
  days are read. Shown to every staff login whatever the check's visibility? **No** — only to those who can
  see the check; others see nothing. Not in anyone's iCal feed (`staff-ical.ts` is own time only).
- **Staff Documents** — linked, never copied. A check can point at a Staff Document ("the fire procedure"),
  and recording a new fire risk assessment offers "Re-issue the fire procedure for everyone to read?" —
  which opens Staff Documents' own New version.
- **Costs** — a record links an existing bill; the check's page totals what it has cost by year.
- **Address Book** — a supplier org's page gets a "Premises" line listing the checks it does (visible ones
  only).
- **Dashboard** — an overdue check shows in the owner's existing attention list, through To Do, nothing new.

---

## §8 Suppliers in the Address Book (the adjunct)

jon, 19 Nov 2026: "we don't necessarily want 'Joe Bloggs plumbing' cluttering up our search when we're
creating a new enquiry > org". **Settled:**

- **No separate suppliers address book** — it would be two lists drifting apart, and some organisations are
  both supplier and client.
- **The client pickers leave out organisations whose type is Supplier**, with a line at the foot of the
  results — "1 supplier matches · show" — so one can still be picked (warnings, not gates). The pickers: New
  Enquiry's client picker (`PipelinePage.tsx`, via `GET /search`), a job's client, and a job's linked
  organisations; the build lists every client-picking surface first and confirms with jon.
- **People are never hidden** (jon: "if we're searching by name rather than org then we're probably after
  that org"). Joe Bloggs himself still appears.
- **The top-bar search and the Organisations page still find suppliers.** The Organisations page gets a
  **Suppliers** filter.

**One type per organisation — proposed fix (to confirm, §10).** jon: "a shame we only have one attribute
per Org … Promoter AND Supplier for instance." Making `organisations.type` a list is a big change — it is
read in about 44 places across 20 files, each assuming one value. Smaller and safer: **keep `type` as the
main type and add `organisations.also_types TEXT[]`** from the same `org_type` picklist (`picklist_items`),
shown on the org page as "Also: Supplier". Then:
- the Suppliers filter = main type Supplier **or** Supplier in "also";
- the client pickers hide an org only when its main type is Supplier **and** "also" holds nothing else — a
  promoter who also supplies us stays findable as a client.
Free-text tags were considered and rejected: "supplier", "Supplier" and "suppliers" would drift.

---

## §9 Phases

| # | What | Notes |
|---|---|---|
| **S** | Suppliers out of the client pickers + Organisations "Suppliers" filter (+ `also_types` if agreed) | Independent of the rest; small; can go first |
| **1** | Places, headings, checks (visit + renewal), the register, the check page, Record a visit, certificates on `premises/` with the per-file gate, visibility, reminders through To Do, retire. **Seed the starting list (§11) once jon has ticked which apply and who owns each** | The core |
| **2** | Tests (fire alarm log book with call-point rotation, emergency lighting) and meter readings (phone form, photo, sanity flags, chart); stop any "read the meters" repeating to-do | |
| **3** | Documents library (folders, versions), Book a visit → staff calendar layer, advisories → To Do, Costs links and the cost-by-year total, the supplier org's "Premises" line, the Staff Documents nudge after a fire risk assessment | |
| Later | Repairs log (reactive faults: "roller door's jammed"); readings against utility bills (catching estimated bills); smart-meter import; the R2 file backup (BACKLOG) | jon: core first |

---

## §10 Answers (jon, 19 Nov 2026)

1. **`also_types`** (§8) — yes. Phase S.
2. **Who may add / edit / retire checks** — managers (admins for admin-only ones); recording by anyone who can
   see the check. As proposed.
3. **The starting list** (§11) — "start with your list, I'll amend once it's live", less the legionella risk
   assessment and the LOLER forklift exam, with the weekly fire alarm test, and the music licence as "PRS & PPL
   licence". The seeded checks have **no owner and no date**: nothing reminds anyone until each is set up.
4. **Reminder lead** — 30 days, changeable per check once live.
5. **Places** — Compass House, Rear Unit, Beach Yard (plus "Whole site" and "Company" from §1.3).
6. **Repeats** — like van prep's periodic checks: every N days / weeks / months / years, OR on a fixed date
   ("annually on 1 Jan"). Both are To Do's existing repeat modes (§12).
7. **Sorting** — each heading's rows sort by the column clicked (name, last done, next due, status).
8. **The To Do as a link** — the "Premises" chip on the To Do opens the check, the same way a van sale's or a
   social post's does (`source_link` in `staff-tasks.ts`). Not a new kind of To Do.

---

## §11 Starting list (jon: "happy to take that starting list")

A prompt, not compliance advice: the lease decides which are ours, and the insurer's policy wording often sets
the frequency. Each seeds as a check with the place, heading, kind and interval below; jon can retire any.

| Heading | Check | Kind | How often | Place (guess) |
|---|---|---|---|---|
| Fire | Fire risk assessment (written, reviewed) | visit | 12 months, or on change | Whole site |
| Fire | Fire alarm service | visit | 6 months | Whole site |
| Fire | Fire alarm test | test | weekly | Whole site |
| Fire | Emergency lighting flick test | test | monthly | per building |
| Fire | Emergency lighting full-duration test | visit | 12 months | per building |
| Fire | Extinguisher service | visit | 12 months | Whole site |
| Gas & electrical | Gas safety inspection / boiler service | visit | 12 months | per building with gas |
| Gas & electrical | EICR (fixed wiring) | visit | set by the certificate, ≤ 5 years | per building |
| Gas & electrical | PAT (office and studio kit — not hire stock) | visit | 12 months (risk-based) | Whole site |
| Air & water | Air con service and F-gas leak check | visit | 12 months (depends on system size) | per building |
| Air & water | Air con energy inspection (TM44, over 12 kW) | visit | 5 years | Whole site |
| Building & equipment | Asbestos register (pre-2000 building) | renewal | review yearly — often the landlord's | Whole site |
| Building & equipment | Pallet racking inspection | visit | 12 months | per building |
| Building & equipment | Roller shutter / powered doors | visit | 6–12 months | per building |
| Building & equipment | Intruder alarm and CCTV | visit | 12 months | Whole site |
| Building & equipment | First aid kits | test | monthly | per building |
| Insurance | Buildings and contents insurance | renewal | yearly | Company |
| Insurance | Employers' liability insurance (certificate kept available) | renewal | yearly | Company |
| Insurance | Public liability insurance | renewal | yearly | Company |
| Lease & legal | Lease breaks and rent reviews | renewal | one-off dates | per building / Yard |
| Lease & legal | EPC | renewal | 10 years | per building |
| Licences & registrations | ICO data protection fee | renewal | yearly | Company |
| Licences & registrations | PRS & PPL licence | renewal | yearly | Company |
| Licences & registrations | Waste transfer notes (keep 2 years) | renewal | yearly | Whole site |
| Meters | Gas, electric, water readings | reading | weekly | per building — seeded in phase 2 |

---

## §12 Phase 1 — what shipped (PR 1, 19 Nov 2026)

**Where:** Operations › Premises & compliance (`/operations/premises`, a check at
`/operations/premises/checks/:id`). Migration **355** (`premises_places`, `premises_headings`, `premises_checks`,
`premises_records`, `premises_files` + the seed). Backend `services/premises.ts` (all the logic),
`services/premises-rules.ts` (pure: who sees what, status, next due, the To Do's words — tested in
`__tests__/premises-rules.test.ts`), `routes/premises.ts` (`/api/premises`). Frontend `pages/PremisesPage.tsx`,
`pages/PremisesCheckPage.tsx`, `components/premises/` (`CheckFormModal`, `RecordModal`, `PlacesHeadingsModal`,
`premisesCopy.ts`).

**Built:**
- The register: place chips, heading groups, sort by the column clicked within each heading (name / last done /
  next due / status — the place and the sort remembered per browser), search, "Overdue or due soon", "Mine",
  "Show retired" (managers), counts, the current certificate opens from the row.
- A check's page: about, history (each record's outcome, notes, files, the next due date it set), Record,
  Change, Retire / Bring it back, Delete (only with nothing recorded), "+ Add a file" on any record, remove a
  record (manager; the due date is left alone) or a file (manager or whoever added it).
- Three kinds: **visit**, **test**, **renewal**. Reading is in the table's CHECK but not offered (phase 2).
- **Repeats are the To Do engine's own** (`task-recurrence.ts`), on the form through the shared
  `RecurrenceFields` (now with `showEnds={false}`): "After the last one is done" (every N days / weeks / months /
  years from the day it was done) or "On a schedule" (every year on 1 Jan, every Thursday …), counting from the
  check's next due date. **Done early for a fixed date counts as that one:** a 1 Jan check done on 19 Nov is next
  due the 1 Jan after (`nextAfterClose`, the rule repeating to-dos already keep).
- **A date from the certificate wins** (`next_due_source = 'certificate'`); a record older than the latest one
  goes into the history without moving the date.
- **Reminders** (`syncCheckReminder()`, after every write + daily **09:17**): ONE open To Do per check
  (`source_type = 'premises_check'`) to its owner once inside the lead — "Book: …", "Renew: …", "Get the
  landlord's copy: …", or the test's own name, each with its due date. Recording it ticks that To Do done. A To
  Do ticked by hand without recording isn't made again for the same due date (`reminded_for_due`). A **Fail**
  makes "Get it fixed: …" (`source_type = 'premises_fix'`, a week out) for the owner, else whoever recorded it.
  Both link back to the check from To Do's "Premises" chip.
- **Visibility** everyone / managers / admins, enforced on every read (a hidden check is a 404); nobody sets a
  level they can't see; an owner must be able to see their check. Files under `premises/<check>/<record>/`, gated
  per file in `GET /api/files/download` by `canOpenPremisesFile()` — the first prefix gated by a row.
- Places and headings: admins rename, reorder, add, retire (refused while a live check is under it).

**Where it differs from the plan:** owners are optional (no owner = no reminders, shown amber); the seed puts
building checks on "Whole site" (move each as it is set up); "Who did it" is an organisation for visits only —
tests and renewals carry who recorded them.

**Not built yet:** Phase S (suppliers out of the client pickers, `also_types`), phase 2 (meter readings, the
fire-alarm call-point rotation), phase 3 (documents library, booking a visit onto the staff calendar,
advisories → To Do, Costs links). The R2 file backup is in `BACKLOG.md`.

---

## §13 Phase S — what shipped (PR 2, 19 Nov 2026)

**Suppliers out of the client pickers, and "Also" types.** Migration **356**: `organisations.also_types TEXT[]`
(default empty). The two definitions live in `services/org-types.ts`: `orgHasTypeSql()` (main type OR an "Also"
type) and `pureSupplierSql()` (main type Supplier and nothing else in "Also"); `cleanAlsoTypes()` tidies what a
form sends (lower case, no duplicates, never the main type — changing the main type drops it from the list).

- **Organisation form:** an "Also" row of type chips under Type; the org page header shows "also supplier" etc.
- **Hidden from (pure suppliers only):** New Enquiry's client picker (`GET /search?purpose=client`) and a job's
  client picker on Job Detail (`GET /organisations?client_picker=1`). Both answer the hidden ones separately as
  `hidden_suppliers`; the picker shows "N suppliers match · show". A hidden supplier with the exact name typed
  still stops "Create … as new client" (it would make a duplicate) and is never auto-linked.
- **Still found everywhere else:** the top-bar search, the Organisations page, and the **linked organisations**
  pickers on New Enquiry and Job Detail — "Supplier" is one of the roles there, so hiding suppliers would be wrong.
  People are never hidden.
- **Organisations page type filter** matches main OR "Also", so "Supplier" finds a promoter that also supplies us.

**Where it differs from §8:** the linked-organisations pickers were in the original list and are left alone
(above).

---

## §14 Phase 2 — what shipped (PR 3, 19 Nov 2026)

**Meter readings, the call-point rotation, and past records** (jon: "backfill historical certs … without firing off
loads of erroneous dues"). Migration **357**: `premises_checks.unit`, `meter_serial`, `points`; `premises_records.point`,
`backfilled`; a "Meters" heading with Gas, Electricity and Water meters (no owner, no date). The rules are pure in
`premises-rules.ts` and tested: `usageSeries()`, `assessReading()`, `nextPoint()`, `cleanPoints()`.

- **Meter readings** (kind `reading`, now offered on the check form with a unit and serial). A reading record needs the
  number; "meter replaced" starts the count again. **Every reading is checked against the meter's history as it is
  typed** (`GET /premises/checks/:id/reading-check`): lower than the last reading, or more than three times the usual
  week (the median of the last 8 gaps, per week), is a WARNING — nothing is refused. The check page shows each
  reading with "+N since …" and a use-per-week chart (`components/premises/UsageChart.tsx`).
- **Operations › Premises & compliance › Meter readings** (`?tab=meters`, `GET /premises/meters`): a card per meter —
  last reading, use since the one before, the usual week, the chart — and **Enter readings**
  (`/operations/premises/readings`), the phone screen: one box per meter, a photo of the dial, one Save for all. **A
  meter's To Do opens that screen** (`source_link` in `staff-tasks.ts`); each meter keeps its own To Do, ticked when
  its reading is saved.
- **Call points** (kind `test`): the check lists them in order; the record form offers the next one along
  ("(next in turn)", changeable); the owner's To Do names it ("Fire alarm test: CP2 Warehouse (due …)"); the check page
  shows "Next in turn". Last tested point off the list → back to the first.
- **Add past records** (every check, `POST /premises/checks/:id/history`): several at once, in any order, an outcome
  optional, a file per record. **One transaction; the due date moves once, from the newest, and only if it is newer than
  anything already recorded; an old "Fail" never makes a "Get it fixed" To Do; marked "filed later"** in the history.
  Recording and past records share one writer (`saveRecords()` in `premises.ts`).

**Where it differs from §3:** "Read the meters" is one To Do per meter, not one per person per day — the reading screen
gathers them all, so one visit to it ticks them all.

**Not built yet (phase 3):** the documents library, "Book a visit" onto the staff calendar, advisories → To Do, Costs
links. Readings against the supplier's bills and a smart-meter import are later still.

---

## §15 Phase 3a — what shipped (20 Nov 2026)

Phase 3 was split in two (the calendar sits in the staff calendar, the most rule-heavy module, so it goes on its
own). **3a: the documents library, advisories as To Dos, and the bill in Costs.** Migration **360**.

- **The documents library** (Premises & compliance › **Documents**, `GET /premises/library`,
  `services/premises-library.ts`). Folders (`premises_folders`, seeded: Lease & legal and Insurance admins-only,
  Utility accounts managers-only, Risk assessments / Plans & drawings / Manuals & warranties everyone) hold
  documents (`premises_documents`); **a document's files are its versions** — newest is current, "N earlier
  versions" lists the rest, nothing is replaced. **A document may be tighter than its folder, never looser**; what
  it comes to is `effectiveVisibility()` in `premises-rules.ts` (the tighter of the two) — one rule for the list and
  the file gate. Tightening a folder hides its looser documents; a tighter document stays tighter. Adding, changing,
  archiving and new versions are manager-tier; folders (name, who can see it, order, retire — refused while
  documents are in it) are admin. **"Certificates"** at the top is read-through: each check's current certificate.
- **One file table, two owners.** `premises_files` belongs to a record OR a document (CHECK); library files live under
  `premises/library/<document>/`. `canOpenPremisesFile()` (the download gate) and `archiveFile()` handle both.
- **Advisories** (`premises_advisories`): the visit form has an "Advisories — one per line" box; each becomes its own
  line on the record with a tick and **"Make it a To Do"** (`source_type = 'premises_advisory'`, for the check's
  owner — else whoever pressed it — set by whoever pressed it, due in 30 days; the "Premises" chip opens the check).
  Ticking it off closes its open To Do; an advisory whose To Do was done counts as done. "+ Add an advisory" adds
  one to a past record.
- **The bill in Costs** (`premises_records.cost_id`, **`ON DELETE SET NULL`** — a cost is hard-deleted from Money ›
  Costs, and must never fail because a certificate pointed at it). "Link the bill from Costs" offers the
  contractor's recent bills, or searches supplier / description / invoice number / amount
  (`GET /premises/checks/:id/linkable-costs`); read-only over Costs. The check's page shows **"What it's cost"** by
  year (ex VAT, from the linked bills).

(3b — the calendar, the supplier line and the Staff Document link — is §16.)

---

## §16 Phase 3b — what shipped (20 Nov 2026)

Migration **361**. **Booked visits, the staff calendar row, the contractor's line, the Staff Document link.**

- **Booking a visit** (`premises_bookings`; "Book a visit" / "Change the booking" on a contractor-visit check —
  anyone who can see the check). Date (today or later), a quarter-hour time or "No set time", who's letting them
  in, a note. **One live booking per check** (unique index on `status = 'booked'`); booking again changes it.
  The person letting them in must be able to see the check (their To Do links to it); left blank, it's whoever
  looks after the check. The pill reads **"Booked Mon 23 Nov"**; the About card shows the booking with "Cancel the
  booking" (soft — `status = 'cancelled'`, never deleted).
- **The reminder follows the booking.** While a check has a live booking, its ONE To Do (`source_type =
  'premises_check'`, unchanged) becomes **"Northside coming 23 Nov 2026 at 10:30 — let them in (Boiler service)"**,
  for the person letting them in, due on the day (`bookingTitle()` in `premises-rules.ts`). Changing the booking
  re-titles and re-dates the same To Do; cancelling goes back to "Book: …". **A To Do ticked by hand isn't made again
  for the same thing**: `premises_checks.reminded_key` (`booking:<id>:<date>` or `due:<date>`) replaced
  `reminded_for_due` as the memory (the old column is still written and still honoured for rows from before).
  The daily 09:17 run includes every check with a live booking.
- **Recording the visit marks the booking done** and closes the To Do, as before. **"Add past records" never
  touches a live booking** — an old certificate filed today isn't the visit that's booked.
- **Staff calendar: "Contractors on site"** — one row under the freelancers, from its own call
  (`GET /premises/visits?from=&to=`, filtered by who can see each check), so the calendar keeps working if it
  fails. A chip per visit (its time, or "Visit"; hover for contractor, check, place, who's letting them in, the
  note); a done visit stays on its day, grey with a ✓. **Never counted in "In"** — not people we roster. Click →
  the check. Nothing else in the calendar changed (additive only, per `staff-calendar.md`).
- **The contractor's organisation page** gets one line under its name — "Premises checks they do: Boiler service ·
  Gas safety" — the checks it's the contractor on or has done a record for, that you can see
  (`GET /premises/by-organisation/:id`). Nothing shows when there are none.
- **The Staff Document link** (`premises_checks.staff_document_id`, "Staff document it feeds" on the check form —
  manager-tier, as the form is). The check page shows the link; after a visit is recorded on a linked check, a banner
  says "issue a new version if what was done changes it" with a link to Staff Documents. **A nudge only** — nothing
  is changed on the Staff Document, no new version is made, no one is asked to re-read.

**Not built (deliberately):** a booking for anything but a contractor visit; a booking that runs over several days;
contractor visits counting as cover; emailing the contractor.
