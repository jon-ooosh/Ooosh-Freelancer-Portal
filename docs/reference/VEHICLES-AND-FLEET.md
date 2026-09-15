<!--
Extracted verbatim from the root CLAUDE.md (Sep 2026 restructure).
CLAUDE.md was ~757KB / 5,746 lines and was consuming most of every session's
context window before a single turn of work. It now carries only the
always-applicable conventions; the detail lives here.

This file is the FULL record: design decisions, incident forensics, shipped-work
history. The distilled "never do X" rules that must reach every session live in
`.claude/rules/*.md` (auto-loaded when Claude opens a matching file).
-->

# Vehicles & Fleet — module reference

Vehicle module integration, maintenance & compliance, finance & lifecycle, turnaround schedule.

### Phase 2 — Active / Next Up (WORK ORDER)

**The dependency chain determines the order. Do NOT skip ahead — each step depends on the previous.**

#### Step 1: Vehicle Module Integration ← MOSTLY COMPLETE
Integrate the existing Vehicle Module (separate React app) into the OP as a route.

- [x] Add "Vehicles" nav group to Layout.tsx
- [x] Mount VM React components under `/vehicles/*` routes
- [x] Strip VM's own nav/auth shell, use OP session
- [x] Migrate VM's Netlify functions → OP backend API routes
- [x] Migrate Fleet Master off Monday.com → OP database (fleet_vehicles table + Monday xlsx import)
- [x] Vehicle fleet data (fleet_vehicles table with full schema)
- [ ] Driver Hire Forms migration (see Step 2)

See **Vehicle Module Integration** section below for technical details.

#### Step 1b: Vehicle Maintenance & Compliance ✅ PHASES A/C/D/E COMPLETE
Full maintenance tracking, compliance monitoring, and cost reporting for the fleet.

**Phase A — Service Log CRUD + Migration** ✅ COMPLETE
- [x] Migration 014 (fleet_vehicles extensions, vehicle_service_log extensions, vehicle_mileage_log, vehicle_fuel_log, vehicle_compliance_settings)
- [x] Service log CRUD API (list, create, update, delete) + file upload/download
- [x] "Service History" tab on VehicleDetailPage with filter pills + expandable records
- [x] Manual entry form with staged file uploads + comment field on files
- [x] Mileage auto-logged to vehicle_mileage_log on service record creation

**Phase C — Compliance Reminders** ✅ COMPLETE
- [x] Daily compliance scheduler (08:00) with configurable thresholds (warning/urgent days)
- [x] Enhanced Key Dates section: colour coding (green/amber/red), days countdown, "booked in" date fields
- [x] Insurance due date, provider, and policy number fields
- [x] Compliance overview widget on vehicles homepage (fleet-wide overdue/due-soon alerts)
- [x] Notifications targeted to configurable roles (deduped: 7-day for soon, 1-day for overdue)
- [x] Compliance settings API (GET/PUT for vehicle_compliance_settings)
- [x] On-demand compliance check endpoint (GET /api/vehicles/compliance/check)
- [ ] DVSA MOT History API integration (API key applied for 13 Mar 2026, ~5 day turnaround)
- [ ] DVLA Vehicle Enquiry Service for tax status (deferred)

**Phase D — Mileage Tracking** ✅ COMPLETE
- [x] Mileage logged on service record creation
- [x] Mileage API endpoints (GET history with stats, POST manual entry)
- [x] Book-out/check-in/prep events dual-write to vehicle_mileage_log
- [x] Current mileage display on vehicle detail (with last update date)
- [x] "Miles until service" computed indicator with green/amber/red
- [x] Amber warning on service mileage lower than current (in ServiceRecordForm)

**Phase E — Fuel Monitoring + Cost Reporting** ✅ COMPLETE
- [x] Fuel log CRUD endpoints + stats (total cost, litres, fill count, cost per mile)
- [x] "Fuel" tab on vehicle detail page with stats cards and add fuel form
- [x] Fuel fills with mileage also write to vehicle_mileage_log
- [x] Fleet-wide cost report page at `/vehicles/costs` (admin/manager only)
- [x] Per-vehicle service + fuel cost breakdown with sortable table
- [x] Time period selector with presets (YTD, 30d, 90d), CSV export

