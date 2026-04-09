# VE103B Certificate System — Implementation Spec

**Status:** Ready to build
**Branch:** `claude/build-ve103b-certificates-18Aps`
**Dependencies:** None (standalone feature)

---

## Overview

The VE103B is a UK document authorising a named driver to take a hired vehicle abroad. It's printed as a **text-only overlay** onto pre-printed official paper (GBP 8/sheet). The OP needs:

1. **PDF generation** — text overlay at calibrated positions (pdf-lib)
2. **Certificate tracking** — `ve103b_certificates` table replacing the Google Sheets log
3. **Monthly BVRLA report** — auto-generated CSV emailed on the 1st of each month at 08:00

---

## Component 1: Database — Migration 040

### New table: `ve103b_certificates`

```sql
CREATE TABLE IF NOT EXISTS ve103b_certificates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_number  VARCHAR(20) NOT NULL,          -- The number from the physical cert (e.g. "1455063")
  assignment_id   UUID REFERENCES vehicle_hire_assignments(id),  -- Which hire assignment
  vehicle_id      UUID REFERENCES fleet_vehicles(id),            -- Which vehicle
  driver_id       UUID REFERENCES drivers(id),                   -- Which driver
  job_id          UUID REFERENCES jobs(id),                      -- Which job

  -- Snapshot of data at time of generation (for BVRLA report & audit)
  vehicle_reg     VARCHAR(20) NOT NULL,
  driver_name     VARCHAR(200) NOT NULL,
  driver_address  TEXT,                              -- Full assembled address
  hire_start      DATE,
  hire_end        DATE,

  -- Certificate lifecycle
  status          VARCHAR(20) NOT NULL DEFAULT 'issued',  -- 'issued' | 'void'
  void_reason     TEXT,                              -- Why voided (misprint, destroyed, etc.)
  voided_at       TIMESTAMPTZ,
  voided_by       UUID REFERENCES users(id),

  -- PDF storage
  pdf_r2_key      VARCHAR(500),                      -- R2 key for generated PDF
  pdf_filename    VARCHAR(200),                      -- e.g. "VE103B-RX22SXL-15593.pdf"

  -- BVRLA report fields (snapshotted for report accuracy)
  bvrla_member_number  VARCHAR(20) NOT NULL DEFAULT '10864',
  date_certificate_supplied DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Metadata
  generated_by    UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for BVRLA monthly report queries
CREATE INDEX idx_ve103b_date_supplied ON ve103b_certificates(date_certificate_supplied);

-- Index for looking up certs by assignment
CREATE INDEX idx_ve103b_assignment ON ve103b_certificates(assignment_id);

-- Index for looking up certs by vehicle
CREATE INDEX idx_ve103b_vehicle ON ve103b_certificates(vehicle_id);

-- Unique constraint: a certificate number can only be used once
CREATE UNIQUE INDEX idx_ve103b_cert_number ON ve103b_certificates(certificate_number);
```

### Migration runner update

Add `'040_ve103b_certificates.sql'` to the `migrations` array in `backend/src/migrations/run.ts`.

---

## Component 2: PDF Generation Service

### File: `backend/src/services/ve103b-pdf.ts`

Uses `pdf-lib` (already a dependency via `hire-form-pdf.ts`). Generates a text-only overlay PDF for printing onto pre-printed VE103B forms.

### Input interface

```typescript
export interface VE103BData {
  // Vehicle V5 fields (from fleet_vehicles)
  vehicleReg: string;       // A
  dateFirstReg: string;     // B  — formatted "28 Jun 2022"
  make: string;             // D.1
  type: string;             // D.2 (v5_type column)
  model: string;            // D.3
  bodyType: string;         // D.5
  vinChassis: string;       // E  (vin column)
  f1Weight: string;         // F.1 (max_mass_kg column, as string)
  jCategory: string;        // J  (vehicle_category column)
  p1Cc: string;             // P.1 (cylinder_capacity_cc column, as string)
  rColour: string;          // R  (colour column)
  s1Seats: string;          // S.1 (seats column, as string)

  // Driver details (from drivers table)
  driverName: string;
  driverAddress: string;    // Assembled: "line1\nline2\ncity\npostcode"

  // Dates
  startDate: string;        // Formatted "28 Jun 2022"
  returnDate: string;       // Formatted "28 Jun 2022"
}

export interface VE103BResult {
  pdfBytes: Uint8Array;
  filename: string;         // "VE103B-{REG}-{CERT_NUMBER}.pdf"
}
```

