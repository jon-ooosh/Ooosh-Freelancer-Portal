# Freelancer Onboarding Module — Spec (DRAFT)

Status: **planning / awaiting sign-off** — no code until this is agreed.

Branch: `claude/freelancer-onboarding-workflow-j498xl`

## 1. Purpose

Replace the old Jotform-driven freelancer sign-up with a native OP workflow. Ooosh
takes on freelance crew on an ad-hoc basis (driving, backline, FOH, TM, studio sitting,
warehouse, etc.). The old flow was: email a Jotform link → freelancer fills it out →
manual review → approve/deny → (if approved) manual insurance add, T-shirt, portal
access + training docs, payments-policy reference.

This module brings that end-to-end into OP: **invite → apply → review → approve →
onboard**, with the completed application populating the People address book and the
freelancer's own detail page becoming the single home for their status, documents, and
onboarding checklist.

### Gating principle

The application form is **not open to the public**. A freelancer only reaches it via a
tokenised link that staff generate for a specific person, after we've met them and
decided they're a good fit (arm's-length intro, met on a job, cold email we liked). The
token *is* the gate.

## 2. What we reuse (why this is mostly wiring)

| Need | Existing pattern to reuse |
|---|---|
| Public, no-Layout, token-gated form page | Carnet client form — `frontend/src/pages/CarnetFormPage.tsx` + per-record `form_token` column + public endpoints declared before the auth gate in `backend/src/routes/carnets.ts`. Mounted in `App.tsx` before the `ProtectedRoute`/`Layout` block. |
| Freelancer flags on people | `people.is_freelancer`, `is_approved`, `freelancer_joined_date`, `freelancer_next_review_date`, `skills text[]`, `has_tshirt`, `is_insured_on_vehicles`, `freelancer_references`, `files JSONB` — all already exist (migrations 001 + 010). |
| Skills list | `GET /api/people/skills` (already built). |
| People filtering | `routes/people.ts` already accepts `is_freelancer`, `is_approved`, `skills_any` query params. |
| Signature capture | Hire-form signature-pad pattern. |
| Email (branded, test-mode, per-template live release) | `emailService.send(templateId, {...})` + template registry in `services/email-templates/index.ts`. |
| PII encryption | AES-GCM dual-column pattern (`services/encryption.ts`), per the retrofit checklist. |
| "Chase X days before a date" reminders | `services/compliance-checker.ts` + a daily `cron.schedule` slot in `config/scheduler.ts`. |
| Portal register/verify/complete (for portal access) | Migration 052 portal auth flow. |
| Freelancer detail-page tab pattern | `PersonDetailPage.tsx` conditional tab array (e.g. the `freelancer_history` tab). |

## 3. Lifecycle & status

The freelancer's state is carried on the person via `is_freelancer` / `is_approved`
plus a new `freelancer_status` on the application record:

| `freelancer_status` | `is_freelancer` | `is_approved` | Meaning | Picklist behaviour |
|---|---|---|---|---|
| `invited` | true | false | Link sent, nothing back yet | Greyed / disabled ("invited") |
| `applied` | true | false | Form submitted, awaiting review | Greyed / disabled ("pending review") |
| `more_info` | true | false | Staff asked for more/corrected info; re-openable link | Greyed / disabled ("info requested") |
| `approved` | true | true | Cleared to be booked | Normal, selectable |
| `declined` | true | false | Not proceeding | Hidden from pickers (or greyed "declined", TBD) |

Staff sees a status badge on the person header (the header already renders
"Approved Freelancer" / "Pending Approval" — we extend it to reflect the finer states).

## 4. Data model

### 4a. New table — `freelancer_applications` (migration 184)

One row per application (an existing freelancer being re-invited for annual re-consent
gets a new row, keeping history).

