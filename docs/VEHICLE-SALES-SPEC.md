# VEHICLE SALES SPEC — selling a van, and DVSA MOT history

**Status:** 🔨 PHASES 0–1 BUILT (30 Sep 2026) — jon + Claude. Phases 2–4 not started. §9 records
jon's answers to the open questions (all recommendations taken); §11 is what Phase 1 actually shipped
and where it differs from §5.

**Replaces:** the "Sell / Remove from Fleet" button in the Vehicle Settings danger zone as the
*starting point* of a sale (the existing sold modal + removal checklist stay as the *end* of it).

---

## 0. One-line summary

> An admin presses **"Start sales process"** on a van → OP gathers what it already knows (V5, mileage,
> key dates, service history, MOT history, damage) **live** → staff pick the best photos from recent
> book-outs/check-ins or add new ones → **share links** go to prospective buyers, each showing as much
> or as little as that buyer should see → staff log viewings, listings and offers, with follow-ups
> landing in **To Do** → **"Mark sold"** hands over to the existing sold modal and removal checklist.
> Until then **the van stays active and hireable**; it just carries a "For sale" warning.

Built alongside it, first and on its own: **DVSA MOT history** for every van (§3), useful well beyond
this module.

Groundwork for later: the "vehicle info pack" (selective sharing of vehicle data to clients) will
reuse the public page's sections (§6.3). This spec does **not** generalise the link table for it yet —
that waits until the info pack is shaped.

---

## 1. Decisions (settled — don't re-litigate without jon)

