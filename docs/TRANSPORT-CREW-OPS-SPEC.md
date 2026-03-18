# Transport & Crew Operations Spec

**Status:** APPROVED
**Date:** 18 March 2026
**Target:** EOD 19 March 2026 (full system switch from Monday.com)
**Depends on:** Quotes system (complete), Vehicle hire assignments (complete), Job requirements (migration complete), Freelancer portal (exists, needs repointing)

## Overview

This spec covers two interconnected systems:

1. **Transport & Crew Operations Page** — the internal "control room" for staff, replacing the Monday.com "Deliveries & Collections" and "Crewed Jobs" boards
2. **Freelancer Portal Repointing** — switching the existing freelancer-facing Next.js app from Monday.com data to the OP backend API

These are two sides of the same coin: staff manage operations on the OP; freelancers see their assignments on the portal. Both read from the same database.

## Decisions Made

| Question | Decision |
|----------|----------|
| **Nav placement** | "Operations" as top-level nav group → "Crew & Transport" as first child (more ops items to follow) |
| **In-house staff** | Option B — any OP staff user sees all operations. Can mark "Ooosh crew" without assigning a specific person |
| **Equipment checklist** | Same portal view for staff — they use it as non-committed reference for what they're picking up |
| **Multi-drop runs** | Yes — quote grouping via `run_group` field. Grouped quotes show together in portal, allow combined fee override |
| **Work types** | Fixed picklist: Backline Tech, Runner/Driver, General Assist, FOH, Sound, Lighting, Stage, Video, Rigging, Catering, Other. If "Other" → display custom text |
| **What/Del-Col badges** | Already captured by calculator (`what_is_it`, `job_type`) — no duplication needed on ops page, data flows through |
| **Invoice comparison** | Manual for now (staff compare visually). Future: AI/OCR reading invoices |

## What Exists Today

### Monday.com boards being replaced

**Deliveries & Collections board** — tracks every delivery and collection with:
- Type (Delivery / Collection), What (Equipment / Vehicle / People)
- HireHop job number, client name, quoted price
- Date, arrival time, venue
- Driver assigned (by email), freelancer fee
- Key points / flight info, client introductions
- Tolls, hotel/flight booking status
- Operational status: TO DO! → Working on it → All done!
- Completion: date, time, signature, photos, notes

**Crewed Jobs board** — similar but for crew work:
- Work type (Backline Tech, Runner/Driver, General Assist, etc.)
- Crew member, crew fee, charge method (Day Rate / Hourly)
- Start/finish dates, number of days
- Venue, expenses (included / not included / breakdown)
- Freelancer expense notes
- Same status flow: TO DO → Arranged → Done

### Freelancer Portal (Next.js app in `/src/`)

A standalone app at the same domain that freelancers log into. Currently reads from Monday.com GraphQL API. Key features:
- **Dashboard** — grouped job cards (Today / Upcoming / Completed / Cancelled), multi-drop runs grouped together
- **Job detail** — full info including venue, times, equipment list (from HireHop), fees
- **Completion form** — signature OR photos (toggleable "customer not present"), equipment checklist from HireHop, notes, client email for delivery note
- **PDF delivery notes** — generated async via Netlify function with Ooosh branding, equipment list, signature/photo embeds
- **Email notifications** — job confirmation, updates, cancellations to freelancers; delivery notes to clients; driver notes to staff
- **Vehicle book-out integration** — links to vehicle management for van jobs

### OP systems already built

- **Transport Calculator** — full costing engine (hourly/day rate, delivery/collection/crewed)
- **Quotes table** — stores all calculated costs, linked to jobs and venues
- **Quote assignments** — crew/freelancer assignments with role, rate, status
- **Vehicle hire assignments** — full lifecycle (soft → confirmed → booked_out → active → returned)
- **Dispatch gate** — checks excess/referral blockers before dispatch
- **HireHop broker** — centralised API gateway with rate limiting and caching
- **Email service** — templated email sending with test mode
- **Socket.io** — real-time updates infrastructure
- **Job requirements** — database + API for prep checklist items

## Architecture Approach

### Data flow

```
Transport Calculator ──→ Quote saved ──→ Crew assigned ──→ Quote confirmed
   OR                                                          ↓
Local Delivery ────────→ Quote saved ──────────────────→ Quote confirmed
                                                               ↓
                                         Operations Page (staff view)
                                                               ↓
                                         Freelancer Portal (freelancer view)
                                                               ↓
                                         Completion (signature/photos/notes)
                                                               ↓
                                         PDF + Email + Status update
```

