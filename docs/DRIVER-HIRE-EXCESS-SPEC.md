# Driver Hire Forms & Insurance Excess — Implementation Spec

**Version 1.0 • March 2026**
**Steps 2–3 from CLAUDE.md Phase 2 work order — detailed build spec**

---

## 1. Overview

This spec covers the migration of **Driver Hire Forms** from Monday.com into the Ooosh Operations Platform, and the implementation of **Insurance Excess Tracking** as a financial lifecycle system. These two features are tightly coupled — the hire form process determines the excess amount, and the excess status gates job dispatch.

### What We're Replacing

| Current (Monday.com) | New (Ooosh OP) |
|---|---|
| Monday.com board 841453886 for hire forms | `drivers` + `vehicle_hire_assignments` tables in PostgreSQL |
| Monday.com column lookups for excess amount | `job_excess` table with full financial lifecycle |
| Manual cross-referencing of drivers ↔ vehicles | Direct FK relationships in `vehicle_hire_assignments` |
| R2 JSON file for vehicle allocations | `vehicle_hire_assignments` table (allocations become rows) |
| Free-text driver names on allocations | Driver records linked by `driver_id` FK to `drivers` table |

### Core Principles

1. **Non-destructive migration.** Both systems run in parallel during transition. Existing R2 allocations + Monday.com hire forms continue to work. New system is opt-in until validated.
2. **Drivers are people.** A driver record links to the `people` table. If the driver is also a freelancer or contact, it's the same person — not a duplicate.
3. **Excess is financial, not pipeline.** Excess status is a gate condition on job dispatch, not a pipeline column. It tracks money, not conversation.
4. **Allocations become hire assignments.** The current R2 "allocation" concept (vehicle → job slot) merges with the new "hire assignment" concept (vehicle + driver + job + excess). One table, two assignment types.

---

## 2. Data Model

### 2.1 `drivers` Table (New)

A **driver** is a person who has been through the hire form process at least once, or a freelancer/staff member who drives Ooosh vehicles. The driver record stores their DVLA data and licence details — the "global record" that persists across hires.

```sql
CREATE TABLE IF NOT EXISTS drivers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id             UUID REFERENCES people(id),          -- Link to people table (nullable for initial import)

  -- Identity (from hire form or manual entry)
  full_name             VARCHAR(200) NOT NULL,                -- As it appears on licence
  email                 VARCHAR(255),
  phone                 VARCHAR(50),
  date_of_birth         DATE,
  address_line1         VARCHAR(255),
  address_line2         VARCHAR(255),
  city                  VARCHAR(100),
  postcode              VARCHAR(20),                          -- Correctable if OCR gets it wrong

  -- DVLA / Licence data
  licence_number        VARCHAR(50),                          -- Driving licence number
  licence_type          VARCHAR(20),                          -- full, provisional, international
  licence_valid_from    DATE,
  licence_valid_to      DATE,
  licence_issue_country VARCHAR(100) DEFAULT 'GB',
  licence_points        INTEGER DEFAULT 0,                    -- Total penalty points
  licence_endorsements  JSONB DEFAULT '[]',                   -- Array of { code, points, date, expiry }
  licence_restrictions  TEXT,                                  -- Any licence restrictions / conditions
  dvla_check_code       VARCHAR(50),                          -- DVLA check code (one-time use, stored for audit)
  dvla_check_date       DATE,                                 -- When DVLA check was performed

  -- Insurance referral (if points require it)
  requires_referral     BOOLEAN DEFAULT false,                -- True if licence points trigger insurer referral
  referral_status       VARCHAR(30),                          -- pending, approved, declined
  referral_date         DATE,
  referral_notes        TEXT,

  -- Metadata
  source                VARCHAR(30) DEFAULT 'hire_form',      -- hire_form, manual, import, freelancer
  monday_item_id        VARCHAR(50),                          -- Monday.com migration reference
  is_active             BOOLEAN DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  created_by            UUID REFERENCES users(id)
);

-- Indexes
CREATE INDEX idx_drivers_person_id ON drivers(person_id);
CREATE INDEX idx_drivers_email ON drivers(email);
CREATE INDEX idx_drivers_licence ON drivers(licence_number);
CREATE INDEX idx_drivers_name ON drivers(full_name);
```

**Why a separate `drivers` table instead of columns on `people`?**

