# Staff Records — private files, key data, document review cycles, and staff reviews

**Status: BUILT — all seven phases shipped Sep 2026. §20 is the current state;
§21 is the follow-up audit and what is agreed next.** The sections below are
kept as the design record. Written 21 Sep 2026 at the end of the
staff-calendar session, from jon's §17 answers. **Revised 21 Sep 2026** after a
verification pass against the code — the first draft's §1 was right in spirit
but wrong on three facts, and the review process has since been designed with
jon rather than left as an open question. §11 records what changed and why.

---

## 0. The ask, in jon's words

> "Within each drop-down staff member I add, there should be a files section,
> labellable, admin-view-only, along with inputs for other key data I'd like to
> store, including their employment contract."

> "I'd rather have a private staff area where I can upload docs I need to keep —
> passports, driving licence, check codes, any medical docs."

> "Periodic staff reviews… reminders about them, along with being able to alert
> staff 'review needs to be scheduled for X date', with us then having a little
> flexibility to confirm a mutually-good date."

> "Doc reviews generally actually — we want a new DVLA check code every year,
> review dates on the other documents, and a system around that."

**Where the data is today: nowhere.** It lived on the Monday.com board, which
expired around June 2026. jon holds a zipped folder ready to re-populate by
hand — files and documents, not much of it. **There is no import to build.**
Get the surfaces right and jon fills them in. That is the whole migration plan,
and it is why this module can be judged purely on whether the surfaces are
useable.

---

## 1. READ THIS BEFORE DESIGNING ANYTHING — verified against the code

Three things already exist that this module must not rebuild, and one claim in
the first draft of this spec was wrong in a way that would have cost a week.

### 1.1 Licence, DVLA check code and passport exist — in TWO places already

`drivers` has `person_id`. A staff member who drives is a `drivers` row linked
to their `people` row. That table holds:

```
licence_number · licence_type · licence_valid_from · licence_valid_to
licence_points · licence_endorsements · licence_restrictions
dvla_check_code · dvla_check_code_encrypted · dvla_check_date · dvla_valid_until
licence_next_check_due · licence_address_encrypted
passport_check_date · passport_expiry · passport_valid_until
```

**But there is a second copy.** Migration `184_freelancer_onboarding.sql:60-66`
added `licence_number`, `licence_issued_by`, `licence_expiry`,
`licence_passed_date`, `dvla_check_date`, `passport_expiry` and `pli_expiry`
to **`people`**, for the freelancer onboarding flow. So licence data lives on
`drivers` AND on `people` today, and nothing keeps them in step.

This module must not make it three. **Decision: this module owns NO licence,
DVLA or passport columns.** It reads. Where it needs a date, it reads the
existing FROM date and derives what it needs (§4).

Reconciling the existing two is real work, but it is NOT this module's work and
must not be smuggled into it. Captured in `BACKLOG.md`.

### 1.2 `licence_next_check_due` is NOT the annual DVLA check

The first draft claimed "a new DVLA check code every year is largely already
built, because `licence_next_check_due` exists". **That is wrong on both
halves, and it matters.**

- `licence_next_check_due` is a **legacy Monday-migration column**.
  `services/driver-validity.ts:264` treats it as a fallback holding an
  already-computed expiry — "Legacy fallback". It is not a live mechanism and
  nothing maintains it.
- The driver DVLA window is **30 days**, not twelve months —
  `VALIDITY_WINDOW_DAYS.dvla = 30` at `driver-validity.ts:59`.

Those are two different questions that happen to share one stored date:

| Question | Who asks | Window | Where it lives |
|---|---|---|---|
| Is this driver insurable for THIS hire, today? | assign picker, hire form, dispatch gate | 30 days | `driver-validity.ts` — leave alone |
| Have we, as the employer, checked our employee's licence in the last 12 months? | this module | 12 months | derived here |

**So do not "generalise" `driver-validity.ts` to serve both.** That file exists
to stop four rules answering one question; making one module answer two
questions is the same bug wearing a different hat. Read
`drivers.dvla_check_date` as the single source of truth for *when the check was
run*, and derive the annual employer-check due date in this module. One stored
date, two explicitly separate derived windows.

### 1.3 `driver-validity.ts` is still the model for every expiry

Its rule, learned the hard way: **humans record a FROM date only** — the day the
document was issued or the check was run, which is the easiest thing to read off
a document — and the system **derives** the expiry from a per-type rule. Never
ask a human for "valid until".

Read the file header before writing any expiry logic. It documents six consumers
with four different rules and a real incident (job 16291, 19 Aug 2026) where a
driver had green pills on his own page and a hard 400 out of the assign picker.
Follow its *shape*. Do not extend its *scope* (§1.2).

### 1.4 `staff_documents` is NOT this

`staff_documents` / `staff_document_assignments` is **documents we publish TO
staff** — handbook, policies, training, with tick/sign completion tracking and
a target-set resolver. See `docs/STAFF-DOCUMENTS-SPEC.md`.

This module is **documents we hold ABOUT staff**. Opposite direction, opposite
access rules. Reusing that table would conflate "everyone must read this" with
"nobody may see this", which is a permissions accident waiting to happen.

Hence `staff_records` / `staff_record_files`, so nobody confuses them by name.

**But `services/staff-document-reminders.ts` IS the model for §4.** It already
implements lapse → renew → chase → escalate against review intervals, with
dedup stamps, writing bell notifications that the escalation scheduler emails
per the recipient's preferences. Copy that shape rather than inventing one.

Note the 08:00 compliance scanner is **vehicle** compliance
(`services/compliance-checker.ts`) — not reusable here, despite the name.

### 1.5 Other things to reuse, not rebuild

| Need | Use |
|---|---|
| The admin gate | `STAFF_ADMIN_ROLES` at `services/staff-employment.ts:28` (= `['admin']`), applied as `adminOnly` at `routes/staff-calendar.ts:75`. The chokepoint already exists — do NOT write a new `authorize('admin')` |
| Encrypting an identifier | `services/encryption.ts` — `encrypt` / `tryDecrypt`, and the `*_encrypted` column convention |
| Private file storage | Cloudflare R2 private bucket `ooosh-operations`, as `costs.receipt_r2_key` already does |
| Showing a private file in the DOM | `frontend/src/hooks/useAuthedFileUrl.ts` |
| Opening one in a new tab | `frontend/src/lib/openAuthedFile.ts` |
| A once-only reminder | the `rtw_chased_at` stamp pattern — migration `214_staff_absence.sql:85`, `services/staff-notifications.ts:269` |
| A per-person override with a global fallback | `staff_employment.bank_holiday_policy` / `entitlement_weeks` — nullable column, falls back to `system_settings` |

---

## 2. Access model

jon said **admin-view-only**, and the constant for it already exists.

- **Use `STAFF_ADMIN_ROLES`** (`= ['admin']`) for everything in this module. Not
  `MANAGER_ROLES`. This is passports, medical notes and NI numbers for seven
  people; the blast radius of getting it wrong is worse than the inconvenience
  of a narrow gate.
- **Precedent:** absence already does this — its own page, admin-only, because
  it is special-category data (§0.5 of the staff calendar spec). Salary history
  and reviews are already behind the same gate.
- **Because it is one constant, "should a staff member see their own records?"
  stays cheap to revisit.** Answer for v1: **no**, except the two things §5
  deliberately shares with them (their own review summary and their own tasks).

**Never put any of this on the People record.** `people` is staff-wide readable
and holds clients, contacts and bands as well as employees.

---

## 3. Piece one — private files and key data