### What lives where

| Concern | Location | Notes |
|---------|----------|-------|
| Quote creation & costing | Existing: Job Detail → Crew & Transport tab | Already built |
| **Local delivery/collection** | **NEW: Job Detail → "Add Local" button** | Fixed cost, no calculator |
| Crew assignment | Existing: Job Detail → Crew & Transport tab | Already built |
| Operations overview | **NEW: `/operations/transport`** | Staff view, replaces Monday.com D&C board |
| Calendar view | **NEW: on operations page** | Timeline/calendar for future planning |
| Freelancer job view | Existing: `/src/app/job/[id]/page.tsx` | Repoint from Monday → OP API |
| Freelancer dashboard | Existing: `/src/app/dashboard/page.tsx` | Repoint from Monday → OP API |
| Completion flow | Existing: `/src/app/job/[id]/complete/page.tsx` | Repoint submissions to OP API |
| PDF generation | Migrate from Netlify function → OP backend service | Use existing email service |
| Operational status tracking | **NEW: fields on quotes table** | See schema changes below |

### Freelancer linking

Freelancers are `people` records with `is_freelancer = true` AND `is_approved = true`, linked to quotes via `quote_assignments`. The portal auth uses OP JWT tokens — match the user's email to their `people.id` and query their assignments.

**Staff visibility:** Any OP user with role `admin`, `manager`, or `staff` sees ALL operations on the ops page. They can also use the portal completion flow for in-house deliveries. When assigning, staff can select "Ooosh crew" (sets a flag on the assignment) without assigning a specific person — useful when "one of us will do it" but you haven't decided who yet.

---

## Phase 1: Operations Pages (Staff View)

### Schema changes — Migration 024

**Add to `quotes` table:**
```sql
-- Operational status (independent of commercial quote status)
ALTER TABLE quotes ADD COLUMN ops_status VARCHAR(30) DEFAULT 'todo';
-- Values: 'todo', 'arranging', 'arranged', 'dispatched', 'arrived', 'completed', 'cancelled'

-- Completion tracking
ALTER TABLE quotes ADD COLUMN completed_at TIMESTAMPTZ;
ALTER TABLE quotes ADD COLUMN completed_by VARCHAR(255);
ALTER TABLE quotes ADD COLUMN completion_notes TEXT;
ALTER TABLE quotes ADD COLUMN completion_signature TEXT;     -- R2 key
ALTER TABLE quotes ADD COLUMN completion_photos JSONB DEFAULT '[]';  -- array of R2 keys
ALTER TABLE quotes ADD COLUMN customer_present BOOLEAN;

-- Arranging details
ALTER TABLE quotes ADD COLUMN key_points TEXT;               -- key points / flight info / driver briefing
ALTER TABLE quotes ADD COLUMN client_introduction TEXT;      -- intro'd client to driver
ALTER TABLE quotes ADD COLUMN tolls_status VARCHAR(20) DEFAULT 'not_needed';
ALTER TABLE quotes ADD COLUMN accommodation_status VARCHAR(20) DEFAULT 'not_needed';
ALTER TABLE quotes ADD COLUMN flight_status VARCHAR(20) DEFAULT 'not_needed';

-- Crewed job specifics
ALTER TABLE quotes ADD COLUMN work_description TEXT;
ALTER TABLE quotes ADD COLUMN work_type VARCHAR(50);
-- Picklist: 'Backline Tech', 'Runner/Driver', 'General Assist', 'FOH', 'Sound',
--           'Lighting', 'Stage', 'Video', 'Rigging', 'Catering', 'Other'
ALTER TABLE quotes ADD COLUMN work_type_other TEXT;          -- custom text when work_type = 'Other'

-- Run grouping (multi-drop / combined jobs)
ALTER TABLE quotes ADD COLUMN run_group UUID;                -- shared UUID groups quotes into a run
ALTER TABLE quotes ADD COLUMN run_group_fee NUMERIC(10,2);   -- override combined fee (set on first quote in group)
ALTER TABLE quotes ADD COLUMN run_order INTEGER;             -- sequence within the run (1, 2, 3...)

-- Local delivery/collection flag (no calculator, fixed cost)
ALTER TABLE quotes ADD COLUMN is_local BOOLEAN DEFAULT false;
```