### PDF layout — exact coordinates

Replicated from the calibrated Netlify function:

```
Page: A4 (595.28 x 841.89 points)
Font: Helvetica / Helvetica-Bold, 9pt (reg number is 10pt bold)

X positions:
  vehicleLeftX  = 137   (vehicle left column)
  vehicleRightX = 440   (vehicle right column)
  driverX       = 193   (driver name/address)
  datesLeftX    = 190   (start date)
  datesRightX   = 425   (return date)

Y positions (from bottom, row spacing = 16pt):
  vehicleStartY = 556

  Row 0 (Y=556): Vehicle Reg (left, BOLD 10pt) | F1 Weight (right)
  Row 1 (Y=540): Date First Reg              | J Category
  Row 2 (Y=524): Make                        | P1 Engine CC
  Row 3 (Y=508): Type                        | R Colour
  Row 4 (Y=492): Model                       | S1 Seats
  Row 5 (Y=476): Body Type                   |
  Row 6 (Y=460): VIN/Chassis                 |

  Driver name:    Y=244 (BOLD)
  Driver address: Y=224 (lines spaced 12pt apart, max 4 lines)

  Start date: Y=130, X=190
  Return date: Y=130, X=425
```

### Calibration mode

Environment variable `VE103B_CALIBRATION_MODE=true` draws:
- Light grey guide lines at every text Y position
- Vertical guide lines at every X position
- Red header text: "CALIBRATION MODE — Print on plain A4, compare to real VE103B"
- Y coordinate labels on right margin
- Page border

This lets staff print on plain paper and overlay against a real VE103B form to check alignment.

### Address handling

The `drivers` table stores address as four fields: `address_line1`, `address_line2`, `city`, `postcode`. Assemble into lines, splitting on `\n`. Max 4 lines rendered, 12pt spacing.

---

## Component 3: Backend API Route

### File: `backend/src/routes/ve103b.ts`

Mount at `/api/ve103b` in `routes/index.ts`.

### Endpoints

#### `POST /api/ve103b/generate`

**Auth:** OP user JWT (staff/manager/admin)

**Request body:**
```json
{
  "assignment_id": "uuid",
  "certificate_number": "1455063"
}
```

**Flow:**
1. Validate `certificate_number` is not already used (unique constraint)
2. Fetch assignment from `vehicle_hire_assignments` (joins `fleet_vehicles`, `drivers`, `jobs`)
3. Assemble `VE103BData` from the joined data
4. Generate PDF via `ve103b-pdf.ts`
5. Upload PDF to R2 (`ve103b/{vehicle_reg}/{filename}`)
6. Insert row into `ve103b_certificates`
7. Update `vehicle_hire_assignments.ve103b_ref` with the certificate number
8. Email PDF to `info@oooshtours.co.uk` using email service (with attachment)
9. Return certificate record + PDF download URL

**Response:**
```json
{
  "id": "uuid",
  "certificate_number": "1455063",
  "vehicle_reg": "RX22SXL",
  "driver_name": "John Smith",
  "pdf_filename": "VE103B-RX22SXL-1455063.pdf",
  "status": "issued",
  "emailed": true
}
```

**Error cases:**
- 409: Certificate number already exists
- 404: Assignment not found
- 400: Assignment missing required data (vehicle not linked, driver not linked, missing V5 data)

#### `POST /api/ve103b/:id/void`

**Auth:** OP user JWT (staff/manager/admin)

**Request body:**
```json
{
  "reason": "Misprint — ink smeared"
}
```

**Flow:**
1. Update `ve103b_certificates` — set `status = 'void'`, `void_reason`, `voided_at = NOW()`, `voided_by`
2. Return updated record

#### `GET /api/ve103b`

**Auth:** OP user JWT

**Query params:** `page`, `limit`, `status` (issued/void/all), `vehicle_reg`, `date_from`, `date_to`

**Returns:** Paginated list of all certificates, newest first. Includes vehicle reg, driver name, cert number, status, dates, who generated it.