Not every person is a driver. Driver-specific data (DVLA points, licence endorsements, excess history) is a distinct domain concern. The `person_id` FK connects them — edit the driver's postcode on the Drivers page, it's corrected globally. A person can have zero or one driver record.

### 2.2 `vehicle_hire_assignments` Table (New — Replaces R2 Allocations)

This is the **unified vehicle-to-job assignment table**. It replaces:
- R2 `allocations/_index.json` (soft/confirmed van allocations)
- The concept of "which driver is on which vehicle for which job"

```sql
CREATE TABLE IF NOT EXISTS vehicle_hire_assignments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What's assigned
  vehicle_id            UUID NOT NULL REFERENCES fleet_vehicles(id),
  job_id                UUID REFERENCES jobs(id),             -- Ooosh job (nullable — vehicle may not have an OP job yet)
  hirehop_job_id        INTEGER,                              -- HireHop job number (always populated)
  hirehop_job_name      VARCHAR(500),                         -- Cached for display

  -- Who's driving
  driver_id             UUID REFERENCES drivers(id),          -- Nullable until driver assigned
  assignment_type       VARCHAR(20) NOT NULL DEFAULT 'self_drive',
    -- 'self_drive'  = customer drives, needs hire form + excess
    -- 'driven'      = Ooosh freelancer/staff drives, no hire form needed
    -- 'delivery'    = Ooosh delivers vehicle to customer (one-way)
    -- 'collection'  = Ooosh collects vehicle from customer (one-way)

  -- Van requirement matching (from HireHop job items)
  van_requirement_index INTEGER DEFAULT 0,                    -- Which slot this fills (0-based, for multi-van jobs)
  required_type         VARCHAR(50),                          -- Premium, Basic, Panel, Vito (from HH stock mapping)
  required_gearbox      VARCHAR(10),                          -- auto, manual

  -- Assignment lifecycle
  status                VARCHAR(20) NOT NULL DEFAULT 'soft',
    -- 'soft'        = pre-assigned (fleet manager allocated, not yet confirmed)
    -- 'confirmed'   = booking confirmed (deposit paid or manually confirmed)
    -- 'booked_out'  = vehicle physically handed over (book-out completed)
    -- 'active'      = currently on hire (out with driver)
    -- 'returned'    = vehicle returned (check-in completed)
    -- 'cancelled'   = assignment cancelled before dispatch
  status_changed_at     TIMESTAMPTZ DEFAULT NOW(),

  -- Hire dates (from hire form or manual entry)
  hire_start            DATE,
  hire_end              DATE,
  start_time            TIME,                                 -- Pickup time
  end_time              TIME,                                 -- Return time
  return_overnight      BOOLEAN,                              -- Customer returning overnight (drop-off)

  -- Book-out data (populated when booked out)
  booked_out_at         TIMESTAMPTZ,
  booked_out_by         UUID REFERENCES users(id),
  mileage_out           INTEGER,
  fuel_level_out        VARCHAR(20),                          -- full, 3/4, 1/2, 1/4, empty

  -- Check-in data (populated on return)
  checked_in_at         TIMESTAMPTZ,
  checked_in_by         UUID REFERENCES users(id),
  mileage_in            INTEGER,
  fuel_level_in         VARCHAR(20),
  has_damage            BOOLEAN DEFAULT false,

  -- Freelancer/staff driver details (for 'driven' type)
  freelancer_person_id  UUID REFERENCES people(id),           -- If driven by a freelancer (links to people, not drivers)

  -- Metadata
  notes                 TEXT,
  ve103b_ref            VARCHAR(100),                         -- VE103b form reference
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  created_by            UUID REFERENCES users(id),
  allocated_by_name     VARCHAR(200)                          -- Cached staff name who made allocation
);

-- Indexes
CREATE INDEX idx_vha_vehicle ON vehicle_hire_assignments(vehicle_id);
CREATE INDEX idx_vha_job ON vehicle_hire_assignments(job_id);
CREATE INDEX idx_vha_hirehop_job ON vehicle_hire_assignments(hirehop_job_id);
CREATE INDEX idx_vha_driver ON vehicle_hire_assignments(driver_id);
CREATE INDEX idx_vha_status ON vehicle_hire_assignments(status);
CREATE INDEX idx_vha_dates ON vehicle_hire_assignments(hire_start, hire_end);
CREATE INDEX idx_vha_freelancer ON vehicle_hire_assignments(freelancer_person_id);
```

### 2.3 `job_excess` Table (New)

