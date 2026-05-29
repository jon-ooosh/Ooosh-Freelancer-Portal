# Client Storage — Implementation Spec

**Status:** Scoping → ready to build (Phase 1)
**Branch:** `claude/storage-clients-module-D0bqY`
**Replaces:** The Monday.com "Storage Clients" board
**Dependencies:** Address book (People/Organisations) ✓, Email service ✓, R2 file storage ✓, Inbox/notification system ✓, Scheduler ✓, signature/agreement pattern (OOH parking form / hire forms) ✓. New: optional Xero recurring-invoice awareness (read-only, future), PII encryption layer for door codes (see §9).

---

## Overview

Ooosh rents out **~20 storage rooms** of varying size to clients to store their gear long-term. This is a recurring-revenue business stream that is **deliberately NOT tracked in HireHop** — there's no per-month book-in/book-out, it's a standing tenancy. Some clients are on Xero recurring invoices; others are billed periodically and need a manual reminder to invoice them.

This module is a **standalone, OP-native module** — no HireHop integration. It reuses the address book (clients are Organisations/People), the notification + scheduler infrastructure, the email service, and the public-accept-link + e-signature pattern already used for OOH returns and hire forms.

It is explicitly **separate from temp storage / incoming deliveries** (see §10 for the boundary) — that's a different, item-centric, job-adjacent concern.

### The five things this module does

1. **Rooms** — a catalogue of the ~20 rooms (size, access, photos, status) that doubles as the reference sheet when an enquiry comes in.
2. **Tenancies** — who's in which room, since when, at what rate, on what billing/review cadence, with what access list and signed T&Cs. Includes ex-clients (move-out history).
3. **Billing & rate-review reminders** — nudge the right person to send an invoice / review a rate, on the right cadence. Replaces the Monday "remind me" mechanism.
4. **Access requests** — the "someone's coming to collect X" / "get the guitar out and courier it" pinch point: log it, notify, track that it's been done, and check the visitor is allowed.
5. **Waiting list** — clients who want storage while we're full, with their size preference and offer history.

---

## Component 1: Rooms (`storage_rooms`)

A mostly-static reference table — the ~20 physical rooms. Doubles as the "what have we got?" repo for enquiries.

| Field | Notes |
|---|---|
| `id` | UUID |
| `name` / `code` | Display name (e.g. "Room 3", "Container B") |
| `size_category` | `small` / `medium` / `large` / `xl` (picklist) — drives waiting-list matching |
| `dimensions` / `area_sqft` | Free text + optional numeric, for enquiry quoting |
| `access_type` | `door_code` / `we_hold_key` / `client_key` |
| `access_code` | **Encrypted** (see §9). The door code. Admin/manager read only. |
| `key_location` | Where our copy of the key lives, if `we_hold_key` |
| `description` | Free text — useful detail for enquiries |
| `photos` | JSONB — stock photos (R2 keys) for showing prospects |
| `status` | `available` / `occupied` / `reserved` / `out_of_use` — **derived** from active tenancy where possible, manually overridable for reserved/out-of-use |
| `notes` | Free text |
| `is_active` | Soft-delete |

`status` is the spine of "which rooms are empty right now". Where a room has an active tenancy it reads `occupied`; otherwise `available` unless manually set `reserved` (held for an incoming client) or `out_of_use`.

---

## Component 2: Tenancies (`storage_tenancies`)

The heart of the module. The link between a room and a client over a period. One room → many tenancies over time (current + historical ex-clients).

