# ATA Carnet Management — Implementation Spec

**Status:** Drafted Jun 2026. Building across multiple sessions.
**Replaces:** Monday.com carnet tracking + the standalone Jotform carnet request form (`form 243083554868063`).

### Build progress
- [x] **Slice 1 — Foundation (this PR):** migration 135 (`job_carnets` + `carnet_gmrs`), HH detection of sale item 575 in the derivation engine (auto-creates the `carnet` requirement card + a `job_carnets` record, mode=we_supply, status=detected; stale-cleanup wired), read-only `/api/carnets` endpoints.
- [ ] **Slice 2 — Client request form + signed-authority PDF** (public token page, the Letter of Authorisation, GMR seeding from crossings).
- [ ] **Slice 3 — Job Detail Carnet tab + GMR management** (custody surface, QR upload/send, document attachments, full CRUD).
- [ ] **Slice 4 — Send timing scheduler + email templates** (T-28d / on-confirmation / chase / ad-hoc).
- [ ] **Slice 5 — Operations overview page + dashboard NeedsAttention bucket.**

---

## Overview

Ooosh applies for **ATA Carnets** on clients' behalf for international (mostly EU) tours, charging an arrangement fee. The carnet is a customs document that lets equipment cross borders temporarily without paying import duties. We do the legwork: gather the client's details, get them to sign an authority accepting liability, apply to the issuing chamber, take custody of the physical carnet, hand it to the client, get it back, and discharge it by posting it back at the end.

This module moves that whole lifecycle off Monday + Jotform into OP, per-job, reusing patterns already proven elsewhere in the platform (HH-derived requirements, the driver hire-form client-facing flow, the excess "held for clients" custody surface, the requirement-card prep pip, the Operations overview + dashboard NeedsAttention bucket).

### Two modes — one record

A carnet can mean two different things to us. Both are modelled as one `job_carnets` row distinguished by `mode`, so the Operations overview is a single unified list.

| Mode | Meaning | How it starts | Lifecycle |
|---|---|---|---|
| **`we_supply`** | We apply for and arrange the carnet, charge the client. | **HH-detected** — sale item `575` ("Arrangement fee - provision of ATA Carnet", £750) present on the job. | Full lifecycle (form → authority → apply → custody chain → discharge). |
| **`client_arranges`** | Client arranges their own carnet; they just need our equipment list (a "thing to do"). | **Manual** — staff add a lightweight record. NOT HH-detected. | Minimal: Requested → Spreadsheet sent → Done, with a chase date. The equipment list itself stays in HireHop — we don't replicate it. |

**Scope is strictly per-HH-job.** A carnet often physically covers a whole tour (validity up to 12 months, re-used across an April leg and a November leg), but we do NOT model a tour-spanning entity. Once a carnet is created for a job, that's it — we track where the physical document is at the end of the job (with us, or with the client). When the client comes back for a later tour, the new job surfaces the existing carnet via the client's carnet history. The HH equipment/supply list is regenerated per job in HireHop and is out of scope for OP.

---

## Component 1: Database — Migration 103

### New table: `job_carnets`