Tracks the **financial lifecycle** of insurance excess per hire assignment. One excess record per `vehicle_hire_assignment` (a multi-van job has multiple excess records — one per van).

```sql
CREATE TABLE IF NOT EXISTS job_excess (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id         UUID NOT NULL REFERENCES vehicle_hire_assignments(id) ON DELETE CASCADE,
  job_id                UUID REFERENCES jobs(id),
  hirehop_job_id        INTEGER,

  -- Excess amounts
  excess_amount_required  DECIMAL(10,2),                      -- Calculated from hire form / licence points
  excess_amount_taken     DECIMAL(10,2) DEFAULT 0,            -- What we've actually collected
  excess_calculation_basis TEXT,                               -- Why this amount (e.g. "3 points = £500", "referral = £1000")

  -- Status
  excess_status         VARCHAR(30) NOT NULL DEFAULT 'pending',
    -- 'not_required'  = driven assignment, no excess needed
    -- 'pending'       = awaiting collection
    -- 'taken'         = full amount collected
    -- 'partial'       = some amount collected (edge case)
    -- 'waived'        = manually waived (with reason)
    -- 'claimed'       = damage occurred, excess (or part) retained
    -- 'reimbursed'    = excess returned to customer
    -- 'rolled_over'   = excess kept on account for next hire (repeat client)

  -- Payment details
  payment_method        VARCHAR(30),                          -- payment_portal, bank_transfer, card_in_office, cash, rolled_over
  payment_reference     VARCHAR(200),                         -- Stripe payment ID, bank transfer ref, etc.
  payment_date          TIMESTAMPTZ,

  -- Xero integration
  xero_contact_id       VARCHAR(100),                         -- Cemented at creation (won't change even if HH client name changes)
  xero_contact_name     VARCHAR(200),                         -- Xero contact name at time of creation
  client_name           VARCHAR(200),                         -- Current client name (may differ from Xero contact)

  -- Claim / reimbursement
  claim_amount          DECIMAL(10,2),                        -- Amount claimed against damage (may be partial)
  claim_date            TIMESTAMPTZ,
  claim_notes           TEXT,
  reimbursement_amount  DECIMAL(10,2),                        -- Amount returned to customer
  reimbursement_date    TIMESTAMPTZ,
  reimbursement_method  VARCHAR(30),                          -- bank_transfer, card_refund, cash

  -- Metadata
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  created_by            UUID REFERENCES users(id)
);

-- Indexes
CREATE INDEX idx_excess_assignment ON job_excess(assignment_id);
CREATE INDEX idx_excess_job ON job_excess(job_id);
CREATE INDEX idx_excess_hirehop ON job_excess(hirehop_job_id);
CREATE INDEX idx_excess_status ON job_excess(excess_status);
CREATE INDEX idx_excess_xero ON job_excess(xero_contact_id);
```

### 2.4 `client_excess_ledger` View (New)

Running balance per client across all hires. Repeat clients may leave excess with Ooosh across multiple hires.

```sql
CREATE OR REPLACE VIEW client_excess_ledger AS
SELECT
  xero_contact_id,
  xero_contact_name,
  client_name,
  COUNT(*) AS total_hires,
  SUM(excess_amount_taken) AS total_taken,
  SUM(claim_amount) AS total_claimed,
  SUM(reimbursement_amount) AS total_reimbursed,
  SUM(excess_amount_taken) - COALESCE(SUM(claim_amount), 0) - COALESCE(SUM(reimbursement_amount), 0) AS balance_held,
  COUNT(*) FILTER (WHERE excess_status = 'pending') AS pending_count,
  COUNT(*) FILTER (WHERE excess_status = 'taken') AS held_count,
  COUNT(*) FILTER (WHERE excess_status = 'rolled_over') AS rolled_over_count
FROM job_excess
WHERE excess_status != 'not_required'
GROUP BY xero_contact_id, xero_contact_name, client_name;
```

---

## 3. Excess Calculation Rules

The excess amount is determined by the driver's DVLA licence record. These rules are configurable via `calculator_settings` (or a dedicated `excess_rules` table if the rules grow complex).

### 3.1 Points-Based Excess Tiers

| Licence Points | Excess Amount | Notes |
|---|---|---|
| 0 | £250 | Standard excess |
| 1–3 | £500 | Minor points |
| 4–6 | £750 | Moderate points |
| 7–9 | £1,000 | High points — may require referral |
| 10+ | Referral required | Cannot auto-calculate — insurer must quote |

