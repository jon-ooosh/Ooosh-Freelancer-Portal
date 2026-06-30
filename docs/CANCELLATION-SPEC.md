# Cancellation System Spec

**Status:** In progress (Apr 2026)
**Depends on:** Money System (Step 3), Status Transition Engine (Step 4), Hire Form system

## Overview

The OP needs a proper cancellation workflow that distinguishes between **lost enquiries** (never confirmed) and **cancelled bookings** (were confirmed, now cancelled). Currently both map to the same `lost` pipeline status and HH status 10 (Not Interested), which loses important context and doesn't trigger any of the operational cleanup needed when a confirmed job is cancelled.

## Concepts

### Lost vs Cancelled

| Scenario | Pipeline Status | HH Status | Has been confirmed? | Financial implications? |
|----------|----------------|-----------|---------------------|------------------------|
| **Lost** (never confirmed) | `lost` | 10 (Not Interested) | No | None — no money taken |
| **Cancelled** (was confirmed, now cancelled) | `cancelled` | 9 (Cancelled) | Yes | Cancellation fee, refund calculation, crew notification, vehicle de-allocation |
| **Shortened** (partial cancellation / early return) | N/A | N/A | Yes | Partial refund — deferred to future work |

### T&Cs Reference (Clause 7)

#### 7.1 — Pre-hire Cancellation

| Notice period | Charge | Minimum |
|---------------|--------|---------|
| >7 days before hire start | 10% of hire fee | £25+VAT |
| 2-7 days before hire start | 25% of hire fee | £25+VAT |
| <2 days before hire start | 100% of hire charge OR one week + early return sliding scale (7.3), whichever is **lesser** |

Transport/delivery charges are chargeable in addition at discretion.

#### 7.3 — Early Return (existing calculator — also used for <2 day cap comparison)

Three hire types with different billing models:

| Type | Billing model | Min charge after use |
|------|---------------|----------------------|
| Vehicle | Daily rate (cost / total days) | 7 calendar days |
| Backline | 4-day billing cycle (days 5-7 free per week) | 7 calendar days = 4 billable days |
| Week Rate | Weekly blocks (7 days = 1 unit) | 7 calendar days = 1 billable week |

Refund tiers after minimum 7-day charge:
- Days 8-14: **50% refund**
- Days 15-30: **75% refund**
- Days 31+: **90% refund**

### Financial Input

The cancellation calculator should use the **post-VAT-adjustment** hire value (from `vat-adjustment.ts`) when available, since international jobs may have reduced VAT. This gives the most accurate figure.

## Status Model

### New Pipeline Status: `cancelled`

Add to the `PipelineStatus` type union and config:

```typescript
export type PipelineStatus = '...' | 'cancelled';

cancelled: { label: 'Cancelled', colour: '#DC2626', order: 7 }  // Red
```

### HireHop Mapping (split from current)

| Pipeline Status | HH Code | HH Name |
|----------------|---------|---------|
| `lost` | 10 | Not Interested |
| `cancelled` | 9 | Cancelled |

Currently both HH 9 and 10 map inbound to `lost`. After this change:
- HH 9 (Cancelled) → OP `cancelled`
- HH 10 (Not Interested) → OP `lost`

### Database Changes (Migration 047)

```sql
-- Add cancelled to pipeline_status enum constraint (if using CHECK)
-- New fields on jobs table:
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_fee DECIMAL(10,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_refund DECIMAL(10,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_notice_days INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_notes TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_tier VARCHAR(20);
-- Tier: '>7_days', '2_to_7_days', '<2_days'
```

## Cancellation Workflow

### Trigger

When a user transitions a **confirmed+** job to `cancelled` status (from any post-confirmation status: confirmed, prepped, dispatched, returned_incomplete, returned).

### RBAC

- **Admin/Manager**: Full access — can process cancellations
- **Staff/General Assistant/Weekend Manager**: Can view everything, but the "Confirm Cancellation" button is replaced with a "Refer to Manager" flag that creates a notification for managers

### Step 1: Cancellation Modal

Triggered on status change to `cancelled`. Modal (similar to completion retro modal) contains:

