# Staff Records — private files, key data, document review cycles, and staff reviews

**Status: SPEC ONLY, nothing built.** Written 21 Sep 2026 at the end of the
staff-calendar session, from jon's §17 answers. Start a fresh chat from this
file.

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

Today these live in jon's email inbox.

---

## 1. READ THIS BEFORE DESIGNING ANYTHING

Three things already exist that this module must not rebuild. Getting this
wrong is the difference between a week's work and a month of it, plus a second
copy of somebody's licence data that drifts out of step with the first.

### 1.1 Licence, DVLA check code and passport ALREADY EXIST, for anyone who drives

`drivers` has `person_id`. A staff member who drives is a `drivers` row linked
to their `people` row. That table already holds:

```
licence_number · licence_type · licence_valid_from · licence_valid_to
licence_points · licence_endorsements · licence_restrictions
dvla_check_code · dvla_check_code_encrypted · dvla_check_date · dvla_valid_until
licence_next_check_due · licence_address_encrypted
passport_check_date · passport_expiry · passport_valid_until
```

**So "we want a new DVLA check code every year" is largely already built** —
`dvla_check_date` + a derived window, with `licence_next_check_due` already a
column. The work is surfacing it in the staff area and driving a reminder off
it, NOT storing it again.

**The trap:** if this module adds its own `licence_expiry` for staff, Will's
licence exists in two places with two expiry rules. That is precisely the bug
`services/driver-validity.ts` was written to end — read its header before
writing any expiry logic. It documents six consumers with four different rules
and a real incident (job 16291, 19 Aug 2026) where a driver had green pills on
his own page and a hard 400 out of the assign picker.

**Decide explicitly and write it down:** does a staff member's licence live in
`drivers` and get *surfaced* in the staff area (recommended), or does the staff
area own its own copy (do not)?

### 1.2 `driver-validity.ts` is the model for every expiry

Its rule, learned the hard way: **humans record a FROM date only** — the day the
document was issued or the check was run, which is the easiest thing to read off
a document — and the system **derives** the expiry from a per-type rule. Never
ask a human for "valid until".

Any new document type here should follow the same shape, and ideally the same
module generalised rather than a parallel one.

### 1.3 `staff_documents` is NOT this

`staff_documents` / `staff_document_assignments` is **documents we publish TO
staff** — handbook, policies, training, with tick/sign completion tracking and
a target-set resolver. See `docs/STAFF-DOCUMENTS-SPEC.md`.

This module is **documents we hold ABOUT staff**. Opposite direction, opposite
access rules. Reusing that table would conflate "everyone must read this" with
"nobody may see this", which is a permissions accident waiting to happen.

Name the new thing so nobody confuses them. `staff_records` /
`staff_record_files` reads better than anything with "documents" in it.

### 1.4 Other things to reuse, not rebuild

| Need | Use |
|---|---|
| Encrypting an identifier | `services/encryption.ts` — `encrypt` / `tryDecrypt`, and the existing `*_encrypted` column convention |
| Private file storage | Cloudflare R2 private bucket `ooosh-operations`, as `costs.receipt_r2_key` and driver documents already do |
| Showing a private file in the DOM | `frontend/src/hooks/useAuthedFileUrl.ts` |
| Opening one in a new tab | `frontend/src/lib/openAuthedFile.ts` |
| A once-only reminder | the `rtw_chased_at` / `offer_chased_at` stamp pattern — see `.claude/rules/staff-calendar.md` |
| Who may see this | `MANAGER_ROLES` / `authorize('admin')`, per CLAUDE.md's RBAC section |

---

## 2. Access model — decide this first, it shapes everything

jon said **admin-view-only**. Worth pinning down precisely, because "admin" in
this codebase means a role, and `weekend_manager ≡ manager`:

- **Proposed:** `authorize('admin')` for everything in this module. Not
  `MANAGER_ROLES`. This is passports, medical notes and NI numbers for seven
  people; the blast radius of getting it wrong is worse than the inconvenience
  of a narrow gate.
- **Precedent:** absence already does this — it lives on its own page because it
  is admin-only special-category data (§0.5 of the staff calendar spec).
- **Question for jon:** should a staff member see their OWN records? There is a
  decent argument for yes (it is their passport), and a decent argument that it
  doubles the surface area for no operational gain. Recommend: **no for v1**,
  with the door left open — do not bake `admin`-only into twelve call sites when
  one helper would do.

**Never put any of this on the People record.** `people` is staff-wide readable
and holds clients, contacts and bands as well as employees.

---

## 3. Piece one — private files and key data

### 3.1 Files

A labelled file list per staff member. Admin only.