```sql
CREATE TABLE IF NOT EXISTS job_carnets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                  UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,

  mode                    VARCHAR(20) NOT NULL DEFAULT 'we_supply'
                            CHECK (mode IN ('we_supply', 'client_arranges')),
  status                  VARCHAR(30) NOT NULL DEFAULT 'detected',
  format                  VARCHAR(10) NOT NULL DEFAULT 'paper'
                            CHECK (format IN ('paper', 'digital')),

  -- Custody snapshot (physical/digital document location). Auto-set on status
  -- transitions, manual override allowed. Drives the "held for clients" surface.
  custody_location        VARCHAR(10)
                            CHECK (custody_location IN ('ooosh', 'client', 'issuer')),

  -- ── Client form submission data (we_supply) ──
  carnet_length_months    INTEGER,            -- 2 | 6 | 12 (from form radio)
  carnet_start_date       DATE,               -- form "required start date"
  carnet_expiry_date      DATE,               -- derived: start + length
  liability_until         DATE,               -- derived: expiry + 18 months (per authority T&Cs)

  eu_countries            TEXT[] DEFAULT '{}', -- form EU checkbox list
  non_eu_countries        TEXT[] DEFAULT '{}', -- form non-EU checkbox list

  lead_name               TEXT,
  lead_email              TEXT,
  lead_role               TEXT,               -- "role in touring party" — shown as the client's
                                              -- role/designation on the authority (e.g. Driver)
  additional_names        JSONB DEFAULT '[]', -- [{ first, last }] — unlimited

  -- ── Workflow timestamps / refs ──
  application_ref         TEXT,               -- chamber/issuer reference
  applied_at              TIMESTAMPTZ,
  received_at             TIMESTAMPTZ,        -- carnet physically in our hands
  issued_to_client_at     TIMESTAMPTZ,
  returned_at             TIMESTAMPTZ,        -- client returned it to us
  discharged_at           TIMESTAMPTZ,        -- posted back to issuer
  closed_at               TIMESTAMPTZ,

  -- ── Client-facing form (we_supply) ──
  form_token              TEXT,               -- public tokenised URL
  form_sent_at            TIMESTAMPTZ,
  form_reminder_sent_at   TIMESTAMPTZ,
  form_submitted_at       TIMESTAMPTZ,        -- = authority signed (combined form)
  signed_authority_url    TEXT,               -- R2 key, generated PDF

  -- ── client_arranges minimal mode ──
  spreadsheet_requested_at TIMESTAMPTZ,
  spreadsheet_sent_at      TIMESTAMPTZ,
  chase_date               DATE,              -- for the lightweight reminder

  files                   JSONB DEFAULT '[]', -- scanned carnet pages, customs stamps, etc.
  notes                   TEXT,

  keep_after_close        BOOLEAN NOT NULL DEFAULT FALSE, -- lost/cancelled cleanup contract
  created_by              UUID REFERENCES users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One carnet per job in v1 (a job rarely needs two). Partial unique on live records.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_job_carnet_live
  ON job_carnets (job_id)
  WHERE status NOT IN ('cancelled');

CREATE INDEX IF NOT EXISTS idx_job_carnets_status ON job_carnets (status);
CREATE INDEX IF NOT EXISTS idx_job_carnets_token ON job_carnets (form_token) WHERE form_token IS NOT NULL;
```

### New table: `carnet_gmrs`

A carnet usually needs a **GMR** (Goods Movement Reference) per EU border crossing. Tours cross in and out multiple times, so this is an unbounded child list. We only track that each is **requested → made → sent to client** (NOT actual use at the border). Each GMR comes back as a **number plus a QR code** — we store both so staff can forward them to the client.

```sql
CREATE TABLE IF NOT EXISTS carnet_gmrs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carnet_id         UUID NOT NULL REFERENCES job_carnets(id) ON DELETE CASCADE,

  crossing_date     DATE,
  crossing_location TEXT,               -- free text — Dover/Calais/Folkestone/Eurotunnel/other
  direction         VARCHAR(10) CHECK (direction IN ('into_eu', 'out_of_eu')), -- optional

  status            VARCHAR(10) NOT NULL DEFAULT 'needed'
                      CHECK (status IN ('needed', 'made', 'sent')),
  gmr_reference     TEXT,               -- the GMR number
  qr_image_url      TEXT,               -- R2 key for the uploaded QR code image
  sent_to_client_at TIMESTAMPTZ,

  notes             TEXT,
  sort_order        INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_carnet_gmrs_carnet ON carnet_gmrs (carnet_id);
```

### Requirement type