#### `GET /api/ve103b/:id`

**Auth:** OP user JWT

**Returns:** Single certificate record with full details.

#### `GET /api/ve103b/:id/download`

**Auth:** OP user JWT

**Returns:** PDF file streamed from R2.

#### `GET /api/ve103b/bvrla-report`

**Auth:** OP user JWT (admin/manager only)

**Query params:** `month` (YYYY-MM format, defaults to previous month)

**Returns:** CSV file as download.

**CSV columns (exact headers):**

| Column | Header | Source |
|---|---|---|
| A | `Date Certificate Supplied` | `date_certificate_supplied` formatted DD/MM/YYYY |
| B | `BVRLA Member Number` | `bvrla_member_number` (always "10864") |
| C | `DVLA REF NO. (7 digit number in circle)` | `certificate_number` |
| D | `REG. NO.` | `vehicle_reg` — or "VOID" if `status = 'void'` |
| E | `COMPANY NAME (leave blank if issued to an individual)` | Always blank |
| F | `START DATE (date certificate is valid from)` | `hire_start` formatted DD/MM/YYYY — blank if void |
| G | `EXPIRY DATE (date certificate is valid to - max 12 months)` | `hire_end` formatted DD/MM/YYYY — blank if void |

**Includes ALL certificates** for the month (issued + void). Void certs have "VOID" in the REG. NO. column and blank dates.

---

## Component 4: Scheduler — Monthly BVRLA Report

### Addition to `config/scheduler.ts`

```
Schedule: '0 8 1 * *' (08:00 on the 1st of every month)
```

**Flow:**
1. Query `ve103b_certificates` where `date_certificate_supplied` is within the previous calendar month
2. Generate CSV with exact BVRLA headers
3. Email as attachment to `will@oooshtours.co.uk`, CC `jon@oooshtours.co.uk`
4. Subject: `BVRLA Monthly VE103B Report — {Month Year}` (e.g. "BVRLA Monthly VE103B Report — March 2026")
5. Body: brief summary (X certificates issued, Y voided)

Uses `emailService.sendRaw()` with attachment (no template needed — internal operational email).

---

## Component 5: Frontend Integration

### 5a: Book-Out Page trigger

**File:** `frontend/src/modules/vehicles/pages/BookOutPage.tsx`

Current state: free-text `ve103b` input field at line 1600-1607.

**Multi-driver handling:** A single van book-out can have multiple drivers (via `hireFormEntries`), but the VE103B is issued to **one named driver** — the **lead driver** selected on the form (`form.driverName`). The cert number field is single-valued per book-out.

If additional drivers on the same vehicle also need VE103B certs (rare — e.g. separate international trips), those would be generated individually from the VE103B Certificate Browser page (Component 5c), not automatically during book-out.

**Change:** On book-out submission, if `ve103b` is populated:

1. The existing write-back flow saves `ve103b_ref` to the **lead driver's** assignment only (not all `hireFormEntries`)
2. **New:** Identify the lead driver's assignment (match `form.driverName` against `hireFormEntries` to find the correct `assignment_id`). Call `POST /api/ve103b/generate` with `{ assignment_id, certificate_number: form.ve103b }`
3. Show result in the book-out results panel (success/fail alongside other tracks)
4. If the cert number is already taken (409), show error and let staff correct

This runs as a **new parallel track** in the `handleSubmit` function (alongside PDF/email, HireHop, allocation, and write-back tracks).

**Important:** The `ve103b_ref` write-back in the existing hire form loop (lines 684-717) currently writes the same `ve103b` value to ALL hire form entries. This needs changing so it only writes to the lead driver's entry. The other drivers' assignments should NOT get the cert number — it's not their cert.

### 5b: Vehicle Swap support

When a vehicle swap creates a new assignment (Phase D3, `swapped_to_assignment_id`), the new assignment can have its own `ve103b_ref` entered during the replacement book-out. The VE103B system doesn't need special swap logic — it just generates a new cert for the new assignment with a new cert number.

### 5c: VE103B Certificate Browser

**New page:** `/vehicles/ve103b` (or tab within vehicles section)

**Nav:** Add "VE103B Certs" under the Vehicles nav group.

