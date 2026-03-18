# Transport & Crew Operations Spec

**Status:** DRAFT — pending approval
**Date:** 18 March 2026
**Depends on:** Quotes system (complete), Vehicle hire assignments (complete), Job requirements (migration complete), Freelancer portal (exists, needs repointing)

## Overview

This spec covers two interconnected systems:

1. **Transport & Crew Operations Page** — the internal "control room" for staff, replacing the Monday.com "Deliveries & Collections" and "Crewed Jobs" boards
2. **Freelancer Portal Repointing** — switching the existing freelancer-facing Next.js app from Monday.com data to the OP backend API

These are two sides of the same coin: staff manage operations on the OP; freelancers see their assignments on the portal. Both read from the same database.

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
- **Dashboard** — grouped job cards (Today / Upcoming / Completed / Cancelled)
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
Transport Calculator → Quote saved → Crew assigned → Quote confirmed
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
| Crew assignment | Existing: Job Detail → Crew & Transport tab | Already built |
| Operations overview | **NEW: `/operations/transport`** | Staff view, replaces Monday.com |
| Crew overview | **NEW: `/operations/crew`** | Staff view for crewed work |
| Freelancer job view | Existing: `/src/app/job/[id]/page.tsx` | Repoint from Monday → OP API |
| Freelancer dashboard | Existing: `/src/app/dashboard/page.tsx` | Repoint from Monday → OP API |
| Completion flow | Existing: `/src/app/job/[id]/complete/page.tsx` | Repoint submissions to OP API |
| PDF generation | Migrate from Netlify function → OP backend service | Use existing email service |
| Operational status tracking | **NEW: fields on quotes table** | See schema changes below |

### Freelancer linking

Currently Monday.com links freelancers by email address. In the OP, freelancers are `people` records with `is_freelancer = true` and linked to quotes via `quote_assignments`. The portal auth already uses email-based JWT — we just need to match the portal user's email to their `people.id` and then query their assignments.