The `carnet` requirement type is **already seeded** (migration 021). We keep it as the thin **prep-checklist pip** that deep-links into the Carnet module — exactly how the `vehicle` card nests/links to hire_forms + excess + the Money tab. Migration 103 may optionally `UPDATE requirement_type_definitions` to align the `steps` label set with the lifecycle below (cosmetic; the rich workflow lives in `job_carnets`, the card just mirrors a 4-state pip).

**Remember:** add `135_carnets.sql` to the hardcoded `migrations` array in `backend/src/migrations/run.ts`.

---

## Component 2: HH Detection (we_supply)

Detection mirrors **VE103B exactly** (`services/hh-requirement-derivation.ts`, item `1023`, same Misc Sale category 355). VE103B proves sale items surface in `items_to_supply_list.php` and are matched on `LIST_ID`.

```ts
// Arrangement fee — provision of ATA Carnet (sale item, cat 355, £750).
// Presence on a job = sales' signal that we're arranging a carnet.
const CARNET_ARRANGEMENT_LIST_ID = 575;
```

In `deriveFlags` / the derivation pass:
1. If a line with `LIST_ID === 575` is present, set `has_carnet = true` on the derived flags.
2. Ensure a `carnet` `job_requirement` exists (phase `pre_hire`, `is_auto: true`, `source: 'hirehop_sync'`).
3. Ensure a `job_carnets` row exists for the job (`mode='we_supply'`, `status='detected'`). Chain it the same way vehicle → hire_forms → excess chains: create-if-absent, never clobber staff progress, flag a mismatch if item 575 disappears after work has started (don't silently delete — staff may have already applied).
4. The requirement card status mirrors `job_carnets.status` → `not_started` / `in_progress` / `done` / `blocked` (see status map below).

**Sale-item push convention (for the future "staff adds the £750 mid-flow" case — NOT v1-critical, sales normally adds it):** `POST /api/save_job.php` with `items: JSON.stringify({ "b575": qty })`, `no_webhook: 1`, then a confirming `job_note.php`. Identical to `ve103b-hh.ts ensureVe103bCertItemOnJob`. (Note: the in-repo convention is the `b<stockId>` key form — the "leading a" the staging calculator uses lives in that separate repo; in OP we follow the VE103B `b` precedent.)

---

## Component 3: Client-facing request form + signed authority

The Jotform combines **info-gathering + Letter of Authority T&Cs + signature** into ONE submission. We replicate that as a single public tokenised page — no OP login — following the **driver-verification / OOH-parking / storage-T&Cs** public-token pattern (page mounted outside `<Layout>`).

### The form (ported from Jotform `243083554868063`)

| Field | Type | Notes |
|---|---|---|
| Quote / job number | text (prefilled) | We already know it — prefill, read-only. |
| Length of carnet | radio: 2 / 6 / 12 months | required → `carnet_length_months` |
| Required start date | date | required → `carnet_start_date` (drives expiry + liability) |
| EU countries travelling through | multi-checkbox (full EU list) | required → `eu_countries` |
| Non-EU countries | multi-checkbox + other | → `non_eu_countries` |
| Lead name | first/last | required → `lead_name` |
| Lead email | email | → `lead_email` |
| Role in touring party | text | required → `lead_role` — appears as the client's "Role / designation" on the authority (e.g. Driver) |
| Additional names | repeatable first/last | **unlimited** (Jotform capped at 6 — we don't) → `additional_names` |
| Need us to arrange GMR(s)? | radio Yes/No | seeds the GMR section |
| Crossings | repeatable: date + location | **unlimited** (Jotform capped at 2) → seeds `carnet_gmrs` rows (`status='needed'`) |
| Authority T&Cs | scrollable terms (verbatim text below) | must accept |
| Signature | signature pad | required → drives the signed-authority PDF |

### The generated Letter of Authorisation (exact wording — this is the canonical client-facing document)

The generated PDF is titled **"Letter of Authorisation"** with the Ooosh logo + company address block (Compass House, 7 East Street, Portslade, East Sussex, BN41 1DL, UK) and the submission date. It carries **two signature blocks**:

**Block 1 — Ooosh appoints the client as agent** (Ooosh-side signature, fixed from config):

> I, **{ooosh_signatory_name}**, of Ooosh! Tours Ltd, hereby appoint **{lead_name}** to be our agent for the purpose of dealing with and signing ATA Carnets, under the appropriate International Convention, and guaranteed by the appropriate Chamber of Commerce, and to deliver to Customs any documents in this connection.
>
> Signed: *{ooosh_signature_image}*
> Role / designation: **{ooosh_signatory_role}** *(e.g. Company Director)*

**Block 2 — Client accepts liability** (client-side signature, captured on the form):

> By this declaration I, **{lead_name}**, accept full responsibility for any charges, fees, taxes or similar that may become due by the use or misuse of said Carnet, and under no circumstances will Ooosh! Tours Ltd be held responsible for any such costs.
>
> This responsibility will last until the closure of the carnet in the usual timeframe (usually eighteen (18) months from the end date of the carnet).
>
> Signed: *{client_signature_image}*
> Role / designation: **{lead_role}** *(the touring-party role they entered, e.g. Driver)*

**Ooosh-signatory config** (the fixed Block 1 details — store in `system_settings`, edited from the Settings page, so the signatory/address can change without a deploy):
- `carnet_ooosh_signatory_name` (e.g. "Jonathan Wood")
- `carnet_ooosh_signatory_role` (e.g. "Company Director")
- `carnet_ooosh_signature_url` (R2 key — the stored director signature image stamped onto Block 1)
- `carnet_company_address` (the address block, default "Compass House, 7 East Street, Portslade, East Sussex, BN41 1DL, UK")

The PDF generator (`services/carnet-authority-pdf.ts`) stamps the fixed Block 1 (Ooosh signatory + signature image) and renders Block 2 with the client's captured signature. Reuses the jsPDF + logo-from-R2 pattern from `services/hire-form-pdf.ts` / the VE103B/condition-report PDFs (avoid the StandardFonts WinAnsi tick-encoding trap — render bullets/lines, not Unicode glyphs).

### On submission

- Write all fields to `job_carnets`; insert `carnet_gmrs` rows from the crossings (`status='needed'`).
- Compute `carnet_expiry_date = carnet_start_date + length`; `liability_until = expiry + 18 months`.
- Generate the **signed-authority PDF** (reuse the hire-form PDF + signature service pattern — `services/carnet-authority-pdf.ts`), store in R2, set `signed_authority_url`, append to the job's Files tab.
- `status` → `info_received`; `form_submitted_at = NOW()`.
- Bell + email the office that the authority is back (info@, via the email routing).
- Public-token validity is **status-bound** (reject once `status IN ('discharged','closed','cancelled')`), like the OOH parking token — no TTL juggling.

---

## Component 4: Backend API route — `routes/carnets.ts`

Mounted at `/api/carnets`, `STAFF_ROLES` gated, **except** the public token endpoints which are defined before the auth gate (mirrors `storage.ts` / `ooh-return.ts`).

**Staff endpoints:**
- `GET /` — Operations overview list (filter by mode/status/custody, search by job/client, date range)
- `GET /:id` — single carnet + GMRs + files
- `POST /` — manual create (used for `client_arranges`, and the rare manual `we_supply`)
- `PATCH /:id` — update status/custody/fields (every status change logs an interaction on the job timeline)
- `POST /:id/send-form` — send/resend the client request form to a picked recipient (via `resolveClientEmailTarget` / `job_contacts`)
- `POST /:id/gmrs` / `PATCH /:id/gmrs/:gmrId` / `DELETE /:id/gmrs/:gmrId` — GMR CRUD
- `POST /:id/gmrs/:gmrId/qr` — upload GMR QR image (`/api/files/upload?attachment_only=true` → `qr_image_url`)
- `POST /:id/gmrs/:gmrId/send` — mark GMR sent to client (emails number + QR)
- `POST /:id/files` / `DELETE /:id/files/:idx` — carnet document attachments
- `GET /by-organisation/:orgId` / `GET /by-person/:personId` — carnet history for address-book surfacing of re-used carnets

**Public (token) endpoints:**
- `GET /form/:token` — form context + validity
- `POST /form/:token/submit` — the combined submission above

**Status transitions** drive `custody_location` automatically (override allowed):
`received` → `ooosh`; `with_client` → `client`; `returned` → `ooosh`; `discharged` → `issuer`.

---

## Component 5: Send timing — auto-email scheduler

Reuse the **hire-form auto-email** pattern (`config/scheduler.ts`, daily ~09:00). Keyed off **hire/job start date** (the carnet's own start date isn't known until the form comes back):

- **T-28 days before job start** → auto-send the request form (we_supply, confirmed jobs only).
- **Confirmed inside 28 days** → send on confirmation (hook from `pipeline.ts`, `money.ts` payment-event, and the HH webhook — all three confirmation entry points, no gaps, same as hire forms).
- **Chase** if `form_sent_at` set but no `form_submitted_at` and job start approaching (e.g. T-14, T-7) → reminder email + `form_reminder_sent_at`.
- **Ad-hoc** "Send now" with picked recipient anytime (covers the "client asks 2 months out" case).
- **client_arranges** chase: `chase_date` due → bell/email per the lightweight reminder.

Window (28 days) configurable via `system_settings` (a "do X days before" knob, like the other requirement windows). Gate all scanners on the **lost/cancelled `keep_after_close` contract** (CLAUDE.md §"Lost / Cancelled cleanup pattern") — `pipeline_status NOT IN ('lost','cancelled') OR keep_after_close = true`.

---

## Component 6: Frontend

### 6a — Job Detail: Carnet tab/section
Appears only when a `job_carnets` record exists. Renders: mode/status/format header, the lifecycle stepper (warnings-not-gates — every step skippable, important for the paper→digital transition), client-form send/chase, submitted form data, custody control (the "held for clients" surface — where is it right now), GMR sub-list (add/edit/QR upload/mark-sent, with a "3 GMRs: 2 sent, 1 to make" rollup), document attachments, and the signed-authority PDF. The thin `carnet` **requirement card** on the Job Requirements (prep checklist) tab is the at-a-glance green/amber pip that deep-links here.

### 6b — Operations overview: `/operations/carnets`
Unified list of every carnet (both modes) with filter pills by status / custody / "GMRs outstanding" / "discharge overdue", search, and the standard section-registry treatment. Added to the Operations nav submenu.

### 6c — Dashboard NeedsAttention bucket: "Carnets"
Amber bucket surfacing outstanding work: form sent-not-returned with job approaching, info received-not-applied near carnet start, GMRs needed-not-made near a crossing, and **discharge overdue** (returned/expired but not discharged). Deep-links to `/operations/carnets` filtered. Follows the `NABucket` extension contract.

---

## Component 7: Email templates

New templates in `email-templates/index.ts` (all job-scoped → carry the HH job number per the house convention):
- `carnet_request` — client-facing, links to the public form (initial send).
- `carnet_request_chase` — reminder when form not returned.
- `carnet_authority_received_internal` — info@ alert that the signed authority is back.
- `carnet_gmr_details` — client-facing, forwards GMR number(s) + QR image(s).

Client emails route through `resolveClientEmailTarget` / `job_contacts` (with the info@ safety-net fallback). Internal alerts go to info@.

---

## Lifecycle / status reference

### `we_supply`
```
detected → form_sent → info_received → applied → received → with_client → returned → discharged → closed
                                                   (custody: ooosh)  (client)   (ooosh)   (issuer)
```
(Plus `cancelled`, terminal. `format='digital'` carnets may skip `received`/`with_client`/`returned` physical steps and go info_received → applied → discharged.)

**Requirement-card status map:** `detected`/`form_sent` → not_started; `info_received`/`applied`/`received`/`with_client`/`returned` → in_progress; `discharged`/`closed` → done; (a flagged mismatch or blocked-by-staff) → blocked.

### `client_arranges`
```
requested → spreadsheet_sent → done   (+ cancelled)
```

---

## Data flow summary

```
Sales adds item 575 (£750) to HH job
  → 30-min sync / webhook / on-demand sync derives has_carnet
  → OP auto-creates carnet requirement card + job_carnets (we_supply, detected)
  → T-28d (or on confirmation if sooner): carnet_request email → client
  → Client opens public form, fills details + signs authority
  → OP stores data, seeds GMRs, generates signed-authority PDF (→ Files tab), status=info_received
  → Staff apply to chamber (status=applied, ref stored)
  → Carnet arrives (status=received, custody=ooosh — "held for client" surface)
  → Given to client (status=with_client, custody=client)
  → GMRs made: staff add number + QR, send to client (carnet_gmr_details email)
  → Client returns carnet (status=returned, custody=ooosh)
  → Posted back to issuer (status=discharged, custody=issuer)
  → status=closed (liability_until tracked, ~18 months)

Money: the £750 is item 575 in HireHop → naturally surfaces on the OP Money tab. No OP cost tracking.
```

---

## Files to create / modify

**Create:**
- `backend/src/migrations/135_carnets.sql`
- `backend/src/routes/carnets.ts`
- `backend/src/services/carnet-authority-pdf.ts`
- `backend/src/services/carnet-auto-email.ts` (or extend the hire-form auto-email scheduler)
- `frontend/src/pages/CarnetsPage.tsx` (Operations overview)
- `frontend/src/pages/CarnetFormPage.tsx` (public token form, outside Layout)
- `frontend/src/components/CarnetSection.tsx` (Job Detail tab)
- `frontend/src/components/dashboard/v2/sections/` bucket addition

**Modify:**
- `backend/src/migrations/run.ts` (add 103 to the array)
- `backend/src/services/hh-requirement-derivation.ts` (item 575 detection + chaining)
- `backend/src/config/scheduler.ts` (send/chase timing)
- `backend/src/services/email-templates/index.ts` (4 templates)
- `backend/src/routes/index.ts` (mount `/api/carnets`)
- `backend/src/routes/dashboard.ts` (NeedsAttention `carnets` bucket)
- `frontend/src/App.tsx` (routes), `frontend/src/components/Layout.tsx` (Operations nav)
- `frontend/src/pages/JobDetailPage.tsx` (Carnet tab), `RequirementCard.tsx` (carnet pip)
- pipeline.ts / money.ts / webhooks.ts confirmation hooks (on-confirmation send)

---

## Constants

```
CARNET_ARRANGEMENT_LIST_ID = 575     // HH sale item, £750, Misc Sale cat 355
CARNET_SEND_WINDOW_DAYS    = 28      // configurable via system_settings
CARNET_LIABILITY_MONTHS    = 18      // expiry + 18mo, per authority T&Cs
```

---

## Open items / build-time checks (non-blocking)

- **Verify item 575 in the line-item payload.** VE103B (1023, same category) confirms sale items surface in `items_to_supply_list.php` on `LIST_ID` — confirm 575 behaves identically against a real job before wiring detection.
- **Optional:** align the `carnet` requirement type's seeded `steps` (migration 021) to the lifecycle labels — cosmetic only.
- **Future (deliberately deferred):** OP-generated equipment schedule for the application (left in HireHop — it does this fine today); tour-spanning carnet entity (per-job is enough); GMR border-use tracking (we only track requested → made → sent).
