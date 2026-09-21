# Staff Records — private files, key data, document review cycles, and staff reviews

**Status: SPEC ONLY, nothing built.** Written 21 Sep 2026 at the end of the
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
| 1 | **Files + admin gate** (§2, §3.1, §3.3) — `staff_record_files`, R2 private bucket, new section on the expandable staff row, soft-delete | jon starts emptying the zip folder the day it deploys |
| 2 | **Key data** (§3.2) — NI encrypted, right-to-work, contract + signed date. **Not medical notes** | The rest of the folder |
| 3 | **`staff_tasks` + My To Do tab** (§6) — including a plain "add a task" form, plus the daily chaser | Useful as a general to-do immediately, before reviews exist |
| 4 | **Review record + cycle** (§5.1, §5.2, §5.4, §5.6) — split notes, per-person interval, "review due" reminder, salary link, admin UI | The full loop minus staff-facing bits; actions write `staff_tasks` rows |
| 5 | **Staff-facing exchange** (§5.3, §5.5) — confirmation carrying prep questions, their answers, the follow-up email | The staff half |
| 6 | **Document review cycles** (§4) — the annual DVLA check and friends | Replaces jon's memory |
| 7 | **Retention sweeps** (§7) — absence medical detail, per-type retention — **and only then §3.2's medical notes** | Closes the GDPR item |

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