**UI:**
- Table of all certificates: cert number, vehicle reg, driver, job, start/end dates, status (issued/void badge), generated date, generated by
- Filter pills: All / Issued / Void
- Search by vehicle reg or cert number
- "Void" quick-action button per row (opens confirm dialog with reason field)
- "Download PDF" button per row
- "Download BVRLA Report" button (month picker, calls `/api/ve103b/bvrla-report`)
- **"Generate VE103B" button** — opens a form to generate a cert outside the book-out flow. Picker for assignment (filters to active assignments), cert number input. This covers: generating for a non-lead driver, re-issuing after a vehicle swap, or any case where book-out has already happened without a cert

### 5d: Job Detail — Drivers & Vehicles tab

On each assignment row where `ve103b_ref` is populated, show a small badge/link: `VE103B: 1455063` that links to the certificate detail or allows PDF download.

---

## Component 6: Email

### VE103B generation email

**To:** `info@oooshtours.co.uk`
**Subject:** `VE103B - {vehicleReg} - Job {hhJobNumber}`
**Body:** Plain text: `VE103B - {vehicleReg} - Job {hhJobNumber}\n\nPlease print on VE103B form paper.`
**Attachment:** The generated PDF

Use `emailService.sendRaw()` — this is a simple internal notification, not a branded template.

### BVRLA monthly report email

**To:** `will@oooshtours.co.uk`
**CC:** `jon@oooshtours.co.uk`
**Subject:** `BVRLA Monthly VE103B Report — {Month Year}`
**Body:** Summary text (count issued, count voided, total)
**Attachment:** CSV file

---

## Data Flow Summary

```
Staff enters cert number on Book Out page
  → Book-out submission fires parallel tracks
  → VE103B track: POST /api/ve103b/generate
    → Fetch vehicle V5 data from fleet_vehicles
    → Fetch driver name + address from drivers
    → Fetch job/hire dates from vehicle_hire_assignments
    → Generate overlay PDF (pdf-lib, calibrated positions)
    → Upload PDF to R2
    → Insert ve103b_certificates row
    → Update assignment.ve103b_ref
    → Email PDF to info@oooshtours.co.uk
    → Return success to frontend

Monthly (1st at 08:00):
  → Scheduler queries previous month's certs
  → Generates CSV with BVRLA headers
  → Emails to will@ CC jon@

Staff voids a cert:
  → POST /api/ve103b/:id/void
  → Row updated to status='void'
  → Still appears in BVRLA report with "VOID" in reg column
```

---

## Files to Create/Modify

| Action | File | Purpose |
|---|---|---|
| **Create** | `backend/src/migrations/040_ve103b_certificates.sql` | New table |
| **Create** | `backend/src/services/ve103b-pdf.ts` | PDF overlay generator |
| **Create** | `backend/src/routes/ve103b.ts` | API endpoints |
| **Modify** | `backend/src/routes/index.ts` | Mount `/api/ve103b` route |
| **Modify** | `backend/src/migrations/run.ts` | Add migration 040 to array |
| **Modify** | `backend/src/config/scheduler.ts` | Add monthly BVRLA cron job |
| **Modify** | `frontend/src/modules/vehicles/pages/BookOutPage.tsx` | Add generate trigger |
| **Create** | `frontend/src/pages/VE103BCertificatesPage.tsx` | Certificate browser page |
| **Modify** | `frontend/src/App.tsx` | Add route for cert browser |
| **Modify** | `frontend/src/components/Layout.tsx` | Add nav item |
| **Modify** | `frontend/src/pages/JobDetailPage.tsx` | VE103B badge on assignments |

---

## Constants

| Constant | Value | Location |
|---|---|---|
| BVRLA Member Number | `10864` | Hardcoded in migration default + service |
| VE103B email recipient | `info@oooshtours.co.uk` | Service constant |
| BVRLA report recipients | `will@oooshtours.co.uk` (to), `jon@oooshtours.co.uk` (cc) | Scheduler constant |
| Calibration mode env var | `VE103B_CALIBRATION_MODE` | `.env` |

---

## Open Items (non-blocking)

- **Historical import:** Not needed — starting fresh from go-live.
- **Vehicle swap:** Works naturally — new assignment gets new cert via normal book-out flow.
- **Company name column:** Always blank per requirements.