- `staff_record_files`: `id · person_id · label · doc_type · r2_key ·
  filename · content_type · size · uploaded_by · uploaded_at · notes`
- **Labellable** — jon's word. Free-text label ("Passport 2024", "Contract
  signed Mar 2025") ALONGSIDE a `doc_type` enum that drives the review cycle.
  The label is for humans; the type is for the system. Do not make the type
  free text or §4 cannot work.
- Soft-delete, not delete (CLAUDE.md's data-handling rule).

### 3.2 Key data fields

On `staff_employment` (it describes the employment) or a sibling table:

- **NI number** — encrypted. jon: "needed for payroll but also just my reference
  as an employer."
- **Right-to-work evidence** — what was seen, when, by whom. §17 item 7. This is
  a legal record; the *check* matters as much as the document.
- **Employment contract** — a file, plus signed date and version.
- **Emergency contact** — already on `people`; do not duplicate, surface it.
- **Medical notes** — free text, admin only, and the thing retention bites on.

### 3.3 Where it appears

jon: "within each drop-down staff member I add". That is the expandable staff
row on `StaffAdminPage`. A new section there, admin-gated, alongside the
existing employment and pattern panels.

---

## 4. Piece two — document review cycles

The general system behind "a new DVLA check code every year".

- `doc_type` carries a **review rule**: an interval (DVLA: 12 months), or an
  expiry read off the document (passport), or none (contract).
- Store the **FROM date**; derive the due date. §1.2.
- Rules belong in `system_settings` so the interval changes without a deploy.
- A daily scheduled scan raises a bell + email at a lead time, **once**, stamped.
  Slot it in the 09:00–10:00 block; the list is in CLAUDE.md.
- A staff-wide "what is expiring" view — this is the bit that replaces jon's
  memory, and it should cover everyone rather than being per-person only.

**Reuse the driver machinery where the document is already a driver document.**
`licence_next_check_due` exists. The compliance scanner at 08:00 already exists.
Check what it covers before adding a second scanner.

---

## 5. Piece three — staff reviews

### 5.1 The scheduling exchange

jon wants a light back-and-forth, explicitly **not** a booking system:

1. A review falls due (cadence per person — annual, six-monthly, probation).
2. Admin is reminded.
3. The staff member is alerted that a review needs scheduling, with a proposed
   date.
4. They accept, or counter with a date that suits.
5. Confirmed, and it lands on the staff calendar.

Steps 3–4 are the same accept/counter shape as the freelancer yard-day offer
(§9.3/§9.4 of the staff calendar spec) — token or in-app, propose, respond. Read
that before designing it; the one difference is that a counter-proposal IS
wanted here, where it was explicitly not for yard days.

### 5.2 The review content — a conversation, not a build

jon: *"I'd also like some help drawing up the review process itself, the one I
currently use is very out of date."*

**Settle the content BEFORE the schema.** What you ask in a review determines
what you store, and a form built around the wrong questions is worse than no
form. Expect: objectives since last review, how they went, development wanted,
what the company should do differently, and anything formal (probation,
pay review trigger).

Open question for jon: are review notes visible to the staff member? A review
they cannot read is an appraisal done *to* somebody.

---

## 6. Retention

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
particular has a statutory retention period that is NOT one year — check it
rather than assuming.

---

## 7. Open questions for jon

1. Does a staff member see their own records? (Recommend no for v1.)
2. Licence/DVLA/passport: surfaced from `drivers`, or owned here? (Recommend
   surfaced. §1.1.)
3. Are review notes visible to the person reviewed?
4. Review cadence: annual for everyone, or per person?
5. Retention per document type — especially right-to-work.
6. Does anything here need to survive somebody leaving, and for how long?

---

## 8. Suggested build order

1. **Access model + the files table.** Get the gate right before anything
   sensitive exists.
2. **Key data fields**, encrypted where identifying.
3. **Review cycles** — after §1.1 is settled, or it gets built twice.
4. **Staff reviews** — content agreed first, then schema, then the exchange.
5. **Retention sweeps** — last, but before go-live on anything medical.

## 9. What to read first

- `services/driver-validity.ts` — the header. The whole expiry model and why.
- `docs/STAFF-DOCUMENTS-SPEC.md` — so you do not confuse the two modules.
- `docs/STAFF-CALENDAR-SPEC.md` §0.5 (special-category data), §9.3/§9.4 (the
  propose/respond shape), §17 (jon's answers).
- `.claude/rules/staff-calendar.md` — loads automatically; the chase-stamp rules.
- CLAUDE.md — RBAC, migrations (hardcoded runner list), soft-cancel.