| # | Decision | Why |
|---|---|---|
| D1 | **One sale per van.** No multi-van bundles or bundle links. | We sell a few at a time; forcing a bundle deal that may never happen is a footgun. |
| D2 | **The van stays active and hireable** throughout. Nothing about `hire_status`, `is_active` or allocation changes until "Mark sold". | Vans can be listed for months. |
| D3 | "For sale" is a **warning, not a gate** — shown on Vehicle Detail, the fleet board, Allocations and Book-out, with an optional "hold from hire from" date. | CLAUDE.md product policy. We're small enough to manage bookings around sale dates; the reminder is visual. |
| D4 | **Vehicle facts are read live**, never snapshotted — mileage, dates, service and MOT history update on every page load until the sale closes. | Listings run for months and details change a lot. |
| D5 | **Photos are the exception: chosen, not live.** They only change when a person changes them. | A buyer should see the pictures we picked, not whatever the last book-out took. |
| D6 | **A new Problem on the van flags the photos for a re-check** (§5.4). No Problem → no nag. | Check-in damage already auto-creates a Problem (`POST /api/problems/auto-create`), so this catches a van that came back with a dent without reminding after every clean hire. |
| D7 | **Admin starts (and withdraws) a sale. After that, all staff (`STAFF_ROLES`) can work it** — see the price and data, choose photos, log viewings/offers/listings, set follow-ups. | Staff need the price to show people round; it's published anyway. |
| D8 | **What each buyer sees is set per share link**, not per van (§6.2). | The dealer and a client see different amounts from the same pack. |
| D9 | Only **chosen photos** ever leave OP. Never a whole book-out event, never a condition-report PDF (they carry driver names, signatures, customers' kit). | Privacy. |
| D10 | **Service history** shows as a summary (date, mileage, type, garage). Invoice files are **off** and not in v1. | Invoices can carry our account details. |
| D11 | **Damage history is on by default** per link; hiding it is a deliberate switch. | Selling to a private buyer while hiding known damage is a misrepresentation risk. |
| D12 | **Listing-site integrations are out.** "Copy listing text" and "download photos" (Phase 4) are the answer. | A handful of vans doesn't justify API work. |
| D13 | Follow-ups are **To Do items** (`staff_tasks`, `source_type = 'vehicle_sale'`), not a new reminder system. | TASKS-SPEC §2: "everything else" lives in To Do; the `source_type` hook already exists. |
| D14 | **Share link first, PDF last** (Phase 4, may never be needed). | A link stays current, can be revoked and shows when it was opened. |

---

## 2. What already exists (verified in the repo, Sep 2026)

| Thing | Where | Use here |
|---|---|---|
| V5 fields (VIN, first reg, body type, mass, category, cc), make/model/colour/seats, gearbox, fuel | `fleet_vehicles` (mig 011, 013, 015, 096) | headline + V5 section |
| MOT / tax / last service / service plan status | `fleet_vehicles` key dates | key dates section |
| Service log + files | `vehicle_service_log` (mig 012/014) | service history summary |
| Mileage log (book-out, check-in, prep, service, fuel, manual) | `vehicle_mileage_log` (mig 014) | current mileage + history |
| Book-out / check-in photos | public bucket `ooosh-vehicle-photos`, `events/{eventId}/{REG}/*.jpg`; events via `GET /api/vehicles/get-events` | photo picker |
| Problems per van | `job_issues`, `GET /api/problems/by-vehicle/:id` | damage history + photo re-check trigger |
| Sold modal, `sold_date`, `sale_price`, `removal_checklist` | `VehicleSettingsPage.tsx` danger zone, mig 104, `lib/removal-checklist.ts` | the END of the sale |
| Value estimate | `services/vehicle-value.ts` | admin-only hint next to the asking price; never on a link |
| Tokenised public pages | `services/claim-links.ts`, `routes/claim-form.ts`, `/claim/:token` | the pattern for §6 |
| To Do | `services/staff-tasks.ts`, `source_type`/`source_id` | follow-ups (§7) |
| Image prep | `frontend/src/lib/imageNormalise.ts` `prepareImage()` | new photo uploads |

MOT **history** is not in OP at all — DVSA was applied for in March 2026 and never wired up (§3).

---

## 3. Phase 0 — DVSA MOT History (build first, stands alone)

### 3.1 The API (DVSA MOT History API, current version)

- Auth: OAuth 2.0 **client credentials** via Microsoft Entra ID. Needs **five** values from the DVSA
  registration email: client ID, client secret, scope URL, token URL, API key.
- Token: POST to the token URL; valid 60 minutes → cache it in memory, refresh on expiry/401.
- Requests carry `Authorization: Bearer <token>` **and** `X-API-Key: <key>`.
- Lookup by registration (endpoint path to confirm against the live docs at build time).
- **Client secrets expire every 2 years**; DVSA emails 30 and 14 days before. Renewal is via their
  `/credentials` endpoint with the API key + registered email. OP should surface the expiry date (§3.4).

**Credentials live in `.env`** (`DVSA_CLIENT_ID`, `DVSA_CLIENT_SECRET`, `DVSA_SCOPE`,
`DVSA_TOKEN_URL`, `DVSA_API_KEY`) — they're secrets, not staff-editable config, so NOT `system_settings`.

### 3.2 Storage

`vehicle_mot_history` (mig 263) — one row per van, overwritten on each fetch:
`vehicle_id` (PK, FK), `fetched_at`, `payload JSONB` (DVSA response as-is), `error TEXT`.
The UI parses the payload; storing it raw means a DVSA field we don't show yet isn't lost.

MOT odometer readings are **NOT** written to `vehicle_mileage_log` (changed at build time). Many
tests pre-date our ownership of the van, and the log's first/last readings drive the average daily
mileage and the Forecast tab's mileage pace — old readings would skew both. The readings are shown in
the MOT history section instead, where they belong.

### 3.3 When it fetches

- **Weekly**, Monday 07:30 Europe/London, for every active van — before the 08:00 compliance
  check, so a corrected `mot_due` is what that check sees. Paced one van every 1.5 s.
- **On demand**: "Refresh from DVSA" on the van's MOT history section.
- **On Start sales process.**

### 3.4 What it shows / does

- **Vehicle Detail → "MOT history"** section: each test — date, result, expiry, mileage, advisories /
  failures (dangerous flagged red). All staff.
- **`mot_due` vs DVSA expiry** (Q3): when the latest *passed* test's expiry is **later** than
  `mot_due` (or `mot_due` is empty), OP updates `mot_due` and writes an `audit_log` row
  (`action = 'mot_due_from_dvsa'`). When DVSA's date is **earlier**, OP only shows a warning in the
  section — never moves a date backwards on its own.
- **Secret expiry:** no OP reminder (dropped at build time) — DVSA already emails 30 and 14 days
  before. If the credentials are rejected, the section says so in plain words ("DVSA rejected our
  credentials — the client secret may have expired") rather than a generic failure.

---

## 4. Data model (Phases 1–3)

Migration numbers are taken at build time (Phase 0 took 263; next free is 264 at time of writing). Every new file goes in
`backend/src/migrations/run.ts`.

**`vehicle_sales`**
| Column | Notes |
|---|---|
| `id` UUID | |
| `vehicle_id` UUID FK | partial unique index: one sale per van where `status IN ('preparing','listed','under_offer')` |
| `status` | `preparing` → `listed` → `under_offer` → `sold` / `withdrawn` |
| `asking_price` NUMERIC(12,2) | ex- or inc-VAT: see Q5 |
| `description` TEXT | the sales blurb |
| `hold_from_hire` DATE NULL | optional "try not to book it after" date (D3) |
| `photos_confirmed_at` TIMESTAMPTZ | set when photos are saved or "Photos still OK" is pressed (§5.4) |
| `started_by`, `started_at`, `closed_at`, `closed_reason` | |

**`vehicle_sale_photos`** — `id`, `sale_id`, `r2_key`, `source` (`event` / `upload`), `source_event_id`,
`label` (e.g. "Front ¾", "Interior"), `sort_order`, `added_by`, `added_at`.
Event photos are **referenced by key** (the public bucket keeps them); new uploads go to
`vehicle-sales/{saleId}/` in the public bucket.

**`vehicle_sale_links`** — `id`, `sale_id`, `token` (claim-links pattern, stored in the clear),
`recipient_name`, `person_id` / `organisation_id` (optional), and the switches:
`show_price`, `show_service_history`, `show_mot_history`, `show_mileage_history`,
`show_damage_history` (default TRUE), plus `created_by`, `created_at`, `revoked_at`,
`view_count`, `last_viewed_at`.

**`vehicle_sale_events`** — the activity log: `id`, `sale_id`, `type` (`note` / `viewing` / `listed` /
`contact` / `offer` / `status_change` / `link_created` / `link_revoked` / `photos_changed`),
`occurred_at`, `person_id` / `organisation_id` (optional), `text`, `amount` (offers),
`listing_site` + `listing_url` (listings), `task_id` (follow-up, §7), `created_by`.

---

## 5. Phase 1 — the sales pack

### 5.1 Starting it
- The **"Sell / Remove from Fleet"** danger-zone button is replaced by **"Start sales process"**
  (admin). It opens a small form: asking price, optional hold-from date → creates the sale in
  `preparing`, triggers a DVSA fetch, and opens the sale page.
- Also offered from the admin's Vehicle Detail header.
- A van not being sold (write-off, finance hand-back, scrapped): the danger zone keeps a smaller
  **"Remove without sale"** link that opens today's sold/remove modal (Q1).

### 5.2 The sale page (`/vehicles/fleet/:id/sale`)
- Header: reg, stage pill, asking price, days on sale, admin-only value estimate hint.
- **Data preview** — exactly what the public page will render (§6.3), live.
- **Photos** (§5.3), **Share links** (Phase 2), **Activity** (Phase 3).
- Stage changes: `preparing ↔ listed ↔ under_offer` by any staff; `withdrawn` admin only;
  `sold` only via "Mark sold" (§7.3).

### 5.3 Choosing photos
- The picker lists the **last 3 book-out and check-in events** for the van (via `get-events`),
  each as a strip of thumbnails; tick to add, drag to order, optional label.
- **"Load older events"** goes further back.
- **"Add photo"** uploads new ones (camera on mobile) through `prepareImage()`.
- Flag, not block: an odometer/dashboard photo will show an old mileage figure — the picker shows a
  hint next to any photo whose label/angle is the dashboard.

### 5.4 Photo re-check (D6)
- **Computed, not stored:** the sale is "photos need a check" when any Problem on the van was
  created — or re-flagged onto an existing Problem by a check-in — after `photos_confirmed_at`.
- Shown as an amber banner on the sale page and a badge on the For-sale pill, listing the Problem(s)
  with links.
- A **bell** goes out when a Problem lands on a van with an open sale (hook in `createJobIssue` and the
  auto-create dedup path) — recipients: see Q4.
- **"Photos still OK"** (or saving a photo change) stamps `photos_confirmed_at = now()` and clears it.

### 5.5 The "For sale" warning (D3)
A pill "For sale · Listed · hold from 14 Nov" on Vehicle Detail, the fleet board, Allocations
(van picker) and Book-out. When an allocation/hire runs past `hold_from_hire`, the pill turns amber
with "booked beyond hold date". Never blocks.

---

## 6. Phase 2 — share links and the public page

### 6.1 Links
- Created from the sale page: recipient name (optionally picked from People/Organisations), the
  switches, → a URL `staff.oooshtours.co.uk/van/:token` to copy.
- Revocable; view count + last viewed shown on the sale page.
- Links **stop working when the sale is sold or withdrawn** — see Q6 for what they show instead.

### 6.2 Switches per link
| Switch | Default | Shows |
|---|---|---|
| Price | on | asking price |
| Service history | on | summary list |
| MOT history | on | DVSA tests, advisories |
| Mileage history | off | dated readings |
| Damage history | **on** | Problems: date, area, status (repaired / outstanding) |

Always shown: headline, V5 details, key dates, description, chosen photos.

### 6.3 The public page
- Read-only, no login; backend `GET /api/public/vehicle-sale/:token`, rate-limited like the other
  public routes.
- **Server-side filtering** — switched-off sections are never sent, not just hidden.
- **Never sent, whatever the switches:** job names or numbers, client or driver names, costs,
  purchase price / finance / value estimate, internal notes, the activity log, condition reports.
- Sections built as standalone components (headline, V5, key dates, photos gallery, service, MOT,
  mileage, damage) so the future vehicle info pack can reuse them.
- Mobile-first; Ooosh branding; "Contact: …" footer (who — Q7).

---

## 7. Phase 3 — activity, follow-ups, closing

### 7.1 Logging
Any staff member adds an entry: *viewing* ("Showed Dave round, 3 Oct"), *listed* (site + URL + date),
*contact*, *offer* (amount + who), *note*. Optional person/organisation.

### 7.2 Follow-ups → To Do
Any entry can carry **"Follow up on [date]"** (+ who, default me) → creates a `staff_tasks` row with
`source_type = 'vehicle_sale'`, `source_id = sale id`, title e.g. "Follow up Dave re RX21ABC", due that
date. It shows in To Do with a "Van sale" badge linking to the sale page. Ticking it is plain To Do.
All rules via `services/staff-tasks.ts` — this module never writes task rows around it.

### 7.3 Mark sold
"Mark sold" (admin) opens the **existing** sold modal pre-filled (date today, price from the
accepted offer if any), which sets `sold_date` / `sale_price` and seeds the removal checklist exactly
as today. The sale closes as `sold`; open follow-up tasks from it are cancelled; links stop.

---

## 8. Phase 4 — maybe (only if needed)
- PDF of the public page for a given link's switches (jsPDF, as the condition reports).
- "Copy listing text" (headline + description + key facts, plain text).
- "Download photos" zip of the chosen photos.

---

## 9. Answered questions (jon, 30 Sep 2026 — all recommendations taken)

| # | Question | Answer |
|---|---|---|
| Q1 | Removing a van **without** a sale? | Keep a "Remove without sale" link in the danger zone opening today's modal. |
| Q2 | DVSA credentials? | All five in hand. Phase 0 built first. |
| Q3 | DVSA later MOT expiry than `mot_due`? | Auto-update when DVSA is later; only warn when it's earlier. |
| Q4 | Who gets the "Problem on a van for sale" bell? | Whoever started the sale + the default vehicle-issue watchers. |
| Q5 | Asking price inc. or ex. VAT? | One figure + a VAT flag, shown on the link as "+VAT" / "inc. VAT". |
| Q6 | What a link shows after the sale closes? | "This vehicle is no longer available" — nothing else. |
| Q7 | Contact details on the public page? | A fixed sales contact from `system_settings`. |

---

## 10. Build order

1. **Phase 0** DVSA MOT history (backend service + table + weekly job + Vehicle Detail section).
2. **Phase 1** sale record, sale page, photo picker, re-check, For-sale pill, button swap.
3. **Phase 2** share links + public page.
4. **Phase 3** activity log, To Do follow-ups, Mark sold.
5. **Phase 4** only if asked.

---

## 11. Phase 1 — as built (30 Sep 2026)

**Where things are**
- Backend: `services/vehicle-sales.ts` (THE definition — every rule), `routes/vehicle-sales.ts`
  (`/api/vehicle-sales`, staff-only), migration **264** (`vehicle_sales`, `vehicle_sale_photos`).
- Frontend: `modules/vehicles/pages/VehicleSalePage.tsx` (`/vehicles/fleet/:id/sale`),
  `lib/vehicle-sales.ts`, `components/sales/ForSalePill.tsx`.

**Differences from §5**
- **Start lives on the sale page.** The danger zone and the Vehicle Detail header link there; the
  page shows the start form to an admin when there's no open sale.
- **Danger zone has three states:** van gone → *Reactivate*; open sale → *Open sales page* +
  *Mark sold*; otherwise → *Start sales process* (admin) + a small *Remove without sale…* link.
  Both *Mark sold* and *Remove without sale* open the existing sold/remove modal.
- **"Mark sold" arrived early (part of §7.3).** The sale page's *Mark sold…* opens Vehicle Settings
  with `?sell=1`, which opens the modal. **Any removal (`fleet_group → 'old_sold'` through
  `PUT /api/vehicles/fleet/:id`) closes an open sale as `sold`** (`closeOpenSaleOnRemoval`).
  Not yet done from §7.3: pre-filling the modal from an accepted offer (needs Phase 3's offers).
- **Admin means `admin` only** for start, withdraw, price, VAT and hold date — managers are refused
  (D7 said admin). Stage, description and photos are any `STAFF_ROLES`.
- **Photo re-check** is computed on every read (`loadRecheck`): Problems created, or re-flagged
  (`job_issue_events.event_type = 'reflagged'`), after `photos_confirmed_at`. A sale with no photos
  never shows it. Any photo change stamps `photos_confirmed_at`, as does *Photos still OK*.
- **The bell** (`notifyVehicleSaleOfIssue`) is called at all five places a Problem is created or
  re-flagged: `problems.ts` (manual create, check-in auto-create, its re-flag branch),
  `job-issues.ts` `createJobIssue()`, `incident-claims.ts`. It only fires when the sale has photos.
  A `createJobIssue()` call inside a caller's transaction may miss the bell (row not committed yet)
  — the computed banner still catches it.
- **The photo picker** lists Book Out / Check In events newest first, 3 at a time; only the first is
  expanded, so thumbnails load only for events someone opens. Photos display from the public bucket
  (`VITE_R2_PUBLIC_URL`), falling back to `/api/vehicles/photo/*`, which now also serves
  `vehicle-sales/` keys from the public bucket.
- **The "For sale" pill** shows on Vehicle Detail (links to the sale), the fleet board (cards + table),
  the Allocations van picker and the Book-out van list. It turns amber when a live hire
  (`soft`/`confirmed`/`booked_out`/`active`) ends after the hold date. **It never loads in a
  freelancer session** — the route is staff-only and a refused call would trigger a token refresh.
- **Key facts** on the sale page are a plain live summary; the buyer-facing sections are Phase 2.
- **Dates** are refused outside 2000–2099 (`cleanDate`) — a mistyped `0006-08-25` otherwise stores
  year 6.
- DVSA: the MOT tab and a one-line note under *Details › Key Dates › MOT Due* ("✓ Matches DVSA" or the
  earlier-date warning) share one query. DVSA errors now carry DVSA's own reason (Entra `AADSTS…`
  code named in plain words, or the MOT API's `errorCode`).

**Verified** against a real Postgres 16 with all 264 migrations applied from scratch: start / second
start refused / hold-date warning (cancelled hires ignored) / photos (other van refused, duplicates
ignored) / re-check on new and re-flagged Problems / *Photos still OK* / bell recipients / staff vs
admin patches / reorder, label, remove / removal closes the sale / closed sale locked; DVSA refresh
moving `mot_due` forward with one audit row and never backwards.