### 3.1 Files

A labelled file list per staff member. Admin only.

- `staff_record_files`: `id · person_id · label · doc_type · r2_key ·
  filename · content_type · size · uploaded_by · uploaded_at · notes ·
  deleted_at`
- **Labellable** — jon's word. Free-text label ("Passport 2024", "Contract
  signed Mar 2025") ALONGSIDE a `doc_type` enum that drives the review cycle.
  The label is for humans; the type is for the system. Do not make the type
  free text or §4 cannot work.
- Soft-delete, not delete (CLAUDE.md's data-handling rule).

Nothing generic exists to reuse here, and this was checked: `people.files`
JSONB exists but `people` is staff-wide readable (§2), and `file_links`
(migration 202) models org↔job "windows onto the same file", which is the wrong
shape for a file only one role may ever see.

### 3.2 Key data fields

On `staff_employment` (it describes the employment):

- **NI number** — encrypted via `services/encryption.ts`, as
  `ni_number_encrypted`. jon: "needed for payroll but also just my reference as
  an employer."
- **Right-to-work evidence** — what was seen, when, by whom. §17 item 7. This is
  a legal record; the *check* matters as much as the document, so it is columns
  (`rtw_document_type`, `rtw_checked_on`, `rtw_checked_by`) with the document
  itself filed in §3.1 under `doc_type = 'right_to_work'`.
- **Employment contract** — a file in §3.1, plus signed date and version.
- **Emergency contact** — already on `people`; do not duplicate, surface it.
- **Medical notes** — free text, admin only. **DEFERRED to Phase 7** — see §8.

### 3.3 Where it appears

jon: "within each drop-down staff member I add". That is the expandable
`PersonCard` on `StaffAdminPage.tsx`. A new admin-gated section there, alongside
the existing employment and pattern panels.

---

## 4. Piece two — document review cycles

The general system behind "a new DVLA check code every year".

- `doc_type` carries a **review rule**: an interval (DVLA: 12 months), or an
  expiry read off the document (passport), or none (contract).
- Store the **FROM date**; derive the due date. §1.3.
- For licence/DVLA/passport the FROM date is **read from `drivers`, never
  copied** (§1.1). This module derives its own twelve-month employer-check
  window from `drivers.dvla_check_date` and does not touch the 30-day hire
  window (§1.2).
- Rules belong in `system_settings` so the interval changes without a deploy.
- A daily scheduled scan raises a bell at a lead time, **once**, stamped.
  Slot it in the 09:00–10:00 block; the list is in CLAUDE.md. Model it on
  `staff-document-reminders.ts` (§1.4).
- A staff-wide "what is expiring" view — this is the bit that replaces jon's
  memory, and it should cover everyone rather than being per-person only.

---

## 5. Piece three — staff reviews

**Designed with jon, 21 Sep 2026.** This section is no longer open questions.

### 5.1 The principle that shapes it: pay is decided AFTER, not in the room

jon: "Reviews usually have a salary hike too."

If the person knows their pay is being decided in that hour, they spend the hour
managing the pay outcome. Every honest answer to "what isn't going well" becomes
a thing that might cost them money — so the development conversation does not
happen, and the pay decision gets made on worse information than before the
meeting.

Full decoupling (development on the anniversary, pay on a company calendar) is
overkill for seven people and would read as evasive. **The minimal version:
decide pay after the meeting, and communicate it in the follow-up** — which is
the follow-up jon already wanted. Say so out loud at the top of the review:
"pay is reviewed off the back of this, you'll hear within a fortnight."

This is why §5.5's follow-up carries the salary change, and why `staff_reviews`
links to the `staff_salary_history` row it produced rather than holding a figure.

### 5.2 Scheduling — deliberately thin

jon's original ask was a propose/counter exchange. **Agreed down to a
confirmation instead:** seven people, once a year, is a conversation, not a
booking system. The date gets agreed in person or by email; the system records
the confirmed date and sends the confirmation.

The value was never the scheduling. It is that the confirmation **carries the
prep questions** and leaves a record that the review was offered on a date.
Build that; build nothing more.

### 5.3 Prep questions — both sides answer, in advance

The single highest-leverage part. The staff member answers before the meeting
and jon reads their answers before walking in. Same questions both sides. It
turns the review from "boss delivers verdict" into "two documents compared".

Questions live in `system_settings` so they change without a deploy. jon's
existing set is 10+ years old and he intends to rewrite the wording separately;
these are the working draft to build the mechanics against:

1. What's gone well since we last talked? Give me a specific example or two.
2. What hasn't gone the way you wanted — and what would have helped?
3. Which parts of the job do you most want *more* of?
4. What do you want to be doing in a year that you're not doing now? What would
   get you there?
5. What should Ooosh do differently? What gets in your way?
6. Anything we haven't covered, or anything you've been sitting on?

Six is about the ceiling before people start writing "n/a". **Q2 and Q6 only
get honest answers if §5.1 holds** — the design is one argument, not two.

### 5.4 Notes: two fields, not one

- **Shared summary** — the agreed write-up, the actions, the outcome. The staff
  member sees this; it is what the follow-up email contains anyway.
- **Private notes** — admin only. jon's observations, concerns not yet raised,
  pay reasoning.

**Two columns from the first migration, not one column with a visibility flag.**
A notes field that is *sometimes* shared is a leak waiting to happen, and
knowing it might be read, jon would self-censor and record nothing worth having.
This is the decision that could not be retrofitted, which is why it was settled
before any schema.

### 5.5 Follow-up

An email to the staff member: the shared summary, the agreed actions with their
owners and dates, and — once decided — the salary change. Sent through
`services/email-service.ts`, like everything else.

### 5.6 Cadence — per person, not company-wide

jon: a new starter might want monthly; someone settled, annually.

`staff_employment.review_interval_months` — nullable INT, falling back to a
`system_settings` default. Exactly the shape `bank_holiday_policy` and
`entitlement_weeks` already use (§1.5). The "review due" reminder runs off it.

Plus, effectively free: a lightweight check-in between reviews that is just
"here are last review's actions, where are they?", generated from §6. It is what
stops the annual review being a ritual.

Probation reviews stay separate and shorter — `review_type` already has the
enum value.

---

## 6. Actions — `staff_tasks`, and the My To Do tab

**The highest-value part of the review module, and the reason to build it at
all.** Actions agreed in reviews evaporate — that is the default outcome
everywhere, and it is what makes the next review feel like theatre.

### 6.1 Build it general, wire it to one consumer

jon has a broader want: a home for "non-hire-related things that need doing".
That is its own module and must not be built here. But the table this module
needs is the table that module will need, so **design it general and wire only
the review consumer**:

```
staff_tasks: id · person_id (owner) · title · detail · due_date · status
             source_type · source_id · created_by · completed_at · chased_at
```

`source_type` / `source_id` is the hook. A review action is
`('staff_review', <review id>)`. When the general want arrives it is
`('manual', NULL)` and nothing about this table changes.

**Do not name it `staff_review_actions`.** That name guarantees a second table
later. Verified there is nothing to reuse: `job_issues` is job-anchored
(`job_id UUID NOT NULL`, migration `075_job_issues.sql:32`) and cannot hold a
review action; no generic task table exists anywhere in the schema.

### 6.2 The owner field is the point

Actions cut both ways. "What should Ooosh do differently?" (§5.3 Q5) produces
actions for **jon**, and those are the ones most likely to lapse quietly — and
the most corrosive to trust when they do. Someone asks for training, jon says
yes, nothing happens, and next year they stop telling him anything.

jon is a person with a `people` row, so an action he owes lands on **his own**
My To Do beside everything else. That is the mechanism, not a reporting feature.

### 6.3 Surface

A fourth tab on `MePage.tsx` (`TABS` at line 22 — currently My Time, Documents,
Profile). Tab id in the URL like the others, so a notification can deep-link to
it.

Shared and live between reviews, not revealed once a year in an email — that is
what makes jon's half of the list visible to the person waiting on it.

---

## 7. Retention

Decided (§17 item 9): **sickness records keep one year, then auto-delete.**

The wrinkle that matters: **this cannot be a plain DELETE.** `staff_absences`
drives ledger entries — holiday reclaim, unpaid-leave days on the payroll report
— and those effects must survive. What expires is the MEDICAL DETAIL (type,
notes, return-to-work record), not the fact somebody was off.

Suggested shape: a daily sweep that nulls the special-category columns on spells
whose end date is over a year old and stamps `detail_purged_at`, leaving day
rows and their ledger effects intact. Reporting queries already read days rather
than reasons — verify that before relying on it.

Every doc type in §3 needs its own retention answer. Right-to-work evidence in
particular has a statutory retention period that is **not** one year — check it
rather than assuming.

---

## 8. Build order

| # | Phase | Delivers on its own |
|---|---|---|
| 0 | **This document** | The next session doesn't re-derive any of it |
| 1 | ~~**Files + admin gate**~~ — **SHIPPED Sep 2026.** Migration 231, `routes/staff-records.ts`, `components/StaffRecordFiles.tsx` on the expandable staff row. See §12 | jon starts emptying the zip folder the day it deploys |
| 2 | ~~**Key data**~~ — **SHIPPED Sep 2026.** Migration 232, `updateKeyData()`/`revealNiNumber()`, `components/StaffKeyData.tsx`. Medical notes still held back. See §13 | The rest of the folder |
| 3 | ~~**`staff_tasks` + My To Do tab**~~ — **SHIPPED Sep 2026.** Migration 233, `services/staff-tasks.ts`, `pages/MyTasksPage.tsx`, 09:45 chaser. See §14 | Useful as a general to-do immediately, before reviews exist |
| 4 | ~~**Review record + cycle**~~ — **SHIPPED Sep 2026.** Migration 234, `recordReviewOutcome()`, `components/StaffReviews.tsx`, review-due scan. See §15 | The full loop minus staff-facing bits; actions write `staff_tasks` rows |
| 5 | ~~**Staff-facing exchange**~~ — **SHIPPED Sep 2026.** Migration 237, `services/staff-review-prep.ts`, `staff-review-followup.ts`, `pages/MyReviewPage.tsx`. See §17 | The staff half |
| 6 | ~~**Document review cycles**~~ — **SHIPPED Sep 2026.** Migration 239, `services/staff-doc-cycles.ts`. Deliberately separate from `drivers`. See §19.1 | Replaces jon's memory |
| 7 | ~~**Retention sweeps**~~ — **SHIPPED Sep 2026.** Migration 239, `services/staff-retention.ts`. Medical notes deliberately NOT built — see §19.3 | Closes the GDPR item |

Two notes on the order:

**Phase 3 before Phase 4, deliberately.** Building tasks first means the review
module consumes something that already works, rather than discovering the task
shape is wrong half-way through the review UI.

**Medical notes are held back to Phase 7.** The first draft put them in the key
data fields while also saying retention must land "before go-live on anything
medical" — those cannot both be true. Cleanest resolution: do not build the
field until the sweep that expires it exists. Nothing else in Phase 2 is
affected.

Phases 1–5 are the module jon described. 6 and 7 are real but separable, and 6
wants another look at the `drivers` overlap (§1.1, §1.2) before anything is
written.

---

## 9. Still open

Small, and none of them block Phase 1.

1. Retention period per document type — especially right-to-work's statutory
   one (§7).
2. Does anything here survive somebody leaving, and for how long?
3. The review question wording (§5.3) — jon intends to rework it separately. The
   mechanics do not depend on it, because the questions live in
   `system_settings`.

**Settled, previously open:** staff seeing their own records (no for v1, §2);
licence data surfaced vs owned (neither — read only, no columns here, §1.1);
review notes visibility (two fields, §5.4); cadence (per person, §5.6).

---

## 10. What to read first

- `services/driver-validity.ts` — the header, and §1.2 above before you act on it.
- `services/staff-document-reminders.ts` — the reminder engine to model §4 on.
- `docs/STAFF-DOCUMENTS-SPEC.md` — so you do not confuse the two modules.
- `docs/STAFF-CALENDAR-SPEC.md` §0.5 (special-category data), §17 (jon's answers).
- `.claude/rules/staff-calendar.md` — loads automatically; the chase-stamp rules.
- CLAUDE.md — RBAC, migrations (hardcoded runner list), soft-cancel.

---

## 11. What changed in the 21 Sep revision, and why

A verification pass against the code before any build. Recorded so the same
ground is not re-covered.

1. **§5 was not greenfield.** `staff_reviews` already exists
   (`206_staff_calendar_phase_a.sql:104`) with a partial "due" index;
   `upsertReview` / `listReviews` are live at
   `services/staff-employment.ts:443,476`; admin routes exist at
   `routes/staff-calendar.ts:1371,1380`. Nothing in the frontend calls any of
   it — `StaffAdminPage.tsx:16` says "(later) salary, reviews and absence".
   Same for `staff_salary_history` (`206:90`, service at `:432`). Phase 4 is
   wiring and extending, not designing.
2. **The DVLA claim was wrong.** See §1.2. Both halves — the column is legacy,
   and the window is 30 days, not a year.
3. **A second copy of licence data already exists** on `people`
   (`184_freelancer_onboarding.sql:60-66`). The first draft framed §1.1 as a
   two-way choice; it is a three-way problem, already diverging. Resolved by
   this module owning nothing (§1.1).
4. **The admin gate already exists** as `STAFF_ADMIN_ROLES`
   (`staff-employment.ts:28`). The first draft proposed writing one.
5. **The data question dissolved.** Monday.com expired ~June 2026; the data is
   in a zip folder on jon's machine. No import, no reconciliation — just
   surfaces worth typing into.
6. **The review process was designed** (§5) rather than left as "a conversation
   to have": pay decided after the room, prep questions both sides, two notes
   fields, per-person cadence, scheduling trimmed to a confirmation.
7. **Actions became `staff_tasks`** (§6), general by design and wired to one
   consumer, with a My To Do tab — replacing the first draft's silence on where
   review actions would live.

---

## 12. Phase 1 build log — files (Sep 2026)

Shipped. What landed, and the two decisions taken during the build.

**Schema** — migration `231_staff_record_files.sql`. `person_id · label ·
doc_type · r2_key · filename · content_type · size_bytes · notes ·
uploaded_by · uploaded_at · deleted_at · deleted_by`, with a partial index per
person and one on `doc_type` for §4. Soft-delete on the ROW; the R2 object is
deleted for real, because keeping a passport scan nobody can see is the worst
of both worlds.

**API** — `routes/staff-records.ts`, mounted at `/api/staff-records`. List,
upload, relabel/retype, delete. Every route behind `STAFF_ADMIN_ROLES` (§2), not
a fresh `authorize('admin')`.

**UI** — `components/StaffRecordFiles.tsx`, on the expandable `PersonCard` in
`StaffAdminPage`. Deliberately NOT gated on `row.employment`: a contract or a
right-to-work check exists before the employment record does, and that is
exactly when it needs filing.

### 12.1 The security finding that shaped the storage

`GET /api/files/download` authorises by **PREFIX ONLY**. The router calls
`authenticate()` but never `authorize()`, so any caller with a valid JWT — a
freelancer included — can fetch any key under `files/`, `avatars/`,
`completion/` and the rest, given the key. That is fine for job files and
completion photos. It is not fine for a passport.

So staff record objects go under their own prefix, `staff-records/`, which is
**not** in `allowedPrefixes`. The download route carries a matching admin check
for that prefix specifically. The gate lives there rather than on a second
download route so `useAuthedFileUrl` and `openAuthedFile` — THE two ways to read
a private-bucket file per CLAUDE.md — keep working unchanged.

`STAFF_RECORDS_PREFIX` and `STAFF_RECORD_ROLES` are exported from
`routes/staff-records.ts` and imported by `routes/files.ts` so the prefix and
its gate cannot drift apart.

**Never file anything private under `files/`.** An unguessable key is not an
access control — the key is handed to whoever can list it.

### 12.2 `medical` is in the doc_type enum — and its retention is not built

§8 holds the free-text medical NOTES field back to Phase 7, because retention
must exist before special-category data does. The `medical` **document type**
ships now anyway: jon's original ask named "any medical docs", a filed document
is deliberate, labelled and deletable by hand in a way an auto-generated absence
row is not, and refusing to store a document he asked to store is narrowing the
job rather than doing it.

That is a judgement call, not an oversight, and it leaves a real gap: a medical
document filed today has no automatic expiry. Phase 7 owes it one. The column
comment in migration 231 says so.

### 12.3 Bundled with this phase

Two Me-page tidy-ups jon asked for alongside it, both small:

- **"I prefer to be known as" moved onto Me › Profile.** It was admin-only AND
  gated behind `row.employment`, so nobody could set their own and anyone
  without an employment record couldn't have one set at all. `PUT
  /api/auth/profile` now takes `preferred_name`; `''` clears it (`!== undefined`
  rather than a truthy test, or clearing would silently no-op). The admin field
  stays for people with no login, now labelled as such.
- **COT card last 4 removed from Me › Profile.** It was in two places. The admin
  version on the Staff page wins because it is the richer one — it also holds
  the card label and the agreement status — and because its own help text says
  "staff never type card details", which the self-service field contradicted.
  Card assignment is the company's, not the holder's. The field stays on the
  `PUT /api/auth/profile` schema so a stale cached bundle can't 400 mid-deploy;
  no UI writes it.

Pronouns sits next to "known as" in the admin form and is the same kind of fact,
but it is not in the auth payload, so self-service would mean touching four more
SELECTs. Left alone deliberately — worth doing next time Profile is open.

---

## 13. Phase 2 build log — key data (Sep 2026)

Shipped. **Almost no new schema was needed**, which was the surprise: migration
206 had already added every column §3.2 asked for. What was missing was a way to
write them, a place to see them, and — found on the way — a guard stopping them
reaching the whole team.

Already present, and deliberately NOT re-added: `ni_number_encrypted`,
`rtw_checked_on`, `rtw_document_type`, `rtw_expires_on`, `rtw_checked_by` (all
on `people`, mig 206), and `emergency_contact_*` (mig 001 + 206). A copy on
`staff_employment` would have been the §1.1 licence mistake for a second time.

### 13.1 The leak — private columns on a table the whole team reads

`routes/people.ts` is gated on `STAFF_ROLES`, and **both** its read endpoints
select `p.*`:

- `GET /api/people` — the list
- `GET /api/people/:id` — the detail

So every private column migration 206 added was being served to every staff
member, general assistant and weekend manager who opened any person record:
`rtw_document_type` ("Biometric residence permit" — that is a colleague's
immigration status), `rtw_expires_on`, and the NI ciphertext.

The NI number itself was safe — it is encrypted, and 206 was right to encrypt
it. But the ciphertext still left the server, sat in every browser's network
tab, and announced who we hold an NI number for.

**This is the same shape as the Phase 1 finding** (§12.1): data placed
thoughtfully, gated somewhere else, and the gate was wrong. Two for two. Worth
assuming it is the rule rather than the exception — when a column is sensitive,
check what already selects `*` from its table before trusting where it sits.

**The fix** is `services/people-private-fields.ts`: one exported list, and both
GETs run their rows through it. A redact rather than an explicit column list
because `people` has dozens of columns and the frontend reads a moving subset —
enumerating the safe ones breaks a page every time somebody adds a field, while
stripping a short list of unsafe ones fails in the safe direction. Covered by
`__tests__/people-private-fields.test.ts`, which exists to fail loudly if the
list is ever shortened.

Verified nothing depended on the leak: no frontend file referenced any of the
five. The only other wildcard reads of `people` (`duplicates.ts`,
`data-cleanup.ts`) use the rows server-side and return names and ids only.

### 13.2 The NI number: write freely, read deliberately

206's note said "never plaintext, never in a list view, never in an export", and
`getEmployeeRecord` already honoured it by returning `has_ni_number` as a
boolean rather than the value. That is kept.

But jon needs to *read* it for payroll, or he is back in his inbox. So the
number leaves the server through exactly one route —
`GET /staff-calendar/employees/:personId/ni-number` — and every call writes an
`audit_log` row. The UI renders a "Show" button, not a pre-filled field.

That needed migration 232 to widen the `audit_log` action CHECK, which allowed
only `create | update | delete`. A trail of writes with no record of reads would
have missed the one operation here most worth recording. `'read'` is for
deliberate reveals of sensitive data, not ordinary page views — those would
drown the table.

The write path (`updateKeyData`) is a **separate endpoint** from the employment
save, so a routine edit to somebody's job title cannot blank their NI number,
and the encrypted write has one audited home. It refuses with a 503 before
writing anything if `ENCRYPTION_KEY` is absent — a half-saved right-to-work
check with a silently dropped NI would be worse than an error.

NI format is **validated and rejected** on entry (`QQ123456C`), which is a
departure from CLAUDE.md's "warnings, not hard gates". Justified because this is
input validation rather than a workflow gate — the same treatment the COT card
last-4 already gets — and because an NI number is retyped from a document once
and a typo is silently wrong forever. Reversible if it ever blocks a real case.

### 13.3 The `rtw_` collision

`rtw_` means **right to work** on `people` (mig 206) and **return to work** on
`staff_absences` (mig 214, plus `runRtwChase()` and the 08:50 job). Two
unrelated meanings, one prefix, both live.

Nothing is renamed — both are referenced in shipped code, and a rename is a
migration plus a sweep for no behavioural gain. Recorded in migration 232's
header and in `.claude/rules/staff-calendar.md`, which auto-loads for anyone
working in this area. Do not assume from the prefix; check the table.

### 13.4 The contract's signed date went on the FILE

§3.2 asked for "employment contract — a file, plus signed date and version".
Rather than a `contract_signed_on` column on `staff_employment`, migration 232
adds `document_date` to `staff_record_files`.

The contract IS a file, so its signed date belongs on the file row. Every other
type gets the same field for free — and it is exactly the FROM date §1.3
mandates and §4's review cycles (Phase 6) will read. One column, two jobs, no
second copy.

### 13.5 Known edge, accepted

`StaffKeyData` fetches `GET /staff-calendar/employees/:personId`, which joins
`staff_employment` — so the panel does not render for somebody with no
employment record, unlike the files section, which is deliberately ungated.

Right to work is genuinely checked before employment begins, so this is a real
(if small) inconsistency. Accepted for now because the row already shows the
"not an employee" panel explaining itself, and in practice the employment record
is created first. Revisit if it bites.

---

## 13.6 Postscript — how migration 232 failed, and what it teaches

232 shipped in the Phase 2 PR and **failed on production**, so `document_date`
never landed and the files section returned 500 on both list and upload. Worth
recording in full, because the mistake was a reasoning one and it is repeatable.

**What happened.** 232 did two unrelated things in one transaction: added
`document_date`, and re-imposed a CHECK on `audit_log.action` limiting it to
`create | update | delete | read`. Postgres refused:

```
check constraint "audit_log_action_check" of relation "audit_log"
is violated by some row
```

The whole file rolled back, taking the column with it.

**Why the constraint was wrong.** Migration `032_fix_audit_log_action_constraint`
had **deliberately dropped** that constraint years earlier and widened the
column to VARCHAR(50), because the platform writes actions like
`resolve_referral`, `merge`, `mark_washed`, `override_document_gate`,
`correct_mileage` and a dozen more — several of them from call sites that INSERT
into `audit_log` directly rather than through `logAudit`. Re-imposing a
four-value CHECK would have broken every one of them.

So the database refusing was the **correct** outcome. Had `audit_log` happened
to be empty of those rows, the migration would have succeeded and started
rejecting live writes.

**The reasoning error**: assuming that because a CHECK existed in migration 001,
every row must satisfy it — without checking whether a later migration had
removed it. CLAUDE.md's first always-on rule is *there is probably already a
helper, check before writing a second one*. The same applies to constraints:
**check whether a later migration already decided this, before deciding it
again.** A quick `grep -l audit_log migrations/*.sql` would have found 032.

**Nothing was needed anyway.** `action` has been unconstrained free text since
032, so writing `'read'` had always just worked. The migration solved a problem
that did not exist and created one that did.

**Two lessons now enforced in the code:**

1. `middleware/audit.ts` carries a "never restore a CHECK on this column"
   warning at the point anyone would be tempted, and its `action` type is
   `… | (string & {})` — a hint, not a closed set, because it is not the only
   writer.
2. **One migration, one concern.** A schema change for the files feature had no
   business sharing a transaction with a core-table constraint. This was flagged
   as a design smell when 232 was written and shipped anyway; the cost was a
   broken feature on production.

**232 was rewritten rather than superseded**, which normally CLAUDE.md forbids.
The exception holds because it never applied *anywhere*: the transaction rolled
back, `_migrations` never recorded it, and the runner retries it on every deploy
— so a permanently-failing file is not "applied somewhere", it is a roadblock
parked in front of every later migration. The file now does only the
`document_date` change and says all of this in its header.

---

## 14. Phase 3 build log — `staff_tasks` and My To Do (Sep 2026)

Shipped. The table §6 specified, built general and wired to one consumer.

**Schema** — migration `233_staff_tasks.sql`. `person_id` (the OWNER) · `title`
· `detail` · `due_date` · `status` · `source_type` / `source_id` · `created_by`
· `completed_at` · `chased_at`. Three partial indexes: the "my open list" read,
the source lookup, and the chaser.

`source_type` is free-form text and `source_id` is **not** a foreign key — it
points at a different table per type, so the database cannot enforce it and a
constraint would only block the next consumer. A review action will be
`('staff_review', <id>)` with no migration needed.

**Access — the one thing that differs from the rest of this module.** Staff
records are admin-only; this is not. A to-do list nobody but an admin can tick
is not a to-do list, so the routes are gated on `STAFF_ROLES` and the per-row
rule lives in `assertCanTouch()`:

- you may touch your own task
- an admin may touch anyone's, and is the only one who can put a task on
  somebody else's list
- somebody else's task reports **"not found"**, never "forbidden" — confirming
  a task exists but isn't yours is itself a small leak

That function is the entire security surface, so it has its own tests (13,
covering ownership, the admin short-circuit, cancel-not-delete, and the stamp
rules).

**The chaser** — 09:45 Europe/London, in the existing 09:00–10:00 reminder
block. One nudge per overdue task, stamped with `chased_at`, the same
once-not-daily rule as the return-to-work chase. **Re-dating a task clears the
stamp**, so a genuinely renewed promise earns a fresh nudge while a task you
keep ignoring does not nag every morning. Bell only; the Step-7 escalation
scheduler turns it into email per the recipient's preferences.

**Surface** — `MyTasksPage`, a fourth tab on `MePage` (`/me?tab=todo`), with a
plain add form so the phase is useful before reviews exist. A task from a review
will render a "From your review" badge; nothing else about the page changes.

### 14.1 Also fixed: two components that hid their own failures

`StaffRecordFiles` rendered **"No files yet."** when the load *failed* — an
empty list and a broken endpoint looked identical, which is precisely why three
500s looked calm on screen while Phase 2 was being tested. `StaffKeyData` had
the same shape worse: it caught every error and set the record to null, so a
broken endpoint rendered as an absent panel indistinguishable from "this person
isn't an employee".

Both now distinguish the two states and say which it is. The general lesson,
worth applying to any new fetch: **a failed load must never be able to render as
an empty one.**

---

## 15. Phase 4 build log — reviews, and two chase dates (Sep 2026)

Shipped, together with two date fields jon asked for while testing Phase 3.

### 15.1 Reviews

`staff_reviews` existed since mig 206 and nothing had ever written to it. Phase
4 wires it up and adds what §5 settled:

- **Two notes fields** (`shared_summary`, `private_notes`) — split before there
  was any data to migrate, because it could not be retrofitted. `listReviews()`
  takes `includePrivate` and **defaults to false**, so a caller that forgets to
  think about it gets the safe answer. The legacy `notes` column is kept and
  marked do-not-write; anything in it moved to the private side, since it was
  written with no expectation of being shared.
- **`status`** (`proposed | confirmed | completed | cancelled`) — the
  scheduling exchange trimmed to a confirmation (§5.2). No propose/counter flow:
  seven people once a year is a conversation.
- **`salary_history_id`** — a review points at the `staff_salary_history` row it
  produced rather than holding a figure. Pay is decided *after* the meeting
  (§5.1), so the salary box lives in the **complete** step, not on the review
  form, and the help text says the number goes to them in the follow-up.
- **`review_interval_months`** on `staff_employment` — per-person cadence,
  NULL inheriting `staff.review_interval_months`, the same shape
  `entitlement_weeks` already uses. `recordReviewOutcome()` derives
  `next_review_due` from it so "annual for most, six-monthly for a new starter"
  needs no thought at completion time.
- **Actions** become `staff_tasks` rows with an owner picker covering the whole
  team, not just the reviewee — because §6.2's whole point is that "what should
  Ooosh do differently?" produces actions the *company* owes.

**The review-due scan** keys off the last completed review, falling back to
**employment start + interval** for somebody never reviewed. That fallback is
the important half: a person nobody has ever reviewed is exactly who a reminder
system is for, and keying only off previous reviews would miss them forever.
Skipped when a review is already booked, stamped once per cycle on
`staff_employment.review_due_chased_at`, cleared whenever a review is booked or
completed.

### 15.2 A bug this introduced, caught before shipping

The roster's "next review due" read `WHERE completed_at IS NULL`. Once `status`
existed, a **cancelled** review also satisfied that — so a review somebody
called off would have shown as permanently upcoming. Now keyed on
`status IN ('proposed','confirmed')`.

Worth noting the shape: adding a state column silently changed the meaning of
an existing "is it finished?" test. Any `completed_at IS NULL` check is really
asking "is this still live", and a new terminal state breaks it quietly.

### 15.3 The two chase dates

**Files — `expires_on`.** The expiry printed ON a document (passport, visa,
certificate), which cannot be derived from when somebody looked at it.
`driver-validity.ts` already splits these exactly this way
(`passport_check_date` vs `passport_expiry`, window = the earlier of the two),
and Phase 6 will do the same: review due = `document_date` + the type's
interval, capped by `expires_on`. **Both are inputs** — neither is a "valid
until" a human computes (§1.3). A 30-day nudge fires once per document, to the
admins rather than the person, since these are records the staff member cannot
see. Changing the expiry clears the stamp: a renewed passport is a new document.

**Tasks — `next_chase_date`, and Phase 3's chaser was wrong.** It nudged
**once, ever**. That borrowed the `rtw_chased_at` rule, which is once-only
because a return-to-work conversation is a *one-time event* — whereas a to-do
is an open-ended commitment, and one nudge then eternal silence is precisely
the evaporation §6 exists to prevent. Right rule, wrong shape.

So: the pipeline model (`jobs.next_chase_date`, mig 004, re-armed by
`auto-chase-runner.ts`). Fire, then push the date forward by the interval while
the task stays open. Defaults: the **due date** if there is one, else **today +
14 days** — and that second case is the one that matters, because a task with
no deadline would otherwise never resurface. NULL means never nudge;
finishing or dropping a task clears the date.

Deliberately **not** copying `jobs.chase_interval_days`. A per-row interval is
flexibility `jobs` earned over years; here one system setting plus an editable
date already gives per-task control.

### 15.4 On migration 234 bundling three things

232's lesson was "one migration, one concern", and 234 touches files, tasks and
reviews. The line is **"related to each other"**, not "in the same file": these
are all staff-records tables plus `staff_employment`, nothing shared, nothing
another feature can be taken down by. 232's failure was a *core* table —
`audit_log` — where an unrelated constraint blocked an unrelated column.

---

## 16. The Staff page rebuild (Sep 2026)

Paused after Phase 4 at jon's call: six stacked panels per person had become a
wall, and Phase 5 would only have made it taller. Mocked up first
(clickable, fake data), agreed, then built.

### 16.1 What was actually wrong

Two problems that looked like one.

**Depth.** An expanded person was Account, Company card, Key data, Private
records, Reviews, Employment + patterns — each with its own heading, help text
and form, stacked vertically. Every visit scrolled past five things to reach
one, and each phase added another.

**A missing axis, which was the bigger one.** Everything was organised
*person → topic*, while nearly every real question runs *topic → person*:
whose review is due, what is expiring, who is missing right to work. Answering
any of those meant opening seven cards in turn.

Phases 3–4's reminders partly masked this by pushing those facts at an admin.
But a bell is a push, not something you can ask, and each fires once. §4 had
predicted it: the staff-wide "what is expiring" view "is the bit that replaces
jon's memory".

### 16.2 One URL, two levels

jon's constraint, and it was the right one: **everything stays at
`/staff/admin`** — consolidate what exists, don't spread it thinner across more
nav entries. So the person view is not a new route:
`?person=<id>&tab=records`, same page, same nav.

It is still a real address, which matters more than it sounds: every bell built
in phases 3–4 pointed at `/staff/admin` bare, so "Will's review is due" dropped
you on a list of collapsed cards to hunt through. Review-due and
document-expiry notifications now link to the tab that answers them. **New
bells should do the same.**

### 16.3 The three surfaces, and why each is shaped as it is

**Needs attention** (`services/staff-attention.ts`) — every row derived, none
stored. Documents expiring or expired, right to work missing or lapsing, NI
missing, reviews due, probation ending, no working pattern, unlinked logins.
Nothing to clear by hand, so it cannot go stale or lie. Adding a source is a
query, never a column.

NI missing is deliberately `info`, not `soon`: payroll wants it but nothing
breaks today, and an amber row for something routine teaches people to ignore
amber.

**The roster** carries *flags, not data* — two or three coloured pills per
person, drawn from the same derived list as the panel above, so the two cannot
disagree. Only hours and next review appear as figures, because they are the
two things worth comparing across people.

**The person view** is five tabs: Overview · Employment · Records · Reviews ·
Access. Overview is **read-only on purpose** — most visits are to look
something up, and the old layout charged a scroll past five forms for every
one of them. Editing lives on the other tabs. The upload form moved behind a
button for the same reason: you file a document once and read the list a
hundred times.

### 16.4 Two bugs caught in review, both from the same blind spot

**Managers would have met a 403 dressed as a load failure.** The page is
manager-tier for the account section, but Overview reads two admin-only
endpoints. A manager opening anyone would have seen a red error box. They now
get a plain facts card instead.

**A deep link straight to a person showed no attention items.** The list was
fetched inside the panel, and the panel does not render in the person view —
so arriving from a notification, the very surface the link was for came up
empty. The fetch moved up to the page, which is where it belonged anyway: one
request now feeds the panel, the roster flags and the person view.

Both are the same mistake: assuming the component that *displays* something is
the right place to *load* it, without asking who else needs it and who else
can see it.

### 16.5 Shared, not duplicated

"Who is due a review" now has one definition — `listReviewsDue()` in
`staff-employment.ts` — used by both the 09:45 scan and the attention list.
They differ only in `onlyUnchased`, because the scan nudges once per cycle
while the page always shows. Two copies of that date arithmetic would have
drifted, which is the failure mode CLAUDE.md's helper rule exists to stop.

---

## 17. Phase 5 build log — the staff-facing review (Sep 2026)

Shipped. Phase 4 gave the reviewer somewhere to record a review; this gives the
other person a part in it. Without it, what we had built was an appraisal done
*to* somebody.

### 17.1 What landed

**The invite (§5.2).** Booking a review now tells the person, once, with the
prep questions attached. §5.2 trimmed scheduling to a bare confirmation
precisely because the value was never the scheduling — it is that this message
carries the questions. A bell rather than a hand-rolled email, so the Step-7
escalation scheduler turns it into email per *their* notification preferences
instead of overriding them. `invited_at` keeps it to once: a second "you have a
review" every time a note is edited teaches people to ignore the first.

**The questions (§5.3).** Six, in `system_settings` as a JSON array, asked of
**both sides**. Identical questions are the whole mechanism — it is what turns
"boss delivers verdict" into "two documents compared" — so they come from one
place, `getReviewQuestions()`.

**Their answers**, stored as JSONB on the review and surfaced on the admin
Reviews tab *above* the notes fields, because reading them before the meeting
is the entire point of asking in advance. The review strip now says whether
they have been told and whether they have answered.

**The write-up (§5.5).** Completing a review emails them the shared summary,
the agreed actions with owners and dates, and — if one came out of it — the new
salary and when it starts. `follow_up_sent_at` keeps it to once, so amending a
completed review does not re-send.

That last piece is what makes §5.1 work in practice. Deciding pay after the
conversation only feels like process rather than evasion if the figure reliably
arrives afterwards.

### 17.2 Decisions worth not re-litigating

**JSONB, not a normalised answers table.** The question set is editable and
will change between cycles. A normalised table would need a questions table,
versioning, and a join to render a five-year-old review as it was actually
asked. The array stores the question TEXT beside each answer, so an old review
always reads back correctly however the current wording has moved on.

**Answers are keyed by question text on the way back in**, so a reworded
question comes back blank rather than showing an answer to a different
question.

**A bad setting can never show an empty form.** `staff.review_questions` is
human-editable, so `getReviewQuestions()` falls back to the built-in six on
anything unparseable, not-an-array, or empty — and keeps the good entries when
only some are junk. Eight tests pin this down, because the person filling in an
empty form has no way to know something is broken.

**The reviewee's read is column-by-column, never `SELECT *`.** `getMyReview()`
lists the columns it returns, so `private_notes` and `manager_prep` cannot leak
by somebody later adding a column to the table. Given §5.4's whole argument —
that a field which *might* be read gets self-censored into uselessness — a
default-open read here would undo the feature, not just leak a field.

**The tab only exists when there is a review.** A once-a-year thing does not
earn permanent space beside tabs people use weekly, so `MePage` asks once and
hides it otherwise — but always shows it when it is the tab being requested, so
the notification's deep link can never land on a hidden tab.

### 17.3 Migration numbering — it collided TWICE

Written as 235. Renumbered to 236 before commit, because a parallel branch had
taken 235 (`235_shop_stock_cache.sql`). Then renumbered again to **237** on
merge, because the same branch had meanwhile taken 236 too
(`236_shop_stock_scope.sql`).

CLAUDE.md warns to take the next free number at *build* time. The sharper
lesson from doing it twice in one afternoon: on an active repo the number is
not settled until the merge, so **re-check it at merge time, not just before
committing.** The conflict itself is harmless and exactly what you want — two
files claiming one number is a collision git can see. What would be genuinely
dangerous is two branches picking the same number and the conflict NOT
surfacing, which is why the runner's hardcoded list earns its keep here: it
makes the clash a merge conflict instead of two files quietly sorting into an
arbitrary order.

Resolved by keeping both, in order: main's `236_shop_stock_scope.sql` (already
applied on production) stays put, and this one moves to 237. Renumbering was
safe only because 236 had never been applied anywhere — had it run on any
environment, the rule is a NEW migration, never a rename.

---

## 18. The basic employer record (Sep 2026)

jon, after living with phases 1–5: *"contact details, emergency contact,
pension, DOB, marital status… all basic stuff any employer should have."* Plus
three gaps found in use.

### 18.1 Most of that list already existed

The same finding as Phase 2, for the third time. Already on `people` and NOT
re-added: `phone`, `mobile`, `international_phone`, `home_address`,
`date_of_birth`, `emergency_contact_*` (mig 001) and the second emergency
contact (mig 206). They have been there since the first migration; what was
missing was anywhere in the staff area to type them.

**Genuinely missing: two.** `marital_status`, and pension.

The pattern is now consistent enough to state as a rule: **when this module
"needs a field", check `people` first.** It is the platform's oldest and widest
table and it already carries most of what an employer record wants.

Placement: personal details sit with NI and right to work on the **Records**
tab, under "Personal & key data". Records is already the admin-only home for
everything private we hold about somebody, field or file — a date of birth
belongs with an NI number, not with contracted hours.

### 18.2 Pension is a history, not a pair of columns

`staff_pension_history`, append-only, mirroring `staff_salary_history`: a
contribution change is a NEW ROW, never an edit. Two columns on
`staff_employment` would keep the current figure and lose every previous one,
which is the half that matters — auto-enrolment gives "what were they on, and
from when" legal weight.

**Opting out is a recorded state, not an absent row.** "We have no pension row
for Sam" and "Sam opted out on 3 March" are different facts and only the second
is evidence, so `is_member` is a column rather than membership being implied by
a row existing.

### 18.3 Three gaps found by using it

**Salary had no UI at all.** `staff_salary_history` and its endpoints have
existed since migration 206 with nothing calling them — the same shape as
`staff_reviews` before Phase 4. Now on the Employment tab with the history and
the change between each figure, which is what "how have salaries moved" needs.

**A booked review could not be called off.** Phase 4 gave `staff_reviews` a
`cancelled` status and no way to reach it, so jon's test review was stuck: not
completable (it had not happened) and not removable. A "Call it off" action now
exists on any review that is not finished. Worth noting the shape of the
mistake — a status nothing can set is the same bug as a gate with no route
through it, which CLAUDE.md's product policy already warns about.

**Past reviews could not be recorded.** Everything assumed a review was about
to happen, so years of history had nowhere to go. "Already happened" on the
booking form records one as completed on its own date, and deliberately sends
nothing: no invite for a meeting held in 2023, and no write-up email.

### 18.4 What was NOT redacted, and why

`marital_status` joins `PRIVATE_PERSON_FIELDS` — nothing computes from it and
nobody outside the staff area needs it.

`date_of_birth`, `home_address`, `phone` and the emergency contacts did **not**,
despite being personal. They have been served by the general people endpoints
since migration 001 and the driver and hire-form flows read them there
legitimately — `driver-verification.ts` maps `date_of_birth` directly.
Redacting them is a real question, but it is a decision about the People
record and its consumers, not something to slip into a staff-area change. If it
is taken up: start from `routes/people.ts`, and expect the driver flows to need
their own read.

---

## 19. Phases 6 and 7 build log — cycles and retention (Sep 2026)

The last two phases. Both were waiting on decisions only jon could make, and
both decisions simplified the build rather than complicating it.

### 19.1 Phase 6 was settled by NOT sharing

§1.1 and §1.2 agonised over whether the staff DVLA check should read `drivers`,
and warned that generalising `driver-validity.ts` would reproduce the bug it
was written to end. jon cut it straight through:

> "Completely ignore the driver system we have in place currently — that's for
> verifying self-drive-hire clients. The process for staff is different, it's
> just an annual sanity check that they're declaring everything they should."

So: **same words, different people, different consequence.** The driver system
answers "is this client insurable for this hire, today" in a 30-day window with
a hard gate behind it. The staff system answers "have we looked at Will's
licence this year" and nudges. Nothing in `services/staff-doc-cycles.ts` reads
`drivers`, and `driver-validity.ts` is untouched.

That is worth remembering as a general move: two features that share a noun are
not necessarily one feature. The cheapest resolution to "how do we share this?"
is sometimes "we don't".

**The model is still inherited**, even though no code is: record the FROM date
(`document_date`), derive when it next needs looking at. Review due =
`document_date` + the type's interval, **capped by `expires_on`** — a passport
running out in March does not need re-checking in June, it needs replacing in
March. A newer document of the same type supersedes an older one, so last
year's DVLA check goes quiet once this year's is filed.

Intervals live in `staff.doc_review_intervals` (JSON, per `doc_type`, months;
0 = never). DVLA and licence default to 12; contract to 0, because a contract
does not expire and re-reading it annually is noise. Nine tests cover the
parsing, on the same principle as the review questions: a staff-editable
setting will eventually contain junk, and chasing nothing is as bad as chasing
everything.

### 19.2 Phase 7: what expires, and what must never

**Absence detail** is swept automatically after 12 months, per §17 item 9 of
the staff calendar spec. The sweep nulls `reason_category`, `notes` and the
return-to-work narrative, stamps `detail_purged_at`, and leaves the spell.

**`absence_type` SURVIVES — and the spec was wrong about this.** §7 listed the
type as expiring. It cannot: `getSicknessMinutes()` filters on
`absence_type = 'sickness'` and the payroll report reads it, so purging the
type would silently zero everybody's sickness figures rather than anonymise
them. §7 said to "verify that before relying on it" — verifying it is what
caught this. Day rows, minutes and every ledger effect stay for the same
reason.

**Right to work is SURFACED, never swept.** jon: keep it for the whole
employment plus two years, so the clock runs from
`staff_employment.end_date`. It appears on the attention list once that passes;
an admin deletes it. Three reasons not to automate: destroying evidence of a
right-to-work check is irreversible and legally consequential, the clock
depends on a leaving date somebody typed by hand, and CLAUDE.md's product
policy is warnings rather than silent action.

### 19.3 The medical notes field was never built — deliberately

§3.2 listed a free-text "medical notes" box, held back to Phase 7 until
retention existed. Retention now exists, and the recommendation is still
**don't build it**.

The `medical` *document type* already covers the real need: filing a sick note
or an occupational-health letter, deliberately, with a label and a date, and
deletable by hand. A free-text medical box on an employment record is
special-category data with no natural expiry, no clear consumer, and nothing
computing from it — which is exactly the shape of a field that gets filled in
once, forgotten, and found years later in a subject access request.

If it is ever wanted, it needs its own retention answer first, and that answer
cannot be "when they leave" — medical information about a current employee has
no natural end date while they are still employed.

---

## 20. Current state — read this first

All seven phases shipped 21–23 Sep 2026. This section is the handover.

### 20.1 What exists

| Thing | Where |
|---|---|
| Private files about staff | `staff_record_files`, `routes/staff-records.ts`, `components/StaffRecordFiles.tsx` |
| NI (encrypted) + right to work | on `people`, written via `updateKeyData()`, read via `StaffKeyData.tsx` |
| Personal details (phone, address, DOB, marital, emergency) | on `people` since mig 001 — `updatePersonalDetails()` |
| Salary + pension history | `staff_salary_history` (mig 206), `staff_pension_history` (238), `components/StaffPay.tsx` |
| To-dos | `staff_tasks`, `services/staff-tasks.ts`, `pages/MyTasksPage.tsx` |
| Reviews, both sides | `staff_reviews`, `staff-review-prep.ts`, `staff-review-followup.ts`, `StaffReviews.tsx`, `MyReviewPage.tsx` |
| Document re-check cycles | `services/staff-doc-cycles.ts` |
| Retention | `services/staff-retention.ts` |
| "Needs attention" | `services/staff-attention.ts` — THE cross-person view |
| The page | `/staff/admin`, `?person=<id>&tab=…` |
| Daily reminders | one 09:45 cron in `config/scheduler.ts`, five independently-caught scans |

Migrations: **231, 232, 233, 234, 237(*), 238, 239**.
(*) `237_staff_review_prep.sql`. 235 and 236 were taken by the parallel
shop-sales branch, which then also took a 237 (`237_shop_vat_rates_from_hirehop.sql`),
so **there are two 237 files and both are correct** — see §17.3 and §21.2.

### 20.2 What is deliberately NOT built

Do not "finish" these without re-reading the reasoning:

- **A free-text medical notes field** (§19.3). The `medical` document type
  covers the real need; the field has no natural expiry.
- **Any link between the staff document check and `drivers`** (§19.1). Same
  words, different people.
- **Staff seeing their own records** (§2). No for v1, except their own review
  and their own to-dos. The gate is one constant, `STAFF_ADMIN_ROLES`.
- **Redaction of `date_of_birth` / `home_address` / `phone`** from the general
  people endpoints (§18.4). Real question, but it is a People-record decision
  and the driver flows read them there legitimately.
- **A propose/counter review scheduling exchange** (§5.2). Trimmed to a
  confirmation on purpose.
- **Per-task chase intervals** like `jobs.chase_interval_days` (§15.3). One
  setting plus an editable date is enough for seven people.

### 20.3 Open questions

1. **Right-to-work retention is set to employment + 2 years** on jon's word.
   Worth one confirmation from an HR advisor — it is the only setting here with
   a legal consequence for being wrong.
2. **Review question wording** (§5.3) — jon intends to rewrite the six. Purely
   a `system_settings` edit, no code.
3. **`staff.review_interval_months` is 12 for everyone** until somebody gets a
   per-person override on the Employment tab.

### 20.4 The four lessons this module kept re-learning

Stated plainly because each one cost real work:

1. **Check whether it already exists.** Right to work, NI, emergency contacts,
   phone, DOB, home address, `staff_reviews`, `staff_salary_history` — every
   one was already there and needed surfacing, not building. Three separate
   phases rediscovered this.
2. **Check where the gate actually is, not where the data sits.** Twice,
   sensitive columns were placed thoughtfully and served by an endpoint that
   did `SELECT *` behind a wider role (§12.1, §13.1).
3. **A failed load must never render as an empty one** (§14.1). Three 500s
   looked calm on screen for a whole testing round.
4. **One migration, one concern** (§13.6). A feature's schema change sharing a
   transaction with a core-table constraint took a shipped feature down.

---

## 21. Follow-up audit — spec vs code (23 Sep 2026)

A pass checking every "shipped" claim above against the code. Phases 1–7 and
§18 are all present as described. Three things needed fixing or recording.

### 21.1 The §13.1 leak had a third door

§13.1 redacted both people READ endpoints. The WRITE endpoints were missed:
`PUT /api/people/:id` returns `RETURNING *` — on the update path and on its
"nothing changed" early return. It is gated on `STAFF_ROLES`, so any staff
member editing any person got back the NI ciphertext, the right-to-work fields
and `marital_status` in the response. `POST /api/people` also returns
`RETURNING *`; a brand-new row has none of those set, so it leaked nothing, but
it is redacted too so the rule has no exceptions.

Fixed by running those three responses through `redactPrivateFields()`. The
audit snapshot still takes the full row — the helper returns a copy.

That makes it **three for three** (§12.1, §13.1, this): the rule in §20.4 item 2
applies to every response that carries a row, not only the obvious reads. When
checking "what selects `*` from this table", check what RETURNS `*` too.

### 21.2 Two migrations numbered 237 — leave them

`237_shop_vat_rates_from_hirehop.sql` and `237_staff_review_prep.sql` both
exist. That is harmless: the runner applies them in the order its hardcoded
list gives, and `_migrations` records each by FILENAME. Once either has been
applied anywhere, **renaming it makes the runner treat it as new and re-run
it.** The runner's list carries a comment saying so.

Also: migration 234's header refers to "§14.2" for the chase dates — the
section is **§15.3**. Left in the file rather than edited, since 234 is applied
and CLAUDE.md forbids editing an applied migration, even a comment.

### 21.3 The staff check and `drivers` — the cost, stated

§19.1 separates the staff document check from `drivers` completely, and jon
confirmed it again here: **staff records win for anything about staff.** The
consequence worth knowing: when a staff member who also drives is re-checked,
the date goes in BOTH places — the staff record (for the annual employer
check) and the driver record (for hire insurability). Nothing syncs them, on
purpose. Do not add a sync: it would recreate the §1.1 drift problem with a
third copy.

### 21.4 Agreed next, not yet built

Settled with jon on 23 Sep 2026, to be built in this order:

1. **Per-record dated actions** — on any staff record, an action date, what
   happens (**remind** or **flag for deletion**), delivery (bell / email /
   both, as the job remind-me form), recipient (default: whoever set it), and a
   note. The per-type intervals in `staff-doc-cycles.ts` become the pre-filled
   DEFAULT, editable per record. **Deletion is flag-and-confirm, never
   automatic** — the bell carries a Delete button and the item stays on Needs
   attention until actioned. Records without a file (a label + text "note") so
   the same dates apply to anything held, not only uploads.
2. **Check-in between reviews** (§5.6, never scheduled until now) — a "Since
   last review" list on the admin Reviews tab of every action agreed at the
   last review, whoever owns it; plus a "check-in due" item on Needs attention
   at the half-way point of the person's review interval.