```
freelancer_applications
  id                  UUID PK
  person_id           UUID FK -> people(id)      -- the person created/linked at invite time
  form_token          TEXT UNIQUE                -- base64url randomBytes(24), the gated link
  status              TEXT   -- invited | applied | more_info | approved | declined
  invited_by          UUID FK -> users(id)
  invited_at          TIMESTAMPTZ
  submitted_at        TIMESTAMPTZ
  reviewed_by         UUID FK -> users(id)
  reviewed_at         TIMESTAMPTZ
  decision_notes      TEXT                        -- decline reason / more-info request
  submission          JSONB                       -- raw submitted answers (audit / re-render)
  insurance_answers   JSONB                       -- the 4 insurance questionnaire Q&A + details
  references          JSONB                       -- [{name, company, email, phone, role, consent}]
  signature_r2_key    TEXT                        -- signed T&Cs signature image
  tcs_version         TEXT                        -- which T&Cs/GDPR text was agreed
  created_at / updated_at
```

Token validity is **status-bound**, not TTL: usable while `invited` / `more_info`,
rejected once `applied` (unless re-opened) / `approved` / `declined`. (Mirrors the OOH
parking token model — cleaner than juggling expiries.) Optional soft expiry
(`invited_at + N days`) can be added if you want stale links to auto-close.

### 4b. Expanded per-person document + expiry fields (migration 184)

To drive "chase me X months before their licence expires", document expiry dates must be
**queryable columns**, not buried in `files` JSONB. Add nullable columns on `people`
(driving-related, encrypted where PII per the retrofit pattern):

```
licence_number            TEXT   (encrypted)   -- if not already present
licence_issued_by         TEXT
licence_expiry            DATE
licence_passed_date       DATE
dvla_check_date           DATE                  -- when DVLA summary was obtained
passport_expiry           DATE
pli_expiry                DATE                  -- public liability insurance (from extra docs), optional
day_rate_note             TEXT                  -- free-text expected day rate from the form
preferred_name            TEXT                  -- "I prefer to be known as..."
emergency_contact_name    TEXT
emergency_contact_phone   TEXT
```

Actual document **files** continue to live in `people.files` JSONB with labels (licence
front/back, DVLA summary, passport, PLI/CV extras) — same as today's `FreelancerDocuments`
component. The new date columns are the machine-readable layer for reminders + display.

Onboarding checklist reuses existing columns where possible: **`has_tshirt`**,
**`is_insured_on_vehicles`** already exist. New checklist state that has no home
(portal-access-sent, training-docs-shared, reviewed/approved timestamps) goes in a small
`onboarding JSONB` on the person (or dedicated booleans — decide at build; JSONB keeps the
migration light).

### 4c. Note on `drivers` table

We deliberately **do not** create a `drivers` row for a freelancer. That table is for
client self-drive hires + the hire-form flow. All freelancer licence/insurance data lives
on the person, per agreement.

## 5. Field mapping (Jotform → OP)

| Jotform field | Lands in |
|---|---|
| Full name, "prefer to be known as" | `people.first_name`/`last_name`, `preferred_name` |
| Email, phone 1/2 | `people.email`, `phone`, secondary phone |
| Date of birth | `people.date_of_birth` (encrypted) |
| Home address | `people` address fields (encrypted) |
| Emergency contact name + phone | `emergency_contact_name` / `_phone` |
| UTR / eligible-to-work confirmation | `submission` JSONB (+ covered by T&Cs signature) |
| "I'm looking for" (tour / local / UK / UK&EU) | `submission` JSONB (+ maybe tags) |
| Passport valid ≥18mo (if UK&EU) | `submission` JSONB; passport file → `files` |
| Skills (multi-select) | `people.skills text[]` |
| **Driving section (conditional on "Driving" skill):** | |
| Confidence Qs (3.5t/7m, pax/equip/both) | `submission` JSONB |
| Licence number, issued by | `licence_number`, `licence_issued_by` |
| Licence front/back upload | `files` JSONB (labelled) |
| DVLA summary upload (or passport if non-UK) | `files` JSONB + `dvla_check_date` |
| Licence expiry, date passed | `licence_expiry`, `licence_passed_date` |
| Licence address (if different) | `submission` JSONB / a person field if wanted |
| Insurance questionnaire (4× Y/N + detail) | `freelancer_applications.insurance_answers` |
| "Anything else + expected day rate" | `day_rate_note` + `submission` JSONB |
| Extra docs (PLI, CV) | `files` JSONB (+ `pli_expiry` if a PLI cert) |
| References (name/company/email/phone/role/consent) | `freelancer_applications.references` |
| GDPR consent (scrollable) | `submission` JSONB + `tcs_version` |
| T&Cs consent + signature | `signature_r2_key`, `tcs_version` |