### 3.2 Referral Triggers

Beyond points thresholds, certain endorsement codes trigger automatic referral to the insurer:
- **DR** codes (drink/drug driving)
- **IN** codes (disqualified)
- **DD** codes (dangerous driving)
- **TT** codes (totting up disqualification)
- **Any ban in last 5 years**
- **Non-GB licence** (international drivers)

When referral is triggered:
1. Driver record flagged `requires_referral = true`
2. Excess amount left blank (insurer determines)
3. Notification sent to admin
4. Job cannot move past "Provisional" until referral resolved

### 3.3 Excess Rules Storage

```sql
CREATE TABLE IF NOT EXISTS excess_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type       VARCHAR(30) NOT NULL,     -- 'points_tier', 'endorsement_referral', 'licence_type'
  condition_min   INTEGER,                  -- Min points (for tier rules)
  condition_max   INTEGER,                  -- Max points (for tier rules)
  condition_code  VARCHAR(10),              -- Endorsement code prefix (for referral rules)
  excess_amount   DECIMAL(10,2),            -- Amount (null = requires referral)
  requires_referral BOOLEAN DEFAULT false,
  description     TEXT,
  is_active       BOOLEAN DEFAULT true,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_by      UUID REFERENCES users(id)
);
```

This allows admin to adjust tiers and referral triggers without code changes.

---

## 4. Driver Hire Form Flow

This replaces the Monday.com hire form board. The flow captures driver details, validates their DVLA record, calculates the excess, and links everything to the job.

### 4.1 Flow Steps

```
┌─────────────────────────────────────────────────────────────┐
│                    DRIVER HIRE FORM FLOW                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. START                                                    │
│     └─ Staff initiates from Job Detail or Allocations page   │
│        └─ Pre-fills: HireHop job, vehicle (if allocated)     │
│                                                              │
│  2. DRIVER LOOKUP                                            │
│     ├─ Search by name / email / licence number               │
│     ├─ IF existing driver found:                             │
│     │   └─ Pre-fill all fields from driver record            │
│     │   └─ Show last DVLA check date (may need refresh)      │
│     └─ IF new driver:                                        │
│         └─ Blank form for manual entry                       │
│                                                              │
│  3. DRIVER DETAILS                                           │
│     ├─ Full name, DOB, address, postcode                     │
│     ├─ Licence number, type, valid from/to                   │
│     ├─ DVLA check code (for verification)                    │
│     └─ Endorsements / points entry                           │
│         └─ Future: OCR extraction from licence photo         │
│                                                              │
│  4. EXCESS CALCULATION                                       │
│     ├─ Auto-calculated from points + endorsement rules       │
│     ├─ Shows breakdown: "3 points → £500 excess"             │
│     ├─ IF referral required:                                 │
│     │   └─ Flag shown, excess amount blank                   │
│     │   └─ "Refer to insurer" action button                  │
│     └─ Staff can override amount (with reason logged)        │
│                                                              │
│  5. HIRE DETAILS                                             │
│     ├─ Hire start/end dates + times                          │
│     ├─ Vehicle assignment (if not already allocated)          │
│     ├─ Return overnight? (yes/no/don't know)                 │
│     ├─ VE103b reference (if applicable)                      │
│     └─ Client email (for condition report / comms)           │
│                                                              │
│  6. REVIEW & SAVE                                            │
│     ├─ Summary of all captured data                          │
│     ├─ Excess amount + payment status                        │
│     ├─ Creates/updates driver record                         │
│     ├─ Creates vehicle_hire_assignment (status: 'confirmed') │
│     ├─ Creates job_excess record (status: 'pending')         │
│     └─ Logs interaction on job timeline                      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Repeat Drivers

When a driver has hired before:
- All details pre-fill from their existing `drivers` record
- Last DVLA check date shown — if > 6 months old, prompt for fresh check code
- Previous hire history visible (dates, vehicles, any damage/claims)
- If client has excess balance rolled over, show it: "Client has £500 excess on account"

### 4.3 Editing Driver Records (Drivers Page)

The **Drivers page** (`/drivers`) is where you manage the global driver record:

| Feature | Description |
|---|---|
| Driver list | Searchable table: name, email, licence, points, last hire date, status |
| Driver detail | Full record with all DVLA data, editable fields |
| Postcode correction | Fix OCR errors here — corrects it for all future hires |
| Hire history | All `vehicle_hire_assignments` for this driver |
| Excess history | All `job_excess` records linked via assignments |
| Document uploads | Licence front/back photos, DVLA check screenshots |
| Referral status | Current referral status if applicable |
| Link to person | Shows/creates link to `people` table record |

The Drivers page is the "fix it once, fixed everywhere" location. Correcting a postcode on the Drivers page means every future hire form pre-fills the correct value.

---

## 5. Vehicle Hire Assignment Lifecycle

### 5.1 Assignment Types

| Type | Who Drives | Hire Form? | Excess? | Book-Out? | Use Case |
|---|---|---|---|---|---|
| `self_drive` | Customer | Yes | Yes | Yes | Standard van hire |
| `driven` | Ooosh freelancer/staff | No | No | Yes | Crewed delivery, event support |
| `delivery` | Ooosh driver (one-way) | No | No | Yes | Deliver van to customer location |
| `collection` | Ooosh driver (one-way) | No | No | Yes | Collect van from customer location |

### 5.2 Status Transitions

```
                    ┌──────────┐
                    │   soft   │ ← Fleet manager pre-assigns vehicle
                    └────┬─────┘
                         │ Hire form completed / manually confirmed
                         ▼
                    ┌──────────┐
                    │confirmed │ ← Booking confirmed, excess pending (if self_drive)
                    └────┬─────┘
                         │ Book-out process completed
                         ▼
                    ┌──────────┐
                    │booked_out│ ← Vehicle physically handed over
                    └────┬─────┘
                         │ (Automatic — hire period starts)
                         ▼
                    ┌──────────┐
                    │  active  │ ← Currently on hire
                    └────┬─────┘
                         │ Check-in completed
                         ▼
                    ┌──────────┐
                    │ returned │ ← Vehicle back, ready for excess resolution
                    └──────────┘

    At any point before 'booked_out':
                    ┌──────────┐
                    │cancelled │ ← Assignment cancelled
                    └──────────┘