| Field | Notes |
|---|---|
| `id` | UUID |
| `room_id` | FK → `storage_rooms` |
| `organisation_id` | FK → `organisations` (the storage client) |
| `lead_contact_person_id` | FK → `people` — mirrors the job → org → contact pattern |
| `status` | `reserved` / `active` / `notice` (moving out) / `ended` |
| `move_in_date` | DATE |
| `move_out_date` | DATE, null while active |
| `weekly_rate` | DECIMAL — current rate per week |
| `billing_mode` | `recurring` (Xero handles it, we just track it exists) / `manual` (we invoice periodically) |
| `billing_cadence` | `monthly` / `quarterly` / `annual` / `custom` |
| `next_bill_date` | DATE — drives the manual-billing reminder (manual mode only) |
| `bill_reminder_person_id` | FK → `users` — who gets nudged to send the invoice (default: jon) |
| `bill_reminder_lead_days` | INT — how many days before `next_bill_date` to fire the reminder |
| `rate_review_cadence` | `annual` / `biennial` / `custom` |
| `next_rate_review_date` | DATE — drives the review reminder |
| `last_rate_change_date` | DATE — denormalised from rate history for quick display |
| `previous_weekly_rate` | DECIMAL — denormalised "before" amount for quick display |
| `tcs_agreement_id` | FK → `storage_tcs_agreements`, null until signed |
| `notes` | Free text |