## 6. Flows

### 6a. Invite (two converging entry points)

**Both routes create/point at a `people` row at invite time** (as a shell if new), tag it
`is_freelancer=true`, and open a `freelancer_applications` row with `status='invited'`. The
form submission later **enriches this same person** — it never creates a duplicate.

1. **Existing contact** (already in address book): open their card → **"Invite to
   freelance"** button. Mints token on a new application row against that person.
2. **Brand new**: a **"New freelancer"** quick-add (name + email) that creates a
   lightweight person + application in one step. (Or add as a normal person first, then
   invite — both work.)

The invite action returns: the intro email (sent to the freelancer, your
"many thanks for your interest…" copy) **and** a copyable tokenised link staff can paste
into WhatsApp/email themselves. URL shape: `${frontendUrl}/freelancer-apply/:token`.

Backend: `POST /api/freelancers/invite` (`{person_id?}` or `{first_name, last_name, email}`),
`POST /api/freelancers/applications/:id/resend`.

### 6b. Apply (public token page)

`/freelancer-apply/:token` — public, no Layout, mounted before the `ProtectedRoute` block.
- `GET /api/freelancers/apply/:token` → form context + validity (before auth gate,
  rate-limited).
- Renders all Jotform fields; the **driving block is conditional** on the "Driving" skill.
- Scrollable GDPR + T&Cs consent, signature pad. Files upload to R2.
- `POST /api/freelancers/apply/:token/submit`.

### 6c. Submit → enrich → alert

On submit: validate token → **enrich the linked person** (write mapped fields, append
files, encrypt PII) → store `submission`/`insurance_answers`/`references`/signature on the
application → set `status='applied'` → log a timeline interaction → fire the
**"this person wants to work for us — all good?"** email to `info@oooshtours.co.uk` with a
deeplink to the person's Freelancer tab. No new inbox surface.

### 6d. Review → decide

On the person's **Freelancer tab**, staff sees the submitted data (incl. insurance answers
+ references + documents) and acts:
- **Approve** → `is_approved=true`, `status='approved'`, stamp `freelancer_joined_date` +
  set `freelancer_next_review_date` (e.g. +1yr), spin up the onboarding checklist, send the
  approval email (WhatsApp group link + portal access + payments/how-to reference).
- **Decline** → `status='declined'`, `decision_notes`, send decline email.
- **Request more info** → `status='more_info'`, re-opens the token, send more-info email.

Backend: `POST /api/freelancers/applications/:id/{approve|decline|request-info}`
(admin/manager-gated — see §10).

### 6e. Onboard (checklist)

A checklist card on the Freelancer tab. Some ticks are manual, some auto-fire:

| Item | Backing | Auto? |
|---|---|---|
| Reviewed & approved | application status | (set by Approve) |
| Added to vehicle insurance | `is_insured_on_vehicles` | manual tick |
| T-shirt given | `has_tshirt` | manual tick |
| Portal access sent | `onboarding` JSONB | auto email (portal register link) |
| Payments policy / how-to available | (reference doc in portal) | informational, no click-to-agree |
| Training docs shared | `share_with_freelancer` docs | manual/auto |

**Payments policy is all-in-one**: the T&Cs signed at application already cover payment
terms; the "how to invoice" doc is an informational reference we surface in the portal's
My Documents. No separate click-to-agree step.

## 7. Surfaces