**Section A — Calculator**
- Auto-populated inputs: hire value (post-VAT-adjusted), hire start date, today's date
- Auto-computed: notice period (days), applicable tier, cancellation fee, refund amount
- Breakdown text explaining the calculation
- Hire type selector if multiple types on job (vehicle/backline/week)

**Section B — Transport & Crew Costs**
- Shows associated transport quotes and crew assignments from the job
- Each item with its cost and a checkbox "Include in cancellation charge"
- Contextual info: "Driver X confirmed, Ferry booked via Y, etc."
- Allows informed decision about what transport/crew costs to pass through

**Section C — Cancellation Details**
- Cancellation reason (free text or picklist)
- Notes field
- Summary: total charge = cancellation fee + selected transport costs

**Section D — Actions Preview**
- Read-only summary of automated actions that will happen:
  - Requirements marked as not needed
  - Crew notified (list of assigned crew)
  - Vehicle assignments cancelled
  - Excess flagged for refund
  - HH invoice created for retained amount
  - HH status set to 9 (Cancelled)

### Step 2: Automated Actions (on confirmation)

All triggered transactionally when admin/manager confirms:

1. **Set status**: `pipeline_status = 'cancelled'`, populate cancellation fields, clear `next_chase_date`
2. **HH write-back**: Push status 9 (Cancelled) to HireHop
3. **Requirements**: Mark all `job_requirements` as not needed (set status to a terminal state). Do NOT void VE103B certificates — they've been issued regardless.
4. **Crew notification**: If `quote_assignments` exist with confirmed crew, send `job_cancelled_crew` email to each assigned person with an email address
5. **Vehicle de-allocation**: Set any `vehicle_hire_assignments` to `status = 'cancelled'`
6. **Excess handling**: If `job_excess` records exist with `excess_status` in active states (needed, taken, pre_auth), flag for refund — set suggested action but don't auto-process (staff handles via Money tab)
7. **HH Invoice**: Create invoice in HireHop for the retained cancellation fee amount (via `billing_deposit_save.php` or equivalent)
8. **Money tab**: Auto-create a pending refund record in `job_payments` with the calculated refund amount (staff processes actual refund via normal Money tab flow)
9. **Activity timeline**: Log `cancellation` interaction with full breakdown text
10. **Client history**: Push cancellation data to the client org's address book entry (like retro data) for future reference in hire history

### Step 3: Refund Processing (manual)

Staff processes refund through normal Money tab refund flow (already built). Refund amount pre-populated from cancellation calculation. 10-day refund timeline per T&Cs.

## Cancellation Calculator Service

**File:** `backend/src/services/cancellation-calculator.ts`

### Mode A: Pre-hire Cancellation (clause 7.1)

```typescript
interface PreHireCancellationInput {
  totalHireCost: number;       // Post-VAT-adjusted ex-VAT hire fee
  hireStartDate: Date;
  cancellationDate: Date;
  transportCharges?: number;   // Optional additional transport/crew costs
}

interface CancellationResult {
  fee: number;                 // Amount retained
  refund: number;              // Amount to return
  tier: '>7_days' | '2_to_7_days' | '<2_days';
  noticeDays: number;
  breakdown: string;           // Human-readable explanation
  minimumApplied: boolean;     // Whether £25+VAT minimum was used
  transportIncluded: number;   // Transport charges included
}
```

Logic:
- Calculate notice days: `hireStartDate - cancellationDate` in calendar days
- If >7 days: `max(totalHireCost * 0.10, 25)` (minimum £25 ex-VAT = £30 inc-VAT). The minimum MUST be the **ex-VAT** figure (25) — `totalHireCost` is ex-VAT and callers add 20% VAT for display. Using 30 here applies VAT twice (£36 inc-VAT).
- If 2-7 days: `max(totalHireCost * 0.25, 25)` (minimum £25 ex-VAT = £30 inc-VAT)
- If <2 days: `min(totalHireCost, calculateOneWeekPlusEarlyReturn(...))`
- Add transport charges on top
- refund = totalHireCost - fee

### Mode B: Early Return (clause 7.3) — port of existing calculator