**Add to `quote_assignments` table:**
```sql
-- Freelancer confirmation
ALTER TABLE quote_assignments ADD COLUMN confirmed_at TIMESTAMPTZ;
ALTER TABLE quote_assignments ADD COLUMN declined_at TIMESTAMPTZ;
ALTER TABLE quote_assignments ADD COLUMN decline_reason TEXT;

-- "Ooosh crew" flag (in-house, no specific person needed)
ALTER TABLE quote_assignments ADD COLUMN is_ooosh_crew BOOLEAN DEFAULT false;

-- Expense tracking (for future invoice comparison)
ALTER TABLE quote_assignments ADD COLUMN expected_expenses NUMERIC(10,2);
ALTER TABLE quote_assignments ADD COLUMN actual_expenses NUMERIC(10,2);
ALTER TABLE quote_assignments ADD COLUMN expense_notes TEXT;
ALTER TABLE quote_assignments ADD COLUMN invoice_received BOOLEAN DEFAULT false;
ALTER TABLE quote_assignments ADD COLUMN invoice_amount NUMERIC(10,2);
ALTER TABLE quote_assignments ADD COLUMN invoice_queried BOOLEAN DEFAULT false;
ALTER TABLE quote_assignments ADD COLUMN invoice_query_notes TEXT;
```

### Local delivery/collection

For short-distance, fixed-cost jobs that don't need the full calculator:

**Job Detail → Crew & Transport tab:**
- New button: **"+ Add Local Delivery/Collection"** (next to existing "+ New Calculation")
- Opens a simple form:
  - Type: Delivery / Collection (toggle)
  - Date & time
  - Venue (searchable, from address book)
  - Fixed fee (£ input, defaults to setting `local_delivery_fee`)
  - Notes
- Saves as a quote with `is_local = true`, `job_type`, `venue_id`, `freelancer_fee_rounded`, `job_date`, `arrival_time`
- No distance/fuel/expense calculation — just the fixed cost
- All other ops features (status tracking, completion, portal visibility) work identically

### Operations page: `/operations/transport`

**Purpose:** Replace Monday.com "Deliveries & Collections" board. Combined view for deliveries AND collections (filtered by `job_type IN ('delivery', 'collection')`). Crew operations are a separate tab/view.

**Two views:**
1. **Table view** (default) — grouped by ops_status sections
2. **Calendar view** — month/week view for forward planning

#### Table view

**Sections (collapsible, with counts):**

1. **To Be Arranged** — `ops_status = 'todo'` AND `quote.status = 'confirmed'`
   - Sort: by date (earliest first), urgency indicators for < 7 days, < 3 days
   - Shows what's missing: no driver (amber), no time (amber), date < 3 days away and not arranged (red)

2. **Arranging** — `ops_status = 'arranging'`
   - Shows what's still outstanding (tolls to book? client intro needed? etc.)

3. **Upcoming (Arranged)** — `ops_status = 'arranged'`, date in future
   - Everything confirmed, chronological sort

4. **Active / On the Road** — `ops_status IN ('dispatched', 'arrived')`
   - Currently happening

5. **Recently Completed** — `ops_status = 'completed'`, last 14 days
   - Collapsed by default
   - Completion date, photo/signature indicator

6. **TBC (Still a Quote)** — `quote.status = 'draft'` (not yet confirmed)
   - Quotes without dates, or unconfirmed
   - Collapsed by default

**Row data:**

| Column | Source | Notes |
|--------|--------|-------|
| Type | `job_type` | DEL / COL badge |
| Job | `jobs.job_name` + HH# | Link to Job Detail |
| Client | `jobs.client_name` | |
| Date | `job_date` | Date pill, red if overdue |
| Time | `arrival_time` | |
| Venue | `venue_name` | Link to venue in address book |
| Driver | `quote_assignments` | Name or "Ooosh crew" or "Unassigned" |
| Client £ | `client_charge_rounded` | |
| Fee £ | `freelancer_fee_rounded` | |
| Key points | `key_points` | Truncated |
| Status | `ops_status` | Dropdown |
| Flags | Computed | Tolls/accommodation/flights badges if not 'not_needed' |

**Run groups:** Quotes sharing a `run_group` UUID are visually grouped (indented, or in a sub-row). The group header shows the combined fee override if set.