For in-house staff (currently `info@oooshtours.co.uk`), we can either:
- **Option A:** Create a shared "Ooosh Crew" person record that gets assigned to in-house deliveries
- **Option B:** Let any OP user access the portal view via their existing OP session (role-based: if you're staff+ you see all assignments, not just your own)
- **Recommended: Option B** — simplest, no fake person records, staff see everything

---

## Phase 1: Operations Pages (Staff View)

### Schema changes

**Add to `quotes` table:**
```sql
-- Operational status (independent of commercial quote status)
ALTER TABLE quotes ADD COLUMN ops_status VARCHAR(30) DEFAULT 'todo';
-- Values: 'todo', 'arranging', 'arranged', 'dispatched', 'arrived', 'completed', 'cancelled'

-- Completion tracking
ALTER TABLE quotes ADD COLUMN completed_at TIMESTAMPTZ;
ALTER TABLE quotes ADD COLUMN completed_by VARCHAR(255);  -- who marked complete
ALTER TABLE quotes ADD COLUMN completion_notes TEXT;
ALTER TABLE quotes ADD COLUMN completion_signature TEXT;    -- R2 key
ALTER TABLE quotes ADD COLUMN completion_photos JSONB DEFAULT '[]';  -- array of R2 keys
ALTER TABLE quotes ADD COLUMN customer_present BOOLEAN;

-- Arranging details
ALTER TABLE quotes ADD COLUMN key_points TEXT;              -- key points / flight info
ALTER TABLE quotes ADD COLUMN client_introduction TEXT;     -- intro'd client to driver
ALTER TABLE quotes ADD COLUMN tolls_status VARCHAR(20) DEFAULT 'not_needed';
-- Values: 'not_needed', 'todo', 'booked', 'paid'
ALTER TABLE quotes ADD COLUMN accommodation_status VARCHAR(20) DEFAULT 'not_needed';
-- Values: 'not_needed', 'todo', 'booked'
ALTER TABLE quotes ADD COLUMN flight_status VARCHAR(20) DEFAULT 'not_needed';
-- Values: 'not_needed', 'todo', 'booked'

-- Crewed job specifics
ALTER TABLE quotes ADD COLUMN work_description TEXT;        -- e.g. "backline and transport"
ALTER TABLE quotes ADD COLUMN work_type VARCHAR(50);        -- e.g. "Backline Tech", "Runner/Driver"
```

**Add to `quote_assignments` table:**
```sql
-- Freelancer confirmation
ALTER TABLE quote_assignments ADD COLUMN confirmed_at TIMESTAMPTZ;
ALTER TABLE quote_assignments ADD COLUMN declined_at TIMESTAMPTZ;
ALTER TABLE quote_assignments ADD COLUMN decline_reason TEXT;

-- Expense tracking (for invoice comparison)
ALTER TABLE quote_assignments ADD COLUMN expected_expenses NUMERIC(10,2);
ALTER TABLE quote_assignments ADD COLUMN actual_expenses NUMERIC(10,2);
ALTER TABLE quote_assignments ADD COLUMN expense_notes TEXT;
ALTER TABLE quote_assignments ADD COLUMN invoice_received BOOLEAN DEFAULT false;
ALTER TABLE quote_assignments ADD COLUMN invoice_amount NUMERIC(10,2);
ALTER TABLE quote_assignments ADD COLUMN invoice_queried BOOLEAN DEFAULT false;
ALTER TABLE quote_assignments ADD COLUMN invoice_query_notes TEXT;
```

### Operations page: `/operations/transport`

**Purpose:** Replace Monday.com "Deliveries & Collections" board. Global view of all delivery/collection quotes across all jobs.

**Sections (collapsible, with counts):**

1. **To Be Arranged** — `ops_status = 'todo'` AND `quote.status = 'confirmed'`
   - Needs: driver, time confirmed, venue confirmed, client intro
   - Sort: by date (earliest first), then by urgency (closer = higher)

2. **Arranging** — `ops_status = 'arranging'`
   - In progress: some details still TBC
   - Shows what's still missing (no driver? no time? tolls to book?)

3. **Upcoming (Arranged)** — `ops_status = 'arranged'`, date in future
   - Everything confirmed, waiting for the day
   - Sort: chronological

4. **Active / On the Road** — `ops_status IN ('dispatched', 'arrived')`
   - Currently happening
   - Real-time status updates

5. **Recently Completed** — `ops_status = 'completed'`, last 14 days
   - Collapsed by default
   - Shows completion date, notes, photo/signature indicator

6. **TBC (Still a Quote)** — `quote.status = 'draft'` (not yet confirmed)
   - Quotes that haven't been confirmed yet
   - May not have dates

**Row data (table layout):**

| Column | Source | Notes |
|--------|--------|-------|
| Type | `job_type` | DEL / COL badge, colour coded |
| What | `what_is_it` | Equipment / Vehicle / People badge |
| Job | `jobs.job_name` + `jobs.hirehop_id` | Link to Job Detail |
| Client | `jobs.client_name` | From job |
| Date | `job_date` (+ `collection_date`) | Date pill |
| Time | `arrival_time` | Time display |
| Venue | `venue_name` → link to venue | From quote, linked to address book |
| Driver | `quote_assignments` where role = driver | Person name, linked to People |
| Client charge | `client_charge_rounded` | £ formatted |
| Freelancer fee | `freelancer_fee_rounded` | £ formatted |
| Key points | `key_points` | Truncated, expandable |
| Tolls | `tolls_status` | Badge: not needed / to do / booked / paid |
| Status | `ops_status` | Dropdown to change |
| Arranging flags | Computed | Missing items highlighted in amber/red |

**Quick actions per row:**
- Change `ops_status` via dropdown
- Assign/change driver (slide panel with freelancer search)
- Edit key points inline
- Mark tolls/accommodation/flights status
- "Complete" button → opens completion modal (or link to portal completion page)
- Link to Job Detail → Crew & Transport tab

**Summary bar:**
- Total quotes in view
- Sum of client charges, freelancer fees, margin
- Count by type (X deliveries, Y collections)

### Operations page: `/operations/crew`

**Purpose:** Replace Monday.com "Crewed Jobs" board. Same structure but for `job_type = 'crewed'` quotes.

**Sections:** Same as transport (To Be Arranged / Arranging / Upcoming / Active / Completed / TBC)

**Row data (different columns for crew):**

| Column | Source | Notes |
|--------|--------|-------|
| Work Type | `work_type` | Backline Tech, Runner/Driver, etc. |
| Description | `work_description` | Free text |
| Job | `jobs.job_name` + `jobs.hirehop_id` | Link to Job Detail |
| Crew | `quote_assignments` | Person name(s) |
| Client charge | `client_charge_rounded` | £ formatted |
| Crew fee | `freelancer_fee_rounded` | £ formatted |
| Start date | `job_date` | |
| Start time | `arrival_time` | |
| End date | Computed from `num_days` or `collection_date` | |
| No. days | `num_days` | |
| Venue | `venue_name` | Linked |
| Expenses (incl.) | `expenses_included` | £ from calculator |
| Expenses (not incl.) | `expenses_not_included` | £ from calculator |
| Status | `ops_status` | Dropdown |

### Reminder system

**Scheduled task** (add to `config/scheduler.ts`):
- Runs daily at 09:00
- Finds quotes where:
  - `ops_status = 'todo'` AND `job_date` within 7 days → notification: "Delivery for [job] on [date] has no driver assigned"
  - `ops_status = 'todo'` AND `job_date` within 3 days → URGENT notification
  - `ops_status = 'arranged'` AND `tolls_status = 'todo'` AND `job_date` within 3 days → "Tolls still to be booked for [job]"
  - Any `ops_status NOT IN ('completed', 'cancelled')` AND `job_date` is past → "Overdue: [job] not marked complete"
- Creates in-app notifications (existing `notifications` table)
- Optionally sends email via email service

### Change notifications to freelancers

When staff update a confirmed quote's date, time, or venue:
- Detect field changes in the PUT endpoint
- If the quote has assignments and `ops_status IN ('arranged', 'dispatched')`:
  - Send email to assigned freelancers: "Update: Your [delivery/collection/crew] for [job] has changed — [what changed]"
  - Create notification record

---

## Phase 2: Freelancer Portal Repointing

### Strategy

The freelancer portal (Next.js app in `/src/`) currently reads from Monday.com. We repoint it to the OP backend API **without rebuilding the UI**. The portal UI is good — we just swap the data layer.

### New OP backend endpoints (for portal consumption)

These endpoints use the **existing OP JWT auth** (freelancer role), not the portal's separate session system.

```
GET  /api/portal/jobs                    — freelancer's assigned jobs
GET  /api/portal/jobs/:quoteId           — single job detail
GET  /api/portal/jobs/:quoteId/equipment — HireHop equipment list (via broker)
POST /api/portal/jobs/:quoteId/complete  — submit completion
GET  /api/portal/jobs/:quoteId/files     — job + venue files
```

**`GET /api/portal/jobs`** — returns quotes assigned to the authenticated user:
```sql
SELECT q.*, j.job_name, j.hirehop_id, j.client_name,
       qa.role, qa.agreed_rate, qa.rate_type, qa.status as assignment_status
FROM quotes q
JOIN jobs j ON q.job_id = j.id
JOIN quote_assignments qa ON qa.quote_id = q.id
JOIN people p ON qa.person_id = p.id
JOIN users u ON u.person_id = p.id
WHERE u.id = $1
  AND q.status = 'confirmed'
  AND q.ops_status NOT IN ('cancelled')
ORDER BY q.job_date, q.arrival_time
```

For staff users (role != freelancer), return ALL confirmed quotes (they see everything).

**`POST /api/portal/jobs/:quoteId/complete`** — accepts:
```json
{
  "notes": "string",
  "signature": "base64 image data",
  "photos": ["base64 image data"],
  "customer_present": true,
  "client_emails": ["email@example.com"],
  "send_client_email": true
}
```

Processing:
1. Upload signature to R2 → store key in `quotes.completion_signature`
2. Upload photos to R2 → store keys in `quotes.completion_photos`
3. Set `ops_status = 'completed'`, `completed_at = NOW()`, `completion_notes`, `customer_present`
4. Trigger async: generate PDF delivery note, email to client, alert to staff
5. Return success with any warnings

### Portal auth migration

**Current:** Separate Next.js JWT session, users registered against Monday.com freelancer board.
**Target:** Use OP JWT tokens. Freelancers are `users` with `role = 'freelancer'`.

**Migration path:**
1. Add OP backend login endpoint that issues tokens to freelancer-role users
2. Update portal login page to call OP `/api/auth/login` instead of its own
3. Portal stores OP access token, sends as `Authorization: Bearer` header
4. Portal API calls go to OP backend endpoints
5. Remove Monday.com dependency entirely

### Equipment list via HireHop broker

The portal currently calls HireHop directly for equipment lists. Repoint to go through the OP's HireHop broker:

```
GET /api/portal/jobs/:quoteId/equipment
```

Backend uses `hhBroker.get('/frames/items_to_supply_list.php', { job: hirehopId })` with the same filtering logic currently in `src/lib/hirehop.ts`.

### PDF delivery notes

Migrate from Netlify function to OP backend service:
- Port `src/lib/pdf.ts` logic to `backend/src/services/delivery-note-pdf.ts`
- Use same pdf-lib approach (it's pure JS, no platform dependency)
- Trigger after completion via the existing email service
- Store generated PDF in R2

### Files access

Freelancers need access to job files and venue files:
```
GET /api/portal/jobs/:quoteId/files
```
Returns combined files from `jobs.files` + `venues.files` for the linked job/venue.

---

## Phase 3: Invoice Comparison

After Phase 2 is live and freelancers are completing jobs through the OP:

- Freelancer submits invoice (amount + receipt upload)
- System compares to `agreed_rate` + `expected_expenses` from quote assignment
- Flags overcharges automatically
- Staff can mark as queried, with notes
- Ties into payment workflow (future Stream 6)

---

## Implementation Order

### Phase 1A — Schema + Backend (no UI yet)
1. Migration: add ops fields to quotes + assignments tables
2. Backend endpoints: ops status transitions, completion submission, reminder scheduler
3. Portal API endpoints (so Phase 2 can start in parallel)

### Phase 1B — Transport Operations Page
4. `/operations/transport` page with table layout and sections
5. Status dropdown, driver assignment, inline editing
6. Summary bar, filtering, sorting
7. Add to nav under "Jobs" dropdown or new "Operations" group

### Phase 1C — Crew Operations Page
8. `/operations/crew` page (similar structure, different columns)
9. Work type categorisation, expense tracking

### Phase 1D — Reminders + Notifications
10. Scheduled reminder system
11. Change notification emails to freelancers

### Phase 2A — Portal Auth Migration
12. Freelancer login via OP auth
13. Portal API calls repointed to OP backend

### Phase 2B — Portal Data Repointing
14. Dashboard reads from OP
15. Job detail reads from OP
16. Completion submits to OP
17. Equipment list via HireHop broker

### Phase 2C — PDF + Email Migration
18. Delivery note PDF generation in OP backend
19. Client emails via OP email service
20. Staff alerts via OP notifications

### Phase 3 — Invoice Comparison
21. Invoice submission + comparison UI
22. Overcharge flagging and query workflow

---

## Nav structure

Add "Operations" to the nav:
```typescript
{
  path: '/operations',
  label: 'Operations',
  children: [
    { path: '/operations/transport', label: 'Transport' },
    { path: '/operations/crew', label: 'Crew' },
  ],
}
```

Or extend the existing "Jobs" dropdown:
```typescript
children: [
  { path: '/pipeline', label: 'Enquiries' },
  { path: '/jobs', label: 'Upcoming & Out Now' },
  { path: '/operations/transport', label: 'Transport Ops' },
  { path: '/operations/crew', label: 'Crew Ops' },
],
```

**Recommended:** Separate "Operations" nav group — it's a different mental model from the pipeline/jobs view.

---

## Open questions

1. **Nav placement** — "Operations" as its own top-level nav group, or nested under "Jobs"?
2. **In-house staff on portal** — Option B (staff see all via OP session) vs shared account?
3. **Equipment checklist on ops page** — should staff see the HireHop equipment list on the ops page too, or only via the freelancer portal completion flow?
4. **Multi-drop runs** — the portal currently groups multi-drop deliveries by `runGroup`. Do we need this grouping concept in the OP? (Multiple quotes on the same date for the same driver = a "run")
5. **Work types for crewed jobs** — fixed picklist or freeform? Current Monday.com uses: Backline Tech, Runner/Driver, General Assist, FOH, Sound, Lighting, Stage, Video, Rigging, Catering, Other
