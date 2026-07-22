# Staff Documents & Training — Module Spec

**Status:** Proposed (Jul 2026). Not yet built.
**Branch (spec):** `claude/capital-card-agreement-892gu3`
**First migration:** take the next free at build time (**177** at time of writing — latest is 176).

## 1. What this is

A staff-facing **Documents & Training** area inside OP: the single place where
staff read, acknowledge, and sign the documents the business needs them to —
policies, agreements, training material, official docs, and (eventually) their
employment contract. Each document declares, per instance, how "done" is defined
(read-only / tick / sign), who it applies to, and how it's chased, reviewed, and
escalated over time.

**First concrete instance:** the **Capital on Tap (COT) company-card Authorised
User Agreement** — the two new card-holders need to sign it, and it wants an
annual re-sign. It hangs off the existing **COT Card Register**
(`users.cot_card_label`, migration 148). The full module is built now with the
card agreement as its Phase 1 payload (jon's call, Jul 2026).

### The bigger picture (umbrella, not this spec's scope)

This is **pillar 1 of a future "Staff" section**. Over the following weeks it
grows to a holistic staff hub — **holiday and TOIL requests fold in as sibling
modules** under the same nav group. So we introduce a **"Staff" nav group now**
(with "My Documents" for everyone + a "Documents" admin surface for
admin/manager), and holiday/TOIL slot in alongside later. Design the nav + the
`staff_*` table-name convention with that in mind; don't build holiday/TOIL here.

### Deliberately NOT in this spec

- Holiday / TOIL request workflow (sibling module, later).
- Quizzes / scored training attestation (a tick that "I completed the training"
  is enough for v1).
- Freelancer (People) participation — **Users first** (jon's call). The schema
  is shaped so a People/portal-delivered variant is a later slice, not a rebuild
  (see §9).

## 2. You've already built this twice — reuse, don't reinvent

| Mechanic | Existing OP code to model on |
|---|---|
| Versioned document, one "current" version | `storage_tcs_versions` (migration 093) |
| Acceptance record: signature PNG → R2, snapshot PDF → R2, IP/user-agent captured | `storage_tcs_agreements` + `services/storage-tcs-pdf.ts` |
| Drawn-signature capture UI | `frontend/src/modules/vehicles/components/book-out/SignatureCapture.tsx` (also used by carnet + hire form) |
| "This expires, redo it on a cadence" reminders | compliance reminders, storage rate-review, freelancer `next_review_date` |
| Nudge-until-done delivery (bell → escalate to email) | inbox/notification escalation system (Step 7) |
| Per-event dedup stamp so a scanner doesn't spam | COT receipt chaser `receipt_chase_sent_at`, sanity-scanner markers |
| The COT card scheme itself | COT Card Register (`users.cot_card_label`) + COT receipt chaser (migration 148) |

The module is essentially **the Storage T&Cs machinery, pointed at staff
(`users`) instead of clients, made assignable + renewable + chaseable**, with a
per-instance choice of completion mode.

## 3. Data model (migration 177)

Four tables, `staff_documents` prefix. Parent → versions (preserve history) →
per-user assignment (the tracker) → immutable completion records (every signing
event kept for audit).

```sql
-- ── The document (policy / agreement / training / contract-type) ──────────────
CREATE TABLE staff_documents (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  VARCHAR(80) UNIQUE NOT NULL,       -- e.g. 'cot-card-agreement'
  title                 VARCHAR(200) NOT NULL,
  category              VARCHAR(40) NOT NULL DEFAULT 'policy',
                        -- policy | agreement | training | official_doc | contract | other
  completion_mode       VARCHAR(20) NOT NULL DEFAULT 'read_only',
                        -- read_only | tick | sign
  tick_label            VARCHAR(200),                      -- tick mode: e.g. "I have read and agree"
  visibility            VARCHAR(20) NOT NULL DEFAULT 'assignees',
                        -- everyone (library) | assignees (only those assigned) | owner_admin (owner + admin, e.g. contracts)
  -- Targeting rule: who this applies to. Materialised into staff_document_assignments.
  target_type           VARCHAR(20) NOT NULL DEFAULT 'list',
                        -- all_staff | role | list
  target_roles          TEXT[],                            -- when target_type='role'
  -- Chase / review / escalation config (set per document at creation):
  chase_interval_days   INT,                               -- NULL = no active chasing (passive pending only)
  escalate_after_days   INT,                               -- NULL = never escalate; else notify managers/admin
  review_interval_months INT,                              -- NULL = complete once forever; else re-require every N months
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Versions (editing content = new version; completed users get re-flagged) ──
CREATE TABLE staff_document_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES staff_documents(id) ON DELETE CASCADE,
  version         INT NOT NULL,                            -- 1, 2, 3…
  body            TEXT,                                    -- markdown/HTML content (nullable if file-only)
  file_r2_key     TEXT,                                    -- uploaded PDF/doc (nullable if body-only)
  file_name       VARCHAR(200),
  change_note     TEXT,                                    -- "what changed" for the audit trail
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  is_current      BOOLEAN NOT NULL DEFAULT FALSE,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- CHECK: at least one of body / file_r2_key present (enforced in app)
);
CREATE UNIQUE INDEX idx_staff_doc_versions_current
  ON staff_document_versions(document_id) WHERE is_current = TRUE;
CREATE UNIQUE INDEX idx_staff_doc_versions_num
  ON staff_document_versions(document_id, version);

-- ── Per-user assignment (the "you need to do this" tracker + lifecycle) ────────
CREATE TABLE staff_document_assignments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id           UUID NOT NULL REFERENCES staff_documents(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                VARCHAR(20) NOT NULL DEFAULT 'pending',
                        -- pending | completed | lapsed  (lapsed = was completed, review interval elapsed)
  assigned_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_completion_id UUID,                              -- FK set after first completion (nullable)
  expires_at            TIMESTAMPTZ,                        -- completed_at + review_interval_months (NULL if one-off)
  -- scanner dedup stamps (mirror the receipt-chaser / sanity-scanner pattern):
  chase_sent_at         TIMESTAMPTZ,                        -- last pending chase to the user
  escalated_at          TIMESTAMPTZ,                        -- last escalation to managers/admin
  review_reminder_sent_at TIMESTAMPTZ,                      -- last "coming up for renewal" nudge
  UNIQUE (document_id, user_id)
);
CREATE INDEX idx_staff_doc_assign_user   ON staff_document_assignments(user_id);
CREATE INDEX idx_staff_doc_assign_status ON staff_document_assignments(status);

-- ── Immutable completion records (one per signing/ticking event — audit) ──────
CREATE TABLE staff_document_completions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id   UUID NOT NULL REFERENCES staff_document_assignments(id) ON DELETE CASCADE,
  version_id      UUID NOT NULL REFERENCES staff_document_versions(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  mode            VARCHAR(20) NOT NULL,                    -- tick | sign (snapshot of how it was completed)
  completed_by_name VARCHAR(200) NOT NULL,                 -- typed / on-file name at completion
  completed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signature_r2_key TEXT,                                   -- drawn signature PNG (sign mode)
  pdf_r2_key      TEXT,                                    -- signed snapshot PDF (doc text + who/when/IP + signature)
  ip_address      VARCHAR(60),
  user_agent      TEXT
);
CREATE INDEX idx_staff_doc_completions_assign ON staff_document_completions(assignment_id);

ALTER TABLE staff_document_assignments
  ADD CONSTRAINT fk_staff_doc_assign_completion
  FOREIGN KEY (current_completion_id) REFERENCES staff_document_completions(id);
```

**Why assignments + completions are separate:** the assignment row is the live
"who must / current status" tracker (flips pending↔completed↔lapsed, carries the
chase/escalation dedup stamps). The completion table is an **immutable log** —
one row per signing event, so a re-sign against a new version (or an annual
renewal) keeps *every* historical signature + PDF. Same shape as excess
(lifecycle row + immutable events) and the debt-chase tracker (one row per
event). `current_completion_id` points the tracker at the latest.

**Assignment materialisation:** `target_type` on the document is the *rule*; the
`staff_document_assignments` rows are the *materialised per-user list*. A resolver
(`syncDocumentAssignments(documentId)`) creates missing rows for the current
target set and is re-run when (a) a document is published/retargeted, (b) a new
staff user is created (for `all_staff`/`role` docs), (c) COT card issued (for the
card agreement — see §7). It never deletes a completed assignment (audit), only
adds pending ones; de-targeting a user leaves their history but stops chasing
(a `dismissed` status can be added later if needed).

## 4. Completion modes (the per-instance choice)

| Mode | Staff sees | Tracked? | Chased? | Use for |
|---|---|---|---|---|
| `read_only` | The document to read; no button | No completion record | No | Reference material — wifi guide, org chart, "how we do X" |
| `tick` | "☐ `tick_label`" + Confirm | Completion row, `mode='tick'`, no signature | Yes (if `chase_interval_days` set) | "I have read this" receipts, training-completed attestations, light agreements |
| `sign` | Document + drawn-signature pad + Confirm | Completion row + signature PNG + snapshot PDF | Yes | Card agreement, employment contract, anything wanting a real signature |

`tick_label` is free text so the same mode covers both a soft "I have read this"
and a firmer "I have read and agree to the above." Read-only docs can still live
in the library and be re-classified to `tick`/`sign` later (adds pending
assignments to the target set on the next resolver run).

## 5. Chase / review / escalation (per-document config)

All three configured at document creation, all **non-blocking soft nudges**
(house style — warnings, never a hard gate):

- **Chase** (`chase_interval_days`): while an assignment is `pending`, the daily
  scanner nudges the user (bell + email per their notification prefs) no more
  often than this. `chase_sent_at` dedups. `NULL` = no active chasing (the doc
  still shows in their "To do", just doesn't ping).
- **Escalate** (`escalate_after_days`): if still `pending` this long after
  `assigned_at`, notify managers/admin (bell + info@ email) that staff X hasn't
  completed doc Y. `escalated_at` dedups. `NULL` = never escalate.
- **Review** (`review_interval_months`): on completion, `expires_at =
  completed_at + N months`. The scanner sends a "coming up for renewal" nudge
  ahead of expiry (`review_reminder_sent_at` dedups), and on expiry flips the
  assignment to `lapsed` + re-opens a fresh `pending` cycle against the current
  version. `NULL` = sign once forever (until a new version supersedes it).

**Version supersession:** publishing a new `is_current` version flips completed
assignments whose completion is against an older version back to `pending` (with
a "document updated — please re-read/re-sign" nudge). Read-only docs just show
the latest — no re-flag.

**Scheduler task** (`services/staff-document-reminders.ts`, daily ~09:20
Europe/London, one pass): chase pending, escalate stale-pending, renewal-nudge
approaching-expiry, lapse the expired + re-open. Gate on `users.is_active` (a
deactivated staff member isn't chased). Stamp-dedup-first, then send (the
established sanity-scanner convention — a transient send failure shouldn't
re-fire next run).

## 6. Surfaces

### Staff — "My Documents" (Profile / new Staff nav, all roles)
Three sections:
- **To do** — `pending` + `lapsed` assignments, soonest/oldest first, each opening
  the read → tick/sign flow. Expiring-soon flagged amber.
- **Completed** — with a **download of their own signed PDF** per completion, and
  the date + version signed.
- **Reference library** — `read_only` + `everyone`-visibility docs to browse.

Plus: an **inbox notification** when a doc is assigned, chased, or approaching
renewal; and an optional persistent **banner** (à la the portal MuteBanner) while
anything's outstanding — kept a nudge, not a lockout.

### Admin — Document management (admin/manager)
- **Library CRUD + versioning**: create/edit documents, upload a new version
  (with change note), set completion mode / targeting / chase / review /
  escalation, retire.

  **Authoring model (decided Jul 2026 — "Option A"):** documents are DATA, not
  code — authored/edited in-app, no deploy. Two paths per document:
  1. **Inline body** — typed in OP as **markdown-lite** (bold, headings,
     numbered/bullet lists, links), rendered by `frontend/src/components/
     MarkdownLite.tsx` (also used for the admin editor's live preview). Best for
     text policies/agreements; minor tweaks = edit → publish new version.
  2. **Uploaded file** — a finished PDF authored anywhere (Google Docs, etc.)
     uploaded as the version (`file_r2_key` + `file_name`). Best for anything
     graphic-heavy or laid-out — no fighting an editor.
  The signed snapshot PDF renders **text only**, so keep *signable* documents to
  markdown/text; put anything visual in read-only guides or uploaded PDFs. Full
  WYSIWYG + inline images in the in-app editor was considered ("Option B") and
  deferred — upload-a-PDF covers the visual case without the PDF-rendering
  weight. The admin editor (PR 4) is a markdown textarea + live preview + a
  file-upload alternative.
- **Completion matrix**: per document, who's completed / pending / lapsed, with
  filters + a "chase now" manual nudge. Per user, everything they owe.
- Lives under the **Staff** nav group (admin-gated child), sibling to the future
  holiday/TOIL admin.

### Dashboard
An admin-only **NeedsAttention bucket** — "N staff have outstanding documents"
(and "M documents lapsing this month") — click-through to the matrix. Follows the
`NABucket` registry pattern (§Dashboard in CLAUDE.md).

## 7. COT card agreement — Phase 1 payload + register tie-in

The first seeded document. Configured:
- `slug='cot-card-agreement'`, `category='agreement'`, `completion_mode='sign'`,
  `visibility='assignees'`, `target_type='list'`.
- `review_interval_months=12` (annual re-sign), `chase_interval_days=7`,
  `escalate_after_days=14`.
- Body = the wording in Appendix A (with the card last-4 + name merged in at
  render from the user's `cot_card_label` / `cot_card_last4`).

**Register integration:** the COT Card Register (Settings) already holds
`users.cot_card_label` + `cot_card_last4`. When an admin issues/sets a card label
for a user, `syncDocumentAssignments('cot-card-agreement')` auto-creates their
pending assignment. The register grows an **"Agreement signed?"** column
(✓ signed date / ⚠ outstanding) reading the assignment status — so "cards issued
but agreement unsigned" is visible right next to where cards are managed, and
next to the receipt-chase story it belongs with.

**Immediate practical note:** issuing the *actual* card happens in the Capital on
Tap portal (outside OP). In OP, adding the two new starters = giving them a
`cot_card_label` in the register, which now also seeds the agreement to sign.

## 8. Security / storage / RBAC

- **Signatures + snapshot PDFs** → **private R2** under `files/staff-documents/…`,
  authenticated download only (same as storage T&Cs — a signature image isn't
  public). Reuse `services/storage-tcs-pdf.ts` as the PDF template basis.
- **Uploaded document files** (training PDFs, contracts) → private R2, served via
  the authenticated `/api/files/download` allowlist (extend the prefix list).
- **Contracts carry PII** (salary, address). Use `visibility='owner_admin'` so a
  contract is visible only to its owner + admin, never the whole library. If
  salary-grade data ends up stored as structured fields (out of scope here),
  route it through `services/encryption.ts` — but a PDF in the private bucket +
  `owner_admin` visibility is the v1 baseline.
- **RBAC**: any staff (`STAFF_ROLES`) can view/complete their own assignments +
  browse `everyone` docs. Library management (create/version/target/matrix) is
  `MANAGER_ROLES` (admin + manager + weekend_manager per the OP alias rule). Use
  the shared `STAFF_ROLES` / `MANAGER_ROLES` constants + `hasManagerRole()`
  frontend helper — never bare role strings.
- **Audit**: document create/version/retarget + every completion logged to
  `audit_log`. Completion also captures IP + user-agent on the immutable row.

## 9. Users now, People later (the expansion seam)

v1 is **`users`-only** — the completion/assignment FKs are `user_id`. The People
(freelancer) expansion — e.g. a data-handling or kit policy freelancers sign via
the **portal** — is a later slice, and the seam is deliberate:
- Add a nullable `person_id` alongside `user_id` on assignments/completions (a
  `subject_type` discriminator, or simply "exactly one of user_id/person_id set"),
  OR a parallel `person`-scoped assignment path that reuses the same documents +
  versions + PDF machinery.
- Delivery differs (staff = in-app + bell/email; freelancers = portal, no bell —
  matches the portal-notification-prefs split), which is why it's a separate
  slice, not a v1 column.

Don't build the People path now. Just don't hardcode anything that assumes the
subject is always a `user` beyond the FK (keep the resolver + reminder queries
parameterised on a subject).

## 10. Build order

1. **Migration 177** — the four tables + seed the COT card document (v1) +
   `/api/files/download` prefix allowlist for `files/staff-documents/`.
2. **Backend** — `routes/staff-documents.ts` (`/api/staff-documents/*`): document
   + version CRUD (MANAGER_ROLES), `syncDocumentAssignments` resolver, "my
   documents" reads (STAFF_ROLES), the complete endpoint (tick/sign → R2 signature
   + snapshot PDF via a new `services/staff-document-pdf.ts` modelled on
   `storage-tcs-pdf.ts`), completion matrix reads. Wire new-user creation +
   COT-card-set to call the resolver.
3. **Scheduler** — `services/staff-document-reminders.ts` (chase / escalate /
   renewal / lapse), added to `config/scheduler.ts` daily ~09:20.
4. **Frontend — staff** — "My Documents" (Profile or Staff nav): To do / Completed
   / Reference; the read → tick/sign flow reusing `SignatureCapture`; inbox
   notification + optional banner.
5. **Frontend — admin** — library CRUD + versioning + completion matrix under a
   new **Staff** nav group; COT Card Register "Agreement signed?" column.
6. **Dashboard** — admin NeedsAttention bucket.
7. Seed + verify the **COT card agreement** end-to-end (assign the two new
   starters, sign, snapshot PDF, annual expiry set). This IS the acceptance test.

Each of 1–7 is a shippable slice; 1–4 + 7 is the minimum for the card agreement
to be live.

## 11. Conventions worth remembering (for the build + future work)

- **`staff_*` table prefix + a "Staff" nav group** — this module is pillar 1;
  holiday/TOIL join the same group. Name/organise accordingly.
- **Completion is per-instance-configured, not hardcoded** — mode (read/tick/sign)
  + chase + review + escalate all live on the document row, set at creation. A new
  document type = a row, not code.
- **Immutable completions, mutable assignment** — never overwrite a completion;
  every sign/renew is a new row. The assignment tracks current status + dedup
  stamps only.
- **Scanner discipline** — stamp-dedup-first then send; gate on `is_active`; one
  daily pass; mirror the receipt-chaser / sanity-scanner shape.
- **Soft nudge, never a gate** — outstanding docs warn + chase + escalate; they
  never block login or any action (OP house style).
- **Private R2 + authenticated download** for signatures/PDFs/contract files;
  `owner_admin` visibility for anything with PII.
- **Reuse** `storage-tcs-pdf.ts` (PDF), `SignatureCapture.tsx` (pad), the
  notification/escalation system (delivery), the COT Card Register (Phase 1
  anchor). This is a generalisation, not a greenfield.

---

## Appendix A — COT company-card agreement wording (draft)

Merge `[name]` and `[last 4]` at render from the user's `cot_card_label` /
`cot_card_last4`. Tune the limit / approval line (§3) to the real policy.

> **Ooosh Tours — Company Card (Capital on Tap) Authorised User Agreement**
>
> I, **[name]**, have been issued a Capital on Tap company card (ending
> **[last 4]**) for use in my role at Ooosh Tours. I understand and agree that:
>
> 1. **Business use only.** The card is for legitimate Ooosh business expenses
>    only. I will not use it for personal, cash-withdrawal, or non-business
>    spending.
> 2. **Receipts, promptly.** I will obtain a valid VAT receipt or invoice for
>    every transaction and submit it (via the Operations Platform / to the office)
>    **within 3 working days**. I understand unlogged spend will be chased and may
>    be treated as a personal charge until evidenced.
> 3. **Within limits.** I will stay within any spending limit set on my card and
>    seek manager approval before any large or unusual purchase.
> 4. **Keep it secure.** I will keep the card, PIN and card details secure, will
>    not share them with anyone, and will not let anyone else use my card.
> 5. **Report problems immediately.** I will tell the office at once if the card is
>    lost, stolen, or if I notice any transaction I don't recognise.
> 6. **Accidental or personal spend.** If I use the card in error or for anything
>    not clearly business, I will flag it straight away and repay Ooosh promptly.
> 7. **Return on request.** The card remains the property of Ooosh Tours. I will
>    return it (or confirm its destruction) when I leave the company or whenever
>    asked.
> 8. **Capital on Tap terms.** I understand my use is also governed by Capital on
>    Tap's Authorised User Terms and Conditions, and that Ooosh Tours is
>    financially responsible to Capital on Tap for my card activity.
>
> I confirm I have read and agree to the above.
>
> Signed: ___________   Date: __________

The 3-working-day receipt window matches the existing COT receipt chaser's 3-day
grace (migration 148) — keep them aligned if either changes.