**Quick actions per row:**
- Change `ops_status` via inline dropdown
- Assign/change driver (inline search)
- Edit key points, dates, times (inline or slide panel)
- Mark tolls/accommodation/flights status
- Group/ungroup quotes into runs
- Link to Job Detail, link to portal completion page

#### Calendar view

**Purpose:** Forward planning — see what's coming up in a visual timeline.

- Month view (default) with week toggle
- Each day shows delivery/collection cards
- Colour coded by ops_status:
  - Grey: TBC (draft)
  - Amber: To be arranged
  - Blue: Arranging
  - Green: Arranged/upcoming
  - Purple: Active
  - Dark green: Completed
- Click a card → navigates to that quote row in table view, or opens detail
- Drag to reschedule (updates `job_date`)
- "No date" section for TBC quotes

### Operations page: Crew tab

**Same page, tab toggle:** The `/operations/transport` page has two tabs:
- **Deliveries & Collections** (default)
- **Crewed Jobs**

The Crew tab filters to `job_type = 'crewed'` and shows different columns:

| Column | Source | Notes |
|--------|--------|-------|
| Work Type | `work_type` | Badge (or custom text if "Other") |
| Description | `work_description` | |
| Job | `jobs.job_name` + HH# | Link |
| Crew | `quote_assignments` | Names |
| Client £ | `client_charge_rounded` | |
| Crew fee | `freelancer_fee_rounded` | |
| Start | `job_date` + `arrival_time` | |
| End | Computed | From `num_days` or `collection_date` |
| Days | `num_days` | |
| Venue | `venue_name` | Linked |
| Expenses | `expenses_included` / `expenses_not_included` | |
| Status | `ops_status` | Dropdown |

### Reminder system

**Scheduled task** (add to `config/scheduler.ts`, runs daily at 09:00):
- `ops_status = 'todo'` AND `job_date` within 7 days → warning notification
- `ops_status = 'todo'` AND `job_date` within 3 days → URGENT notification
- `tolls_status = 'todo'` AND `job_date` within 3 days → "Tolls still to be booked"
- `ops_status NOT IN ('completed', 'cancelled')` AND `job_date` is past → "Overdue: not marked complete"
- Creates in-app notifications + optionally emails via email service

### Change notifications to freelancers

When staff update a confirmed quote's date, time, or venue:
- Detect changes in the PUT endpoint
- If `ops_status IN ('arranged', 'dispatched')` and quote has assignments:
  - Email assigned freelancers: "Update: Your [type] for [job] has changed — [what changed]"
  - Create in-app notification

---

## Phase 2: Freelancer Portal Repointing

### Strategy

Repoint the existing portal from Monday.com to OP backend API **without rebuilding the UI**. The portal UI and completion flow are solid — we just swap the data layer.

### New OP backend endpoints (for portal consumption)

These use the existing OP JWT auth system. Freelancers log in via `/api/auth/login` with their OP credentials.

```
GET  /api/portal/jobs                    — freelancer's assigned jobs (or all, for staff)
GET  /api/portal/jobs/:quoteId           — single job detail (quote + job + venue + assignments)
GET  /api/portal/jobs/:quoteId/equipment — HireHop equipment list (via broker, filtered)
POST /api/portal/jobs/:quoteId/complete  — submit completion (signature/photos/notes)
GET  /api/portal/jobs/:quoteId/files     — job + venue files available to freelancer
```

**`GET /api/portal/jobs`** — returns quotes assigned to the authenticated user:
```sql
SELECT q.*, j.job_name, j.hirehop_id, j.client_name,
       qa.role, qa.agreed_rate, qa.rate_type, qa.status as assignment_status
FROM quotes q
JOIN jobs j ON q.job_id = j.id
JOIN quote_assignments qa ON qa.quote_id = q.id
JOIN people p ON qa.person_id = p.id
WHERE p.id = (SELECT person_id FROM users WHERE id = $1)
  AND q.status = 'confirmed'
  AND q.ops_status NOT IN ('cancelled')
ORDER BY q.job_date, q.arrival_time
```

For staff users (role != freelancer), return ALL confirmed quotes.

**Run grouping in portal:** Quotes sharing a `run_group` are returned together. Portal displays them as a grouped run (do A → B → C) with the `run_group_fee` as the combined payment.