```typescript
interface EarlyReturnInput {
  hireType: 'vehicle' | 'backline' | 'week';
  totalHireCost: number;
  totalHireDays: number;
  daysUsed: number;
}

interface EarlyReturnResult {
  charge: number;
  refund: number;
  breakdown: string;
}
```

### Mode C: Combined — for <2 day cancellations

Used internally by Mode A when notice <2 days, to compare 100% charge vs the one-week-plus-sliding-scale cap.

## Lost & Cancelled Page

**Route:** `/jobs/lost-cancelled`
**Nav:** Added to Jobs submenu after "Returns"

### Two Sections

**Cancelled Jobs** (pipeline_status = 'cancelled')
- Table: job name, client, original dates, cancelled date, notice period, cancellation fee, refund amount, refund status
- Colour-coded refund status: green (refunded), amber (pending), red (overdue >10 days)
- Click through to Job Detail
- Filters: date range, refund status
- Sort: cancelled date (default), refund amount, original start date

**Lost Enquiries** (pipeline_status = 'lost')
- Table: job name, client, lost date, lost reason, value
- Simpler view — no financial processing needed
- Filters: date range, lost reason
- Sort: lost date (default), value

## Job Detail Enhancements

When viewing a cancelled job:

- **Red banner** at top: "This job was cancelled on {date} — {reason}" with cancellation summary
- **Cancellation summary card**: fee retained, refund amount, refund status, tier breakdown
- **Money tab**: shows cancellation refund as a pending/completed item
- **Drivers & Vehicles tab**: all assignments shown as cancelled with timestamp
- **Activity timeline**: cancellation event with full breakdown text
- **Hire History**: cancellation data visible on client org's hire history (like retro data)

## Re-opening Cancelled Jobs

### Lost Enquiries → Easy Re-open

Moving a lost enquiry back to `new_enquiry` is straightforward — just a status change. Already supported. No financial baggage.

### Cancelled Jobs → "Re-open as New Booking"

A cancelled job has financial records, cancelled assignments, crew notifications, etc. Rather than trying to reverse all that, we create a **new job** duplicated from the original.

**Flow:**
1. "Re-open as New Booking" button on cancelled job detail
2. Calls HH API `POST /php_functions/job_duplicate.php`:
   ```
   id: {original_hh_job_number}
   supplying: 1  (copy the items list)
   job_name: "{original_name} (rebooking)"
   local: {current datetime}
   ```
3. HH returns new job number
4. OP creates new job record linked to HH, pre-populated from original (client, band, description, venue)
5. New job starts fresh: `pipeline_status = 'confirmed'`, no cancellation baggage
6. Link between original and new shown on both activity timelines:
   - Original: "Re-opened as new booking J-{new}" 
   - New: "Rebooking from cancelled job J-{original}"
7. Financial records stay on original job. Any deposits would need manual carry-across.

## Partial Cancellation (Future)

**Deferred for future work.** When a client reduces scope mid-hire (e.g. booked 3 vans, now only needs 2):
- Recalculate using cancellation calculator for the dropped portion
- Adjust hire assignments
- Potentially trigger partial refund
- More complex than full cancellation — needs careful UX design

## Files

| File | Description |
|------|-------------|
| `backend/src/services/cancellation-calculator.ts` | Calculator engine (clause 7.1 + 7.3) |
| `backend/src/routes/cancellations.ts` | API: calculate, process, list, reopen |
| `backend/src/migrations/047_cancellations.sql` | cancelled status, job fields |
| `backend/src/services/email-templates/job_cancelled_crew.ts` | Crew cancellation email |
| `frontend/src/pages/LostCancelledPage.tsx` | Lost & Cancelled view |
| `frontend/src/components/CancellationModal.tsx` | Modal with calculator + workflow |

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/cancellations/:jobId/calculate` | Run calculator, return breakdown (no side effects) |
| `POST` | `/api/cancellations/:jobId/process` | Process cancellation (all automated actions) |
| `GET` | `/api/cancellations/list` | List cancelled + lost jobs (paginated, filterable) |
| `POST` | `/api/cancellations/:jobId/reopen` | Re-open as new booking (HH duplicate + OP create) |
| `GET` | `/api/cancellations/:jobId/transport-crew` | Get associated transport quotes + crew for the modal |