**Move-out / move-in:** ending a tenancy sets `status='ended'` + `move_out_date`; the row stays for ex-client history. A new tenancy is opened on the same room. Nothing is deleted — soft state changes only (consistent with the platform's soft-cancel convention).

**Monthly revenue** per tenancy = `weekly_rate × 52 / 12`. Summed across active tenancies = total monthly storage revenue; empty rooms = visible vacancy/lost revenue.

### Rate history (`storage_rate_history`)

Full audit trail of rate changes — better than only storing "previous rate".

| Field | Notes |
|---|---|
| `id`, `tenancy_id` | |
| `effective_date` | When the new rate started |
| `old_rate` / `new_rate` | DECIMAL |
| `changed_by` | FK → `users` |
| `notes` | e.g. "Annual CPI review" |

When a rate changes, write a history row AND update the tenancy's denormalised `last_rate_change_date` / `previous_weekly_rate` for fast display. The rate-review nudge uses this to show "last increased 14 months ago at £X" so staff can decide a bump confidently.

---

## Component 3: T&Cs (`storage_tcs_versions` + `storage_tcs_agreements`)

Ooosh has historically had **no storage T&Cs** — this module is the chance to fix that. We need versioned T&Cs and per-tenancy acceptance, stored in situ for reference.

**Flow (public accept-link + e-signature — mirrors OOH parking form / hire forms):**

1. Staff draft T&Cs as a versioned document (`storage_tcs_versions`: `version`, `body` HTML and/or R2 PDF, `effective_date`, `is_current`).
2. On a new tenancy, staff trigger a T&Cs request → email to the lead contact with a public link (own short-lived token, no OP auth, page mounted outside `<Layout>` like `/storage-tcs/:token`).
3. Client reads the current T&Cs and accepts with a signature/tick.
4. `storage_tcs_agreements` row written: `tenancy_id`, `version_id`, `accepted_by_name`, `accepted_at`, `signature` (R2 key), `ip` / `user_agent` for audit. Tenancy's `tcs_agreement_id` set.
5. A signed PDF snapshot is generated and stored in R2 against the tenancy (reuses the pdf-lib / jsPDF agreement pattern).

Amber "T&Cs not signed" indicator on tenancies without an agreement — non-blocking, like the client-intro banner pattern.

---

## Component 4: Access list + access requests

### Access list (`storage_access_list`)

Named people allowed into a given unit.

| Field | Notes |
|---|---|
| `id`, `tenancy_id` | Scoped to the current tenancy (re-added on move-in if needed) |
| `person_id` | FK → `people`, nullable |
| `name` / `phone` | Free text fallback when the visitor isn't an address-book person |
| `relationship` | e.g. "Tour manager", "Band member", "Their courier" |
| `added_by`, `added_at` | Audit |
| `notes` | |

### Access requests / events (`storage_access_events`) — the pinch point

Covers the two scenarios you flagged: *"so-and-so is coming to get XYZ out"* and *"get this guitar out and arrange a courier"*.

| Field | Notes |
|---|---|
| `id` | |
| `tenancy_id` / `room_id` | |
| `type` | `visit` (client/agent attending in person) / `retrieve` (we pull item) / `courier_out` / `deposit` (adding to the room) |
| `description` | What — "Get the '63 Strat out" / "Collecting two flightcases" |
| `requested_by` | Who asked (FK person/user or free text) |
| `attendee_person_id` / `attendee_name` | Who's physically attending |
| `method` | `in_person` / `courier` |
| `requested_date` | When it should happen |
| `status` | `requested` → `scheduled` → `done` / `cancelled` |
| `actioned_by`, `actioned_at` | **"Has this been done?"** — who closed it out and when |
| `notes` | |

**Access-list check:** when an access event names an attendee who is NOT on the unit's `storage_access_list`, surface an amber warning ("not on the access list for this unit — add them?"). Non-blocking, but it's the security backstop.

**Notification flow:** creating an access event fires a bell + (optional) email to the warehouse/assigned staff. It surfaces on the dashboard NeedsAttention bucket until `status='done'`. Logs an interaction on the tenancy timeline when actioned, so there's a permanent "X collected Y on date, actioned by Z" record.

---

## Component 5: Waiting list (`storage_waiting_list`)

For prospects who want storage while we're full (usually the case).

| Field | Notes |
|---|---|
| `id` | |
| `organisation_id` / `person_id` | Linked where known, free contact fields otherwise |
| `contact_name` / `contact_email` / `contact_phone` | |
| `preferred_size` | Matches `storage_rooms.size_category` |
| `date_requested` | When they asked |
| `date_last_offered` | When we last offered them a space |
| `status` | `waiting` / `offered` / `converted` / `declined` / `withdrawn` |
| `notes` | |

**Vacancy matching:** when a room frees up (tenancy → `ended`, or status → `available`), surface waiting-list entries whose `preferred_size` matches the freed room (mirrors the fill-a-gap pattern). One click to record an "offered" against an entry, with `date_last_offered` stamped.

---

## Reminders & scheduler

Reuses `config/scheduler.ts` + the notification system. Daily task(s):

| Trigger | Recipient | Surface |
|---|---|---|
| `billing_mode='manual'` AND `next_bill_date - bill_reminder_lead_days <= today` | `bill_reminder_person_id` | Bell + email: "Storage invoice due for [client], Room X" |
| `next_rate_review_date <= today` | `bill_reminder_person_id` (or assigned) | Bell + email: "Rate review due — last increased [date] at £[prev]" |
| `storage_access_events.status='requested'` AND `requested_date <= today` | Warehouse/assigned staff | Bell + dashboard bucket |

All respect the per-user delivery preferences (notification / email / both) already in the inbox system. Reminders are idempotent (stamp a "last reminded" timestamp; don't re-fire daily forever — bump `next_bill_date` forward by cadence when the invoice is marked sent).

---

## Dashboard surfaces

- **Occupancy view** — grid of rooms (occupied / available / reserved / out-of-use), total monthly storage revenue, count of empty rooms (= vacancy cost), upcoming move-outs and rate reviews.
- **NeedsAttention bucket** — "Storage: N invoices to send · N rate reviews due · N access requests outstanding." Click-through to the relevant list. Follows the existing bucket pattern (`backend/src/routes/dashboard.ts` → `<NeedsAttention>`).

---

## Address book integration

A **"Storage" tab** on Organisation Detail (and Person Detail where the person is a lead contact) showing current + past tenancies and any waiting-list entries. Mirrors the existing Hire History / Excess History tab pattern.

---

## Nav placement

Add **"Storage"** as a child of the existing **Operations** submenu in `Layout.tsx` (consistent with "streamline rather than expand"). The Storage page carries tabs:

- **Rooms / Occupancy** (default) — the grid + room catalogue
- **Tenancies** — active + ended, searchable
- **Waiting List**
- **Access Requests** — outstanding + history
- **T&Cs** (admin) — manage versions

RBAC: any `STAFF_ROLES` user can view + log access events / mark invoices sent. Editing rates, room records, T&Cs versions, and reading door codes is admin/manager only.

---

## Component reuse summary (don't reinvent)

| Need | Reuse |
|---|---|
| Clients = orgs/people | Address book (`organisations`, `people`, lead-contact link) |
| Reminders | `config/scheduler.ts` + notification/inbox system + per-user delivery prefs |
| Emails (invoice nudge, rate-increase letter, T&Cs request) | Email service + templates (`email-templates/`) |
| T&Cs e-signature | Public-token page pattern (OOH parking form) + pdf-lib/jsPDF agreement generation |
| Photos / signed docs | R2 + `files` JSONB pattern |
| Door-code encryption | Planned `services/encryption.ts` (PII layer — see §9) |
| Activity trail per tenancy | `interactions` (entity = storage tenancy), reuse ActivityTimeline |

---

## §9 — Security note: door codes are sensitive

Storage room door codes protect clients' physical gear. Treat them like PII:

- Store `storage_rooms.access_code` **encrypted** via the planned `services/encryption.ts` (AES-256-GCM, `ENCRYPTION_KEY` env var). Decrypt only in the API response layer, admin/manager only.
- This module is a clean candidate to land **alongside or just after** the PII encryption layer (PR 3 in the Excess Pre-Auth work). If encryption isn't live when this builds, gate `access_code` behind admin/manager + audit-log every read, and retrofit encryption when the layer lands.
- Every `access_code` read and every access-event action is audit-logged.

---

## §10 — Boundary: temp storage / incoming deliveries (NOT in this module)

**Temp storage** — a client leaving backline between tours for a week, or merch boxes arriving a few weeks before a tour — is **item-centric, short-lived, and job-adjacent**. It does not belong here. It shares its shape with **Incoming Deliveries / "Things Being Sent To Us"** (consignment, arrival date, condition, identify owner, notify, collect) and with **Lost Property** (found item, identify owner, notify, collect/dispose).

Recommendation: build temp storage as part of the future **Incoming Deliveries** module (CLAUDE.md Step 6, Stream 4), alongside lost property — not as a sub-feature of client storage. The two modules are different businesses: one is a standing tenancy with rent and rate reviews; the other is a transient consignment around a job.

The only thin link worth noting: an access-request-style "get item out + courier it" flow appears in both. If/when Incoming Deliveries is built, consider promoting `storage_access_events` to a shared lightweight "item movement request" primitive both modules use.

---

## Build order

1. **Migration** — `storage_rooms`, `storage_tenancies`, `storage_rate_history`, `storage_access_list`, `storage_access_events`, `storage_waiting_list`, `storage_tcs_versions`, `storage_tcs_agreements`. (Add the filename to the hardcoded list in `backend/src/migrations/run.ts`.)
2. **Backend** — `routes/storage.ts`: rooms CRUD, tenancies CRUD + move-in/move-out, rate change (writes history), access list CRUD, access events CRUD + action, waiting list CRUD + offer, T&Cs versions + public accept endpoints.
3. **Scheduler** — billing / rate-review / access-request reminder tasks.
4. **Frontend** — Storage page with tabs (Rooms/Occupancy, Tenancies, Waiting List, Access Requests, T&Cs); room + tenancy detail/edit; public T&Cs accept page (outside `<Layout>`).
5. **Dashboard** — occupancy view + NeedsAttention bucket.
6. **Address book** — Storage tab on Org/Person detail.
7. **Encryption** — wire door codes into the PII layer (or gate + audit until it lands).

---

*— Storage Clients Spec v1.0 —*