**`POST /api/portal/jobs/:quoteId/complete`** — accepts:
```json
{
  "notes": "string",
  "signature": "base64 image data (if customer present)",
  "photos": ["base64 image data (if customer not present)"],
  "customer_present": true,
  "client_emails": ["email@example.com"],
  "send_client_email": true,
  "checked_items": [{ "id": "number", "checked_qty": "number" }]
}
```

Processing:
1. Upload signature to R2 → store key in `quotes.completion_signature`
2. Upload photos to R2 → store keys in `quotes.completion_photos`
3. Set `ops_status = 'completed'`, `completed_at`, `completion_notes`, `customer_present`
4. Trigger async: generate PDF delivery note, email to client(s), alert to staff
5. Return success with warnings array

### Portal auth migration

**Current:** Separate Next.js JWT in HTTP-only cookie, users registered on Monday.com freelancer board.
**Target:** OP JWT tokens. Freelancers are `users` with `role = 'freelancer'`.

**Migration path:**
1. Portal login page calls OP `/api/auth/login` instead of its own `/api/auth/login`
2. Portal stores OP access/refresh tokens (same as main OP app)
3. Portal API calls use `Authorization: Bearer` header to OP backend
4. Portal refresh flow uses OP `/api/auth/refresh`
5. Remove Monday.com credential lookup entirely

### Equipment list via HireHop broker

```
GET /api/portal/jobs/:quoteId/equipment
```

Backend resolves `quoteId` → `jobs.hirehop_id`, then uses `hhBroker.get('/frames/items_to_supply_list.php', { job: hirehopId })` with the same filtering logic from `src/lib/hirehop.ts`:
- If `what_is_it = 'equipment'`: exclude vehicle categories (369-371) and service categories (496-500)
- If `what_is_it = 'vehicle'`: show all
- Always exclude virtual items

### PDF delivery notes

Migrate from Netlify function (`netlify/functions/completion-background.ts`) to OP backend service:
- Port `src/lib/pdf.ts` to `backend/src/services/delivery-note-pdf.ts`
- Uses pdf-lib (pure JS, already in deps or easy to add)
- Triggered after completion submission
- PDF stored in R2
- Sent to client via OP email service

### Files access

```
GET /api/portal/jobs/:quoteId/files
```
Returns combined files from `jobs.files` + `venues.files` for the linked job/venue. Only files tagged as "freelancer-visible" or all files (TBD — start with all non-sensitive files).

---

## Phase 3: Invoice Comparison (Future)

Manual for now — staff visually compare freelancer invoice to agreed rate + expected expenses on the ops page.

**Future upgrade (not in this build):**
- AI/OCR reading uploaded invoices
- Auto-comparison to `agreed_rate` + `expected_expenses`
- Overcharge flagging
- Query workflow

---

## Nav Structure

```typescript
{
  path: '/operations-menu',
  label: 'Operations',
  children: [
    { path: '/operations/transport', label: 'Crew & Transport' },
    // Future: Deliveries, Backline, Rehearsals, etc.
  ],
}
```

---

## Implementation Order (EOD 19 March target)

### Phase 1A — Schema + Backend
1. Migration 024: ops fields on quotes + assignments
2. Backend: quote ops_status PATCH endpoint, local delivery creation
3. Backend: portal API endpoints (jobs list, detail, equipment, completion, files)
4. Backend: ops reminder scheduler

### Phase 1B — Operations Page + Calendar
5. `/operations/transport` page — table view with sections
6. Status dropdown, driver assignment, inline editing
7. Run group management (group/ungroup, fee override)
8. Calendar view (month/week, colour coded, drag to reschedule)
9. Crew tab (same page, filtered to crewed jobs)
10. Nav: Operations → Crew & Transport

### Phase 1C — Job Detail Enhancements
11. "Add Local Delivery/Collection" button + form on Job Detail
12. Work type picker for crewed quotes

### Phase 2 — Portal Repointing
13. Portal auth → OP JWT login
14. Portal dashboard → OP `/api/portal/jobs`
15. Portal job detail → OP `/api/portal/jobs/:id`
16. Portal completion → OP `/api/portal/jobs/:id/complete`
17. Portal equipment → OP `/api/portal/jobs/:id/equipment`
18. PDF delivery notes → OP backend service
19. Client/staff emails → OP email service

### Phase 1D — Reminders + Notifications (can follow shortly after)
20. Scheduled reminder system (09:00 daily)
21. Change notification emails to freelancers