**Per-Vehicle Settings Page** ✅ COMPLETE
- [x] Admin-only settings route `/vehicles/fleet/:id/settings`
- [x] "Sell vehicle" / "Reactivate" moved to settings danger zone
- [x] Service interval settings (next due mileage, last service)
- [x] Insurance details (due date, provider, policy number)
- [x] Vehicle details (fuel type, MPG, CO2, tyre PSI)
- [x] Finance details (provider, end date)
- [x] Compliance alert thresholds editor (fleet-wide warning/urgent days for MOT, Tax, Insurance, TFL)
- [x] Vehicle detail page uses configurable thresholds (fetched from compliance settings API)

**Service History Enhancements** ✅ COMPLETE
- [x] Sort dropdown (newest/oldest, highest/lowest cost, garage A-Z, type)
- [x] Authenticated file download (JWT-based blob fetch, view images/PDFs in new tab)
- [x] Date display on service record cards (fixed `formatDate` for pg Date objects)

**Fleet Map Enhancements** ✅ COMPLETE
- [x] "Open Traccar" link replaces redundant Dashboard button (links to https://tracking.oooshtours.co.uk/)
- [ ] Nav dropdown z-index fix — `z-50` on header not sufficient, Leaflet map still overlays dropdown (known bug, low priority)

**Vehicle Detail Enhancements** ✅ COMPLETE
- [x] V5/Registration section on detail page (VIN, date first reg, type, body type, mass, category, cylinder capacity)
- [x] Vehicle Specs section (oil type, coolant type, tyre size, fuel type, MPG, CO2, tyre PSI)
- [x] Rossetts service tracking (last date + notes)
- [x] Service Plan Status picker (colour-coded: 0-6 Remaining, WORKINGONIT, NO PLAN)
- [x] Vehicle file uploads (V5 copy, insurance cert, wifi docs, finance docs, etc.) with labels + comments
- [x] Migration 015: oil_type, coolant_type, tyre_size, rossetts fields, service_plan_status, files JSONB

**Vehicle Finance & Lifecycle (admin-only)** ✅ COMPLETE (Jun 2026)
Full financial life of a van — acquisition → finance → disposal — replacing the Monday Fleet finance columns. Migration **104** added the columns; **105** (`cost_payment_methods_bills`, from a parallel branch) and **106** (`reconcile_vehicle_finance_columns`, idempotent add/drop) followed. NOTE: 104 was edited in-place after an early version had already been deployed, so the runner skipped the revised version and the new columns went missing on prod — 106 is the clean-up. **Lesson: never edit a migration once it could have been applied anywhere; always add a new one.**

- **Access:** finance fields are **admin-only** (`canViewVehicleFinance` in `routes/vehicles.ts` — `role === 'admin'`). Stripped from read payloads + rejected on writes for non-admins. Finance docs flagged `is_finance` on the `files` JSONB — hidden from the general Files UI and never sent to non-admins. The **removal checklist** + `sold_date` are operational/all-staff (not finance-gated).
- **Finance agreement model** (`fleet_vehicles`): `cash_price` (inc-VAT), `deposit_paid`, `amount_financed`, `monthly_payment`, `finance_term_months`, `finance_fees` (JSONB `[{label, amount}]`), plus `finance_with` (picklist `finance_provider`, ad-hoc-extendable via `/api/vehicles/finance-providers`), `finance_reference`, `finance_start`, `finance_ends`.
- **Derived, never stored** (computed in `mapDbRowToVehicle` AND mirrored in `frontend/.../lib/vehicle-lifecycle.ts` + `FinanceAgreement` for live edit): `total_payable` = financed ? deposit + monthly×term + fees : cash_price + fees; `cost_of_finance` = total_payable − cash_price (only when financed AND cash_price set). **Cash price must be the inc-VAT figure** or cost-of-finance reads wrong (common data-entry slip; UI has a hint). Agreements often bundle fees into the first/last payment — model them as flat monthly×term + separate fee rows; reconciles to the penny.
- **5-year sell window**: `sellByDate` = `date_first_reg + VEHICLE_LIFESPAN_YEARS` (hardcoded 5 in `vehicle-lifecycle.ts` — move to `system_settings` if it ever needs to be staff-editable). Countdown colour: amber within 12 months, red once past.
- **Removal process**: sell action on Vehicle Settings is a modal capturing sale date (all staff) + price/notes (admin only); seeds `removal_checklist` (HireHop / TTS360 / insurers / notify DVLA / DVLA confirmation — `lib/removal-checklist.ts`, mirrors `setup-checklist.ts`). Checklist is all-staff, tickable on Vehicle Detail, stays editable after sale (DVLA confirmation lands 1–2 weeks later). **Switching `finance_with` to "We own outright" does NOT wipe the finance figures** — they're independent columns, so backfilling a paid-off van keeps the lifetime cost history.
- **Where it lives**: admin-only "Finance & Lifecycle" card + all-staff "Removal Checklist" card on Vehicle Detail (`components/FinanceLifecycleSection.tsx`); finance fields in the Add-Vehicle form (admin only); admin-only **"Finance" board view** on `/vehicles` (sortable columns incl. Deposit / Financed / Total payable, finance-end goes green once paid off). Both fleet board tables (normal + finance) have click-to-sort headers.

**Phase F — Fleet Turnaround Schedule** ← IN PROGRESS (May 2026)

Van-centric forward-facing view answering "which vans need prep, and when do I need them ready?". Solves the long-standing manual workaround where staff typed regs into job names and eyeballed it. Complements (does NOT replace) AllocationsPage — same data, different lens. AllocationsPage stays the allocation workflow (job-centric); Turnaround is the prep planning surface (van-centric).

**Where it lives:** Collapsible section at the top of `/vehicles/prep` (Prep Queue page). Default expanded, state persisted in localStorage (`turnaround-schedule-collapsed`). Initial mount was on `/vehicles` (HomePage) — moved May 2026 to keep the prep planning concern co-located with the prep workflow. No new top-level nav, keeps in line with the "streamline rather than expand" principle.

**Data:** Read-only from existing tables — no new schema needed.
- `vehicle_hire_assignments` — forward-looking rows per van (`vehicle_id IS NOT NULL`, `status IN ('soft', 'confirmed', 'booked_out', 'active')`, future `hire_end`)
- `fleet_vehicles` — compliance fields (MOT, tax, insurance, TFL, service due) + cached `hire_status`
- Joins to `jobs` via the dual match pattern (vha.job_id OR vha.hirehop_job_id) so V&D staff-allocation rows surface alongside hire-form rows

**Row shape per van** (read as table + mini horizontal strip):

| Column | Source | Notes |
|---|---|---|
| Reg | `fleet_vehicles.reg` | Click → Vehicle Detail |
| State now | `fleet_vehicles.hire_status` | Available / On Hire / Prep Needed / Not Ready / Sold |
| Coming back | Active assignment's `hire_end` + linked job ref | If state = On Hire / Active |
| Prep window (days) | `next_hire_start - return_date` | Colour-coded (see thresholds) |
| Going out next | Next future assignment's `hire_start` + linked job ref | "No next allocation" with green pill if empty |
| Flags | Compliance + breakdown markers | MOT/Tax/Insurance/TFL due within window, mid-tour swap, etc. |

**Prep window colour thresholds** (configurable via `calculator_settings`):
- `> 2 days` 🟢 green — Comfortable
- `1–2 days` 🟡 amber — Standard turnaround, within Ooosh's +1 day buffer
- `< 1 day` 🟠 orange — Eating into the buffer (physical-only window, ~90 min real prep)
- `≤ 0 days` 🔴 red — Stored dates overlap, needs human review

Prep window is computed against `jobs.return_date` (the inflated +1 day buffer), NOT `jobs.job_end`. Matches what staff actually live with.

**Edge cases:**

| Scenario | Display |
|---|---|
| No next allocation | "Available from [return date]" with green pill — positive signal, van could absorb an unallocated hire |
| Deallocations (`status='cancelled'`) | Drop out entirely. Timeline shows current commitment state, not history. Audit lives on Vehicle Detail event history. |
| Mid-tour swap (broken van) | Strip shortens to `swapped_at`, marked "↪ Swapped to RX22XYZ on …". Bubbles into a separate **"Needs assessment"** bucket pinned above prep priority — different team, different urgency (repair, not prep) |
| Mid-tour swap (replacement van) | Strip starts mid-stream from `swapped_at`, marked "↩ Swap-in from RX17ABC". Counts toward replacement's prep window from there on |
| `Sold` / `Not Ready` | Hidden by default, toggleable filter to surface |

**Filter + sort** (per jon's amendment, May 2026):
- **Search by reg** — narrow to one van or a partial match
- **Filter pills:**
  - State: All / On Hire / Prep Needed / Available
  - Compliance: All / Has flag (any of MOT/Tax/Insurance/TFL/Service)
  - Has next allocation: All / Yes / No (lets staff find vans free to take work)
- **Sort modes** (dropdown):
  - **Urgency** (default) — shortest prep window first, "Needs assessment" bucket pinned above
  - **Returning soonest** — what's coming back today vs next week (useful when planning warehouse workload by day)
  - **Going out soonest** — when's the next departure
  - **Reg A–Z** — alphabetical fallback
- **Range presets:** 7 / 14 / 28 days (default 14)

**Non-blocking:** all warnings, no hard gates. Red prep windows don't prevent allocation or book-out. Consistent with the OP convention — dispatch is the only hard gate, and even that has manager override.

**Deep-links** (when staff want to act on what they see):
- Click reg → Vehicle Detail
- Click hire block → Job Detail for that hire
- **"🔧 Prep this van →"** per-row CTA → on-page hash anchor (`#prep-card-<reg>`) that scrolls to the matching card in the Prep Queue below the section. Staff click "Start Prep" on the card explicitly — no surprise auto-actions. CTA hidden on rows where the van is currently out and won't be back in the visible window.

The original "Find a job for this gap →" link (deep to AllocationsPage with date-range hint) was removed May 2026 — the section's home moved to `/vehicles/prep` and the CTA changed to focus exclusively on prep, not allocation. If "fill a gap with an unallocated job" surfaces operationally as a need again, that's a separate Allocations-side feature, not a Turnaround responsibility.

**Compliance pip overlay:** Above each strip's time axis, small chevrons mark MOT / Tax / Insurance / TFL / Service-by-miles thresholds falling in the visible window. Tooltip on hover shows the exact date or mileage. Reuses existing compliance threshold settings (warning/urgent days). This is the bonus the user flagged — same surface answers "should I prioritise prepping this one because the MOT clears tomorrow but it goes out Friday?".

**Backend endpoint:**
```
GET /api/vehicles/turnaround-schedule?days=14&state=all&compliance=all&has_next=all&sort=urgency&q=
```
Returns one row per active vehicle. Cached briefly (5–10s) since the underlying data only changes on assignment writes. Auth: any staff role (STAFF_ROLES).

**Settings (admin-editable):**
- `prep_window_amber_threshold` (default 2 days)
- `prep_window_red_threshold` (default 0 days — i.e. overlap = red)
- `prep_window_orange_threshold` (default 1 day — eats buffer)

Stored on `calculator_settings` for now (or move to `fleet_settings` if other fleet-specific knobs accumulate). Matches the "Allocation turnaround buffer" item flagged in Future Enhancements — both should eventually read from one source.

**Build order:**
1. Backend endpoint with filter/sort
2. Frontend section on `/vehicles` (table + mini-strip)
3. Settings page entries for thresholds
4. Deep-link from gaps to AllocationsPage
5. Compliance pip overlay
6. *(Future)* Drag-to-allocate from the strip, bundled with the deferred van-centric AllocationsPage rebuild

**Dedup contract (May 2026):** Self-drive client hires can land TWO `vehicle_hire_assignments` rows for the same `(vehicle_id, job)` pair — one staff-allocation row (status='confirmed') and one hire-form row (status='booked_out'). Both pass the "forward commitment" filter. Without dedup the booked-out row becomes "current" and the confirmed row becomes "next" — same job appears in both columns. The endpoint dedupes per `(vehicle, jobKey)` where `jobKey = uuid:<job_uuid> | hh:<hh_job_number> | asg:<assignment_id>` (last fallback keeps unlinked rows distinct). Winner is the most-progressed status (active > booked_out > confirmed > soft), tied by latest `status_changed_at`. Any future "forward commitment" SQL touching `vehicle_hire_assignments` that aggregates per van should apply the same dedup rule.

**Out of scope (deliberately):**
- Drag-to-allocate from the Turnaround surface (deferred — would multiply allocation logic surface area)
- Past-history view (not the question staff are asking; audit lives on Vehicle Detail)
- True Gantt with overlapping hires per van (overlaps mean a data error — surfaced via red prep window, not a UI feature)

**Phase B — AI Document Extraction** (deferred — nice-to-have, end of build)
- [ ] POST /extract endpoint: upload invoice/service record → Claude extracts fields → returns JSON
- [ ] "Upload & Extract" mode in service record form — preview extracted data, user confirms
- [ ] Future: receipt uploader integration (general receipts with "is this for a van?" routing)

See **Vehicle Module Integration** section below for technical details.