- **Freelancer tab on Person Detail** — new tab (added to the conditional tab array in
  `PersonDetailPage.tsx`, gated on `isFreelancer`). Consolidates status, onboarding
  checklist, skills, day-rate note, documents + expiry dates, insurance answers,
  references, review date — **lifting this out of the buried "Edit" section**.
- **Pending tag + People filter** — pending freelancers get a status badge; the People
  page gains a "pending applications" filter (reuses existing `is_freelancer` +
  `is_approved` query params). Optional small NeedsAttention dashboard bucket so an
  application doesn't get lost behind the info@ email.
- **Greyed-out picklists** — crew & transport pickers currently filter
  `is_freelancer=true AND is_approved=true` (`routes/quotes.ts` ~line 1887 + assignment
  candidate selects). Relax to return pending freelancers too, with `is_approved` per row,
  so the frontend renders them **disabled/greyed with a "pending approval" note**.
- **Portal "My Documents"** — a new section in the freelancer portal (Next.js app)
  surfacing shared training/how-to docs via `share_with_freelancer`. *Check whether the
  existing `178_staff_documents.sql` migration is a home or neighbour for this before
  building.*

## 8. Document-expiry reminders

A daily `cron.schedule` task (new slot in `config/scheduler.ts`, e.g. 09:xx) mirroring
`compliance-checker.ts`:
- Scan `people WHERE is_freelancer=true` for approaching `licence_expiry`,
  `dvla_check_date` (recheck cadence), `passport_expiry`, `pli_expiry`,
  `freelancer_next_review_date`.
- Classify against configurable warning/urgent thresholds (months/days), dedup like the
  vehicle checker.
- Fire bell + email so staff chase the freelancer well before expiry.

`freelancer_next_review_date` already has a partial index (`idx_people_freelancer_review`)
suited to this.

## 9. Email templates (new, in `services/email-templates/index.ts`)

All ship **off** the `EMAIL_LIVE_TEMPLATES` allowlist (test-redirect until released):
- `freelancer_invite` (client) — the intro/"many thanks" copy + form link.
- `freelancer_application_received` (internal) — to info@, "all good?" + deeplink.
- `freelancer_approved` (client) — WhatsApp link + portal access + payments/how-to reference.
- `freelancer_declined` (client).
- `freelancer_more_info` (client) — re-opened link + what's needed.
- `freelancer_document_expiry` (internal) — the reminder-scanner alert.

These are entity-scoped (a person, not a job), so the HH-job-number-in-subject convention
does not apply.

## 10. Security / RBAC / PII

- Public apply endpoints sit **before** the auth gate, rate-limited (carnet/OOH pattern).
- Invite / review / approve / decline endpoints: `STAFF_ROLES` to invite; **approve/decline
  gated to `MANAGER_ROLES`** (money/booking consequence) — confirm the exact tier with jon.
- PII (DOB, address, licence number, DVLA data) encrypted via the AES-GCM dual-column
  pattern, decrypted only in the admin response layer. References' contact details treated
  as PII too.
- Token minting via `crypto.randomBytes(24).toString('base64url')`.

## 11. iDenfy ID-check seam (DEFERRED)

Leave a clean, pluggable step in the flow for an automated ID/licence check. **Do not build
against iDenfy now** — Ooosh is moving off iDenfy for the driving-licence process over
Christmas; this hook gets filled alongside that migration. For now the DVLA-summary +
licence uploads are reviewed manually.

## 12. Phased build order

1. **Phase A — Data + invite** (migration 184: `freelancer_applications` + new person
   columns; invite endpoints; token minting; invite UI buttons + "New freelancer" quick-add;
   invite email template).
2. **Phase B — Apply** (public `/freelancer-apply/:token` page + get/submit endpoints +
   enrich + info@ alert + application-received template).
3. **Phase C — Review + surfaces** (Freelancer tab; approve/decline/more-info; onboarding
   checklist; pending tag + People filter; greyed picklists; approval/decline/more-info
   templates).