```

### 5.3 Driven Assignments (Freelancer as Driver)

When `assignment_type = 'driven'`:
- No hire form required
- No excess calculation
- `freelancer_person_id` set to the approved freelancer
- `driver_id` is NULL (no driver record needed — they're internal)
- Book-out flow runs as normal (mileage, fuel, photos, briefing)
- Book-out skips: hire form steps, excess collection check
- Freelancer can be selected from the approved freelancer list (existing `is_freelancer = true AND is_approved = true` filter)

This covers the scenario where Ooosh provides a driver as part of the hire — same van, same book-out process, just no customer-side hire form or excess.

### 5.4 Multi-Vehicle Jobs

A single HireHop job can require multiple vehicles. Each vehicle gets its own `vehicle_hire_assignment` row, identified by `van_requirement_index`. This means:

- Job 1234 needs 2x Premium Auto + 1x Basic Manual = 3 assignment rows
- Each can have a different driver (3 separate hire forms for self-drive)
- Each has its own excess record
- Swapping a vehicle mid-assignment: cancel old row, create new row (audit trail preserved)

### 5.5 Vehicle Swaps

When a vehicle needs swapping (breakdown, damage, customer preference):

1. Current assignment marked `cancelled` (with reason in `notes`)
2. New assignment created for replacement vehicle
3. If self-drive: driver record carries over (same driver, different van)
4. If excess already taken: excess record transferred to new assignment
5. Interaction logged on job timeline

---

## 6. Excess Gate on Job Dispatch

The excess is a **gate condition** — a job with a self-drive vehicle cannot move from "Upcoming" to "Out" (dispatched) without excess collected.

### 6.1 Gate Logic

```
CAN_DISPATCH(job) =
  FOR EACH vehicle_hire_assignment WHERE job_id = job.id AND assignment_type = 'self_drive':
    REQUIRE job_excess.excess_status IN ('taken', 'waived', 'rolled_over', 'not_required')

  IF any assignment has excess_status = 'pending':
    BLOCK dispatch
    SHOW: "Excess not collected for [driver name] on [vehicle reg]"

  IF any assignment has referral_status = 'pending':
    BLOCK dispatch
    SHOW: "Insurance referral pending for [driver name]"