4. **Phase D — Reminders + portal docs** (document-expiry scanner; portal "My Documents"
   section).
5. **Phase E — iDenfy** (deferred to the Christmas iDenfy migration).

## 13. Decisions locked (jon, build kickoff)

- **RBAC:** invite / input a new freelancer = **STAFF_ROLES** (anyone on the team).
  Approve / decline = **MANAGER_ROLES** (incl. weekend_manager). Enforced structurally
  in `middleware/auth.ts` (`authorize` treats weekend_manager ≡ manager).
- **Training docs home:** `178_staff_documents.sql` **is** where all training/general-info
  docs are built. A subset gets shared to the freelancer portal's **"Resources"** section
  (portal terminology = "Resources", not "My Documents") via `share_with_freelancer`.
- **Declined + expired in picklists:** grey out with the **reason** shown — `declined`
  greyed "declined", document-expired greyed "expired" (see §14 eligibility model).
- **Re-invite / annual re-consent:** new `freelancer_applications` row each time (history
  preserved). Re-send the same form **pre-filled** with the last answers, flagging anything
  overdue / expired / expiring within 12 months. Trigger the re-invite email ~1 month before
  the annual review date, weekly nudge, block ("reattestation overdue") at the review date if
  not re-attested.
- **Onboarding state storage:** small `onboarding JSONB` on `people` for the bits without a
  column (portal-invite-sent, resources-shared); reuse the existing `has_tshirt` /
  `is_insured_on_vehicles` booleans directly.

## 14. Eligibility, removal & renewal (design, from jon's sanity checks)

**Eligibility is separate from approval.** `is_approved` = the manager's approval decision
(stays true once approved — we haven't sacked them). A **document-derived eligibility** is
computed from the expiry-date columns: an expired driving document (licence / DVLA check /
passport where relevant) greys the freelancer out of driving pickers with a **"licence
expired"** reason, and auto-clears the moment a new valid date is entered. So the greying
mechanism is shared across states, each with a reason: **pending / declined / expired /
reattestation overdue**. (v1: expired driving docs block driving work specifically; a
role-aware refinement for non-driving work is a later slice.)

**Removal — two tiers.** Soft "off the books" = untick `is_freelancer` (reverts to an
ordinary contact, drops out of all freelancer pickers, history preserved; stamps
`freelancer_removed_at` / `freelancer_removed_reason` for audit, closes any open
application). Hard "never again" = the existing **Do Not Hire** flag (red banner,
admin-set, audited).

**Renewal timeline** (annual, driven by `freelancer_next_review_date`): re-invite email
~1 month before the review date → weekly nudge → if not re-attested by the review date,
greyed "reattestation overdue" + blocked until they re-submit. Document-expiry (licence /
passport / DVLA) is a **separate** clock — chased before the specific document lapses; a
lapse greys the freelancer for the affected work type. Both feed the same greying surface.

## 15. Build status

- **Phase A — SHIPPED (this PR):** migration 184 (`freelancer_applications` + all new
  `people` columns — status denorm, `onboarding` JSONB, removal audit fields, document
  expiry dates, preferred name, day-rate note); backend `routes/freelancers.ts`
  (`POST /invite` [existing-person or new-shell], `POST /applications/:id/resend`,
  `GET /applications`); `freelancer_invite` email template (client variant, test-mode
  routed). Reuses existing person columns discovered during build (`has_tshirt`,
  `is_insured_on_vehicles`, `freelancer_references`, `emergency_contact_name/phone`,
  `date_of_birth`, `home_address`, `licence_details`).
- **Phase B — NEXT:** invite UI (Person Detail button + New-Freelancer quick-add), pending
  tag on People, greyed picklist entries; the public `/freelancer-apply/:token` form +
  submit → enrich → info@ alert.
- **Phases C–E:** review/approve + Freelancer tab + onboarding checklist; document-expiry
  reminder scanner + portal Resources; iDenfy (deferred to the Christmas migration).