```

### 6.2 Override

Admins can force-dispatch with a recorded override:
- Requires admin role
- Reason captured in interaction log
- Excess record updated with note: "Dispatched without excess — reason: [text]"

### 6.3 Integration with Status Transition Engine (Step 4)

When the status transition engine processes a job moving to "dispatched" (HireHop status 5):
1. Check all `vehicle_hire_assignments` for the job
2. For each `self_drive` assignment, verify excess status
3. If any are `pending`, reject the transition (return error with details)
4. If override flag set and user is admin, allow with audit log

---

## 7. Client Excess Ledger

Repeat clients may leave excess with Ooosh across multiple hires. The ledger tracks the running balance.

### 7.1 Ledger Page (`/excess` or within job detail)

| Column | Description |
|---|---|
| Client Name | Current name (may differ from Xero contact) |
| Xero Contact | Cemented at first hire (stable reference) |
| Total Hires | Count of all excess records |
| Total Taken | Sum of all excess collected |
| Total Claimed | Sum of all damage claims |
| Total Reimbursed | Sum of all refunds |
| **Balance Held** | Taken − Claimed − Reimbursed |
| Actions | View history, reimburse, apply to new hire |

### 7.2 Roll-Over Flow

When a repeat client books again:
1. Hire form detects existing client (by email or Xero contact)
2. Shows current balance: "Client has £500 excess on account from previous hires"
3. Options:
   - **Use existing balance** — mark excess as `rolled_over`, no new payment needed
   - **Top up** — if new excess is higher, collect the difference
   - **New payment** — collect fresh excess, previous balance stays on account

---

## 8. API Endpoints

### 8.1 Drivers

```
GET    /api/drivers                    — List drivers (search, pagination, filters)
GET    /api/drivers/:id                — Get driver detail (includes hire history + excess history)
POST   /api/drivers                    — Create driver record
PUT    /api/drivers/:id                — Update driver record (the "fix postcode" use case)
DELETE /api/drivers/:id                — Soft-delete (set is_active = false)
GET    /api/drivers/lookup?email=&name= — Quick lookup for hire form pre-fill
GET    /api/drivers/:id/hire-history   — All vehicle_hire_assignments for this driver
GET    /api/drivers/:id/excess-history — All job_excess records for this driver
POST   /api/drivers/:id/files          — Upload driver documents (licence photos, DVLA check)
```

### 8.2 Vehicle Hire Assignments (Replaces Allocations API)

```
GET    /api/vehicle-assignments                 — List assignments (filters: job, vehicle, status, date range)
GET    /api/vehicle-assignments/:id             — Get single assignment with driver + excess details
POST   /api/vehicle-assignments                 — Create assignment (soft allocation or confirmed hire)
PUT    /api/vehicle-assignments/:id             — Update assignment (driver, dates, status)
DELETE /api/vehicle-assignments/:id             — Cancel assignment (sets status = 'cancelled')
PATCH  /api/vehicle-assignments/:id/status      — Status transition (with validation)
POST   /api/vehicle-assignments/:id/book-out    — Record book-out data (mileage, fuel, timestamp)
POST   /api/vehicle-assignments/:id/check-in    — Record check-in data (mileage, fuel, damage)

# Compatibility endpoints (thin adapters over new table, for existing frontend)
GET    /api/vehicles/get-allocations            — Returns assignments formatted as VanAllocation[]
POST   /api/vehicles/save-allocations           — Converts VanAllocation[] to assignment rows
```

### 8.3 Hire Forms

```
POST   /api/hire-forms                          — Submit completed hire form (creates driver + assignment + excess)
GET    /api/hire-forms/by-job/:hirehopJobId     — Get hire forms for a job (replaces Monday.com query)
GET    /api/hire-forms/by-driver/:driverId      — Get all hire forms for a driver
```

### 8.4 Excess

```
GET    /api/excess                              — List all excess records (filters: status, client, date range)
GET    /api/excess/:id                          — Get single excess record
PUT    /api/excess/:id                          — Update excess (payment received, status change)
POST   /api/excess/:id/payment                  — Record payment (amount, method, reference)
POST   /api/excess/:id/claim                    — Record damage claim (amount, notes)
POST   /api/excess/:id/reimburse                — Record reimbursement (amount, method)
POST   /api/excess/:id/waive                    — Waive excess (admin only, with reason)
GET    /api/excess/ledger                       — Client excess ledger (grouped by Xero contact)
GET    /api/excess/ledger/:xeroContactId        — Single client's excess history
GET    /api/excess/rules                        — Get excess calculation rules
PUT    /api/excess/rules                        — Update excess rules (admin only)
```

### 8.5 Gate Check

```
GET    /api/jobs/:id/dispatch-check             — Check if job can be dispatched (returns gate status)
  Response: {
    canDispatch: boolean,
    blockers: [
      { type: 'excess_pending', assignmentId, driverName, vehicleReg, amountRequired },
      { type: 'referral_pending', assignmentId, driverName },
    ]
  }
```

---

## 9. Frontend Pages

### 9.1 Drivers Page (`/drivers`)

New top-level page accessible from nav. Contains:

- **Driver list** — searchable/filterable table
  - Columns: Name, Email, Licence Points, Last Hire, Active/Inactive
  - Filters: active/inactive, points range, has-referral
  - Quick search by name, email, or licence number
- **Driver detail** (`/drivers/:id`) — full record view
  - Identity section (name, DOB, address — all editable)
  - DVLA section (licence number, points, endorsements, check date)
  - Hire history table (all assignments, dates, vehicles, outcomes)
  - Excess history table (all excess records, payments, claims)
  - Documents section (licence photos, DVLA check screenshots)
  - Link to person record (if exists)

### 9.2 Allocations Page (Updated)

The existing `AllocationsPage.tsx` continues to work but reads from `vehicle_hire_assignments` instead of R2. Changes:

- Vehicle picker works as before
- Driver field becomes a **driver lookup** (search existing drivers, or "New Driver" to start hire form)
- "Book Out" button checks excess status before allowing proceed
- New "Hire Form" button opens the hire form flow for self-drive assignments
- Status badges updated: soft → confirmed → booked_out (was just soft/confirmed)

### 9.3 Job Detail — Crew & Transport Tab (Updated)

Add an **"Assignments"** section showing all vehicle hire assignments for the job:

| Vehicle | Type | Driver | Excess Status | Assignment Status | Actions |
|---|---|---|---|---|---|
| RO71JYA | self_drive | John Smith | £500 taken | booked_out | View |
| RX22SXL | driven | Sarah (freelancer) | N/A | confirmed | Book Out |

Dispatch gate warning shown at top if any excess is pending.

### 9.4 Excess Ledger Page (`/excess`)

Admin/manager page showing:

- Summary cards: Total held, Total pending, Clients with balance
- Client ledger table (from `client_excess_ledger` view)
- Click-through to individual client history
- Quick actions: record payment, reimburse, claim

### 9.5 Navigation Update

```typescript
// Add to Layout.tsx navItems:
{
  path: '/vehicles-menu',
  label: 'Vehicles',
  children: [
    { path: '/vehicles', label: 'Fleet' },
    { path: '/vehicles/allocations', label: 'Allocations' },
    { path: '/vehicles/costs', label: 'Costs' },
    { path: '/drivers', label: 'Drivers' },    // NEW
    { path: '/excess', label: 'Excess' },       // NEW
  ],
}
```

---

## 10. Migration Strategy

### 10.1 Non-Destructive Parallel Running

Both systems run simultaneously during transition:

| Feature | Old System | New System | Transition |
|---|---|---|---|
| Van allocations | R2 JSON | `vehicle_hire_assignments` | Compatibility API reads/writes both |
| Driver data | Monday.com board 841453886 | `drivers` table | Monday.com read-only, new entries go to OP |
| Hire forms | Monday.com board | OP hire form flow | Monday.com still works, OP is new default |
| Excess tracking | Manual / Monday.com | `job_excess` table | New from day one (no migration needed) |

### 10.2 Data Import

**Drivers from Monday.com:**
1. Export Monday.com hire form board (841453886) as CSV
2. Parse driver details, deduplicate by email/name
3. Import into `drivers` table with `source = 'import'`
4. Attempt to match `person_id` by email against `people` table
5. Store `monday_item_id` for reference

**Allocations from R2:**
1. Read existing `allocations/_index.json` from R2
2. For each allocation, create a `vehicle_hire_assignments` row
3. Match `vehicle_id` by registration plate
4. Keep R2 as read fallback until fully validated

### 10.3 Migration Phases

**Phase A: Database + API (build first, no UI changes)**
1. Create migration SQL (tables, indexes, view)
2. Build backend CRUD endpoints
3. Build compatibility layer (`get-allocations` / `save-allocations` adapters)
4. Import existing driver data from Monday.com export

**Phase B: Drivers Page (new page, no existing pages affected)**
1. Build Drivers list page
2. Build Driver detail page
3. Add "Drivers" to nav

**Phase C: Hire Form Flow (new component, launched from existing pages)**
1. Build hire form multi-step component
2. Wire into Allocations page ("Hire Form" button)
3. Wire into Job Detail page
4. Excess calculation engine

**Phase D: Allocations Migration (swap data source)**
1. Switch AllocationsPage to read from `vehicle_hire_assignments`
2. Keep compatibility API for existing book-out/check-in flows
3. Remove R2 allocation writes (R2 becomes read-only fallback)

**Phase E: Excess Gate + Ledger**
1. Build dispatch gate check
2. Wire into status transition engine
3. Build excess ledger page
4. Payment recording endpoints

---

## 11. Interaction with Existing Systems

### 11.1 Book-Out Flow (Existing — Minimal Changes)

The existing `BookOutPage.tsx` continues to work. Changes:
- Reads assignment from `vehicle_hire_assignments` instead of R2 allocation
- On submit, updates assignment status to `booked_out` (instead of R2 allocation status)
- Still creates vehicle event in R2 (condition report photos, etc.)
- Still dual-writes mileage to `vehicle_mileage_log`
- Still updates `fleet_vehicles.hire_status` to "On Hire"
- Excess gate: if `self_drive`, checks `job_excess.excess_status` before allowing book-out

### 11.2 Check-In Flow (Existing — Minimal Changes)

The existing `CheckInPage.tsx` continues to work. Changes:
- Finds active assignment for the vehicle (status = `booked_out` or `active`)
- On submit, updates assignment status to `returned`
- Still creates vehicle event in R2
- If damage reported, flags for excess claim consideration

### 11.3 Freelancer Portal / Collection Flow (No Changes)

The freelancer-facing collection flow (`CollectionPage.tsx`) is unaffected. It:
- Reads vehicle data from fleet API (unchanged)
- Stores collection event in R2 (unchanged)
- Does not interact with allocations/assignments directly

### 11.4 HireHop Job Sync (No Changes)

Job sync continues pulling from HireHop every 30 minutes. Van requirements are still extracted from HireHop job items on the frontend. No sync changes needed.

### 11.5 Transport Calculator / Quotes (No Changes)

The crew & transport calculator (`TransportCalculator.tsx`) and quotes system are separate from vehicle allocations. Quote crew assignments (`quote_assignments`) track freelancers assigned to transport quotes. Vehicle hire assignments track vehicles assigned to jobs. They serve different purposes.

---

## 12. Notifications

| Event | Notification | Recipients |
|---|---|---|
| Excess pending > 24h | "Excess not collected for [job] — [driver] on [vehicle]" | Job manager, admin |
| Referral required | "Insurance referral needed for [driver] — [points] points" | Admin |
| Referral resolved | "Referral [approved/declined] for [driver]" | Job manager |
| Excess taken | "Excess £[amount] collected for [job]" | Job manager |
| Dispatch blocked | "Cannot dispatch [job] — excess pending" | User who attempted |
| Damage claim filed | "Damage claim filed: £[amount] on [vehicle] for [job]" | Admin, finance |
| Excess reimbursed | "Excess £[amount] reimbursed to [client]" | Admin, finance |

---

## 13. Permissions

| Action | Required Role |
|---|---|
| View drivers list | Any authenticated user |
| Create/edit driver record | staff, manager, admin |
| View excess records | staff, manager, admin |
| Record excess payment | staff, manager, admin |
| Waive excess | admin only |
| Override dispatch gate | admin only |
| Edit excess rules | admin only |
| View client ledger | manager, admin |
| Reimburse excess | manager, admin |
| File damage claim | staff, manager, admin |
| Delete driver record | admin only |

---

## 14. Future Enhancements (Captured, Not In Scope)

- **DVLA API integration** — Auto-fetch licence data from DVLA check code (requires API access)
- **OCR licence extraction** — Upload licence photo, Claude extracts fields (Phase B AI extraction, already specced)
- **Automatic referral submission** — Email insurer directly from OP with driver details
- **Excess payment portal integration** — Repoint Stripe payment portal to record excess in OP (Step 5 in Phase 2 work order)
- **Driver availability calendar** — Check if a repeat driver is already booked on overlapping dates
- **Excess aging report** — Flag excess held > 90 days without resolution
- **Xero journal entries** — Auto-create Xero journal entries for excess taken/claimed/reimbursed
