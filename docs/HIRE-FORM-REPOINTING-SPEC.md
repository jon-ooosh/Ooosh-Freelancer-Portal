# Hire Form Repointing Spec — Monday.com → Ooosh OP

**Version 1.0 • March 2026**
**Phase C of Step 2 (Driver Hire Forms & Excess Calculation)**

---

## 1. Context

The driver hire form is a **standalone React app** hosted on Netlify (`ooosh-driver-verification.netlify.app`). Drivers access it via a link like `?job=12345`, complete a multi-step verification wizard, and the app writes to **Monday.com** via Netlify Functions.

**Phase C does NOT rebuild the hire form app.** It repoints the data layer — Netlify Functions stop calling Monday.com and start calling the OP backend instead.

### Current Architecture (Monday.com)

```
Driver (browser)
  └─ Hire Form React App (Netlify)
       └─ Netlify Functions
            ├─ monday-integration.js    → Monday.com Board A (Driver Database)
            │                           → Monday.com Board B (Driver Assignments)
            ├─ driver-status.js         → Board A (reads driver state)
            ├─ get-next-step.js         → Board A (routing engine)
            ├─ validate-job.js          → HireHop (job validity check)
            ├─ send-verification-code   → Email OTP
            ├─ verify-code              → Email OTP verification
            ├─ create-idenfy-session    → iDenfy (identity verification)
            ├─ document-processor       → AWS Textract (DVLA documents)
            └─ generate-hire-form.js    → PDF generation + email
```

### Target Architecture (OP Backend)

```
Driver (browser)
  └─ Hire Form React App (Netlify)
       └─ Netlify Functions (REPOINTED)
            ├─ monday-integration.js    → OP Backend /api/drivers, /api/hire-forms
            ├─ driver-status.js         → OP Backend /api/drivers/lookup
            ├─ get-next-step.js         → OP Backend /api/drivers/lookup (or local logic)
            ├─ validate-job.js          → OP Backend /api/jobs (or HireHop via OP broker)
            ├─ send-verification-code   → UNCHANGED (email OTP stays on Netlify)
            ├─ verify-code              → UNCHANGED (email OTP stays on Netlify)
            ├─ create-idenfy-session    → UNCHANGED (iDenfy stays on Netlify)
            ├─ document-processor       → UNCHANGED (Textract stays on Netlify)
            └─ generate-hire-form.js    → UNCHANGED FOR NOW (later: OP email service)
```

---

## 2. Monday.com Board Architecture

### Board A — Driver Database (ID: 9798399405)

The **global driver record**. One row per driver email. Persists across hires.
Maps to OP `drivers` table.

### Board B — Driver Assignments (ID: 841453886)

**Per-hire records.** Created when `copy-a-to-b` action fires (after signature).
Maps to OP `vehicle_hire_assignments` + `job_excess` tables.

### Monday.com Actions → OP Endpoint Mapping

| Monday Action | Purpose | OP Endpoint |
|---|---|---|
| `create-driver-board-a` | Create or update driver | `POST /api/drivers` or `PUT /api/drivers/:id` |
| `update-driver-board-a` | Update driver fields + recalculate statuses | `PUT /api/drivers/:id` |
| `find-driver-board-a` | Lookup by email | `GET /api/drivers/lookup?email=` |
| `upload-file-board-a` | Upload licence/passport/DVLA/POA/signature files | `POST /api/files` (with driver_id tag) |
| `find-driver-board-b` | Find assignments by email | `GET /api/hire-forms/by-driver/:id` |
| `copy-a-to-b` | Create per-hire assignment from driver record | `POST /api/hire-forms` |
| `check-hire-form-exists` | Check if email+job combo already has a hire form | `GET /api/hire-forms/by-job/:hirehopJobId` |

---

## 3. Document Validity Date Backbone

**This is the core logic of the system.** Each document type has an expiry date. The routing engine (`get-next-step.js`) checks these dates to determine which steps a driver needs to complete. Returning drivers skip steps where documents are still valid.

### Document Types & Expiry Dates

| Document | Monday Field | How Set | Validity Period | Purpose |
|---|---|---|---|---|
| **Licence** | `licenseNextCheckDue` | Set by iDenfy webhook on successful verification | ~6 months | Licence photo + selfie verified via iDenfy |
| **POA 1** | `poa1ValidUntil` | Set after POA upload + AI verification | 90 days | Proof of Address #1 (bank statement, utility bill, etc.) |
| **POA 2** | `poa2ValidUntil` | Set after POA upload + AI verification | 90 days | Proof of Address #2 (must be different source than POA1) |
| **DVLA Check** | `dvlaValidUntil` | Set after DVLA code verified | 90 days | UK drivers only — DVLA driving record check |
| **Passport** | `passportValidUntil` | Set after passport upload + verification | 90 days | Non-UK drivers OR UK drivers with address mismatch |

### Routing Engine Logic (from `get-next-step.js`)

The router is called at every step transition. It checks document dates against today and returns the next required step.

**Document check order (priority):**

```
1. Licence valid?        → No: route to iDenfy (full document scan)
2. POA1 valid?           → No: route to poa-instructions gateway
3. POA2 valid?           → No: route to poa-instructions gateway (v2.6: always goes through gateway)
4. UK driver?
   a. Address mismatch?  → Yes + passport invalid: route to passport-upload
   b. DVLA valid?        → No: route to dvla-check
5. Non-UK driver?
   a. Passport valid?    → No: route to passport-upload
6. All valid             → route to signature
```

**Key routing rules:**
- **v2.6:** POA work ALWAYS routes through `poa-instructions` gateway first (even if only POA2 needed)
- **v2.4:** For UK drivers with address mismatch, `allValid` requires passport too
- **Address mismatch flow:** POA1 → POA2 → Passport → DVLA (passport inserted before DVLA)
- **Returning drivers:** Skip any step where the document is still within its validity period
- **POA diversity check:** POA1 and POA2 must be from different providers (enforced in upload pages)

### Status Calculation Logic (from `monday-integration.js`)

Five calculated status fields, each derived from document dates:

| Status Field | Values | Logic |
|---|---|---|
| `licenseStatus` | Valid / Expired / Check Due | Expired if `licenseValidTo <= today`; Check Due if `licenseNextCheckDue <= today` |
| `poaStatus` | Valid / Expired / Missing | Valid if both POA dates > today; Missing if either POA not uploaded |
| `dvlaStatus` | Valid / Expired / Not Required | Not Required for non-UK; Expired if `dvlaValidUntil <= today` |
| `passportStatus` | Valid / Expired | Only set if passport date exists; Expired if `passportValidUntil <= today` |
| `insuranceStatus` | Approved / Referral / Failed | Failed if ≥10 points; Referral if ≥7 points OR questionnaire flags; Approved otherwise |

**Insurance Status — Worst-Status-Wins Rule (v3.4):**
When DVLA points update, the system preserves the worse status between existing (from questionnaire) and calculated (from points). A questionnaire "Referral" is never downgraded to "Approved" by a DVLA update with 0 points.

### Board B Overall Status (calculated from all the above)

| Status | Condition |
|---|---|
| **Not Approved** | Insurance Failed, POA Missing, or driver is "Stuck" |
| **Action Required** | Any document Expired or Check Due, or insurance is "Referral" |
| **Approved** | All documents valid and insurance approved |

---

## 4. Hire Form Flow (Driver's Journey)

The standalone React app (`src/App.js`) implements this multi-step wizard:

| Step | Component | What Happens | Netlify Functions Called |
|---|---|---|---|
| 1. Landing | `renderLanding` | Validates job exists | `validate-job` |
| 2. Email Entry | `renderEmailEntry` | Driver enters email | — |
| 3. Email Verification | `renderEmailVerification` | 6-digit OTP sent + verified | `send-verification-code`, `verify-code` |
| 4. Already Completed? | `renderAlreadyCompleted` | Checks if hire form exists for this job | `monday-integration` (check-hire-form-exists) |
| 5. Contact Details | `ContactDetails` | Phone number capture | `monday-integration` (create-driver-board-a) |
| 6. Insurance Questions | `InsuranceQuestionnaire` | 6 yes/no + date passed test | `monday-integration` (update-driver-board-a) |
| 7. Smart Router | — | Determines next step from doc dates | `get-next-step` |
| 8. Document Upload | `renderDocumentUpload` | iDenfy licence+selfie scan | `create-idenfy-session` |
| 9. Processing Hub | `ProcessingHub` | Polls for iDenfy result | `driver-status` |
| 10. POA Instructions | `POAInstructionsPage` | Shows licence address, address mismatch option | — |
| 11. POA1 Upload | `POA1Page` | Upload proof of address #1 | `monday-integration` (upload-file + update) |
| 12. POA2 Upload | `POA2Page` | Upload proof of address #2 (different source) | `monday-integration` (upload-file + update) |
| 13a. DVLA Check | `DVLAPreviewPage` | UK: enter DVLA share code | `document-processor` |
| 13b. Passport | `PassportUploadPage` | Non-UK: upload passport photo | `monday-integration` (upload-file + update) |
| 14. Welcome Back | `WelcomeBackPage` | Returning drivers: confirm or re-upload | `monday-integration`, `get-next-step` |
| 15. Signature | `SignaturePage` | E-signature capture | `monday-integration` (upload-file + copy-a-to-b) |
| 16. Complete | `renderComplete` | Confirmation screen | — |

### Smart Routing Between Steps

After steps 6, 9, 11, 12, 13, the app calls `get-next-step` to determine the correct next step. The URL is updated with `?step=xxx&email=xxx&job=xxx&addressMismatch=xxx` for each transition, enabling:
- Page refresh recovery (session preserved in sessionStorage)
- Smart routing on direct URL access (validates session, checks doc dates)
- Back navigation to previous steps

---

## 5. OP `drivers` Table — Gap Analysis

### Fields Present in Monday Board A but Missing from OP `drivers` Table

**Critical for Phase C (must add):**

| Monday Field | Purpose | Proposed OP Column |
|---|---|---|
| `phoneCountry` | Country code prefix (+44, +33, etc.) | `phone_country VARCHAR(10)` |
| `nationality` | Driver nationality | `nationality VARCHAR(100)` |
| `licenseIssuedBy` | DVLA / other authority — **drives UK vs non-UK routing** | `licence_issued_by VARCHAR(100)` |
| `licenseAddress` | Address on licence (may differ from home) | `licence_address TEXT` |
| `homeAddress` | Full home address as single string | Already have `address_line1/2/city/postcode` — add `address_full TEXT` |
| `poa1ValidUntil` | POA #1 expiry date | `poa1_valid_until DATE` |
| `poa2ValidUntil` | POA #2 expiry date | `poa2_valid_until DATE` |
| `passportValidUntil` | Passport expiry date | `passport_valid_until DATE` |
| `licenseNextCheckDue` | When licence needs re-verification | `licence_next_check_due DATE` |
| `poa1Provider` | POA #1 source (bank, utility, council tax) | `poa1_provider VARCHAR(100)` |
| `poa2Provider` | POA #2 source (must differ from POA1) | `poa2_provider VARCHAR(100)` |
| `datePassedTest` | Date driver passed test (for 2-year minimum check) | `date_passed_test DATE` |
| `hasDisability` | Insurance questionnaire answer | `has_disability BOOLEAN DEFAULT false` |
| `hasConvictions` | Insurance questionnaire answer | `has_convictions BOOLEAN DEFAULT false` |
| `hasProsecution` | Insurance questionnaire answer | `has_prosecution BOOLEAN DEFAULT false` |
| `hasAccidents` | Insurance questionnaire answer | `has_accidents BOOLEAN DEFAULT false` |
| `hasInsuranceIssues` | Insurance questionnaire answer | `has_insurance_issues BOOLEAN DEFAULT false` |
| `hasDrivingBan` | Insurance questionnaire answer | `has_driving_ban BOOLEAN DEFAULT false` |
| `additionalDetails` | Free-form notes from questionnaire | `additional_details TEXT` |
| `insuranceStatus` | Approved / Referral / Failed | `insurance_status VARCHAR(20)` |
| `overallStatus` | Aggregated driver status | `overall_status VARCHAR(50)` |

**Nice-to-have (can defer):**

| Monday Field | Purpose | Notes |
|---|---|---|
| `firstName` / `lastName` | Split name | OP has `full_name`; hire form always sends combined name |
| `licenseIssuingCountry` | Country that issued licence | Could derive from `licence_issued_by` |
| `poa1ReviewStatus` / `poa2ReviewStatus` | Fraud detection flags | Admin UI feature, not needed for driver flow |
| `idenfyCheckDate` / `idenfyScanRef` | iDenfy audit trail | Can store in `files` JSONB or separate audit field |
| `poa1URL` / `poa2URL` | Direct links to POA documents | Files stored in R2 via existing file upload system |
| `signatureDate` / `signatureFileUrl` | Signature capture | Can store in `files` JSONB |
| `licenseStatus` / `poaStatus` / `dvlaStatus` / `passportStatus` | Per-document status | **Computed at runtime** from date fields — no need to store |
| `dvlaCalculatedExcess` | Excess amount | Already computed by `excess_rules` engine |
| `myOverallStatus` | Secondary status field | Unclear purpose, likely admin override |

### Recommendation

**Do NOT store computed status fields.** The licence/POA/DVLA/passport status values are derived from their respective `valid_until` dates — store the dates, compute the statuses at query time (or in a view). This avoids stale data.

**DO store the insurance questionnaire booleans.** These are input data that feeds the referral calculation and must be re-confirmed each hire.

---

## 6. New Migration Required

Migration `020_driver_hire_form_fields.sql` to add the missing columns to `drivers`:

```sql
-- 020: Add hire form fields to drivers table
-- Required for Phase C: Hire Form Repointing (Monday.com → OP backend)

-- Document expiry dates (the validity backbone)
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS poa1_valid_until DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS poa2_valid_until DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS passport_valid_until DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS licence_next_check_due DATE;

-- Document providers (for POA diversity check)
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS poa1_provider VARCHAR(100);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS poa2_provider VARCHAR(100);

-- Identity & contact gaps
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS phone_country VARCHAR(10);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS nationality VARCHAR(100);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS licence_issued_by VARCHAR(100);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS licence_address TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS address_full TEXT;

-- Driving history (date passed test)
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS date_passed_test DATE;

-- Insurance questionnaire booleans
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_disability BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_convictions BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_prosecution BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_accidents BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_insurance_issues BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_driving_ban BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS additional_details TEXT;

-- Insurance & overall status
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS insurance_status VARCHAR(20);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS overall_status VARCHAR(50);

-- iDenfy audit trail
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS idenfy_check_date VARCHAR(50);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS idenfy_scan_ref VARCHAR(100);

-- Signature tracking
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS signature_date DATE;
```

---

## 7. OP Backend — New/Modified Endpoints

### 7.1 Driver Status Endpoint (NEW)

The hire form app needs a single endpoint that returns the driver's full state including document validity — equivalent to what `driver-status.js` returns today.

```
GET /api/drivers/status?email=driver@example.com
Authorization: Bearer <hire-form-session-token> OR X-API-Key: <service-key>
```

**Response shape (matching what the hire form app expects):**

```json
{
  "status": "partial",
  "email": "driver@example.com",
  "name": "John Smith",
  "phoneNumber": "7123456789",
  "phoneCountry": "+44",
  "dateOfBirth": "1990-01-15",
  "licenseNumber": "SMITH901150JN9AA",
  "licenseEnding": "50JN9AA",
  "licenseIssuedBy": "DVLA",
  "homeAddress": "123 Example Street, Brighton, BN1 1AA",
  "licenseAddress": "123 Example Street, Brighton, BN1 1AA",
  "nationality": "GB",
  "documents": {
    "license": { "valid": true, "expiryDate": "2026-09-15", "status": "valid" },
    "poa1": { "valid": false, "status": "expired", "provider": "Barclays" },
    "poa2": { "valid": false, "status": "required", "provider": null },
    "dvlaCheck": { "valid": true, "expiryDate": "2026-06-01", "status": "valid" },
    "passportCheck": { "valid": false, "status": "not_required" }
  },
  "insuranceData": {
    "datePassedTest": "2015-06-20",
    "hasDisability": false,
    "hasConvictions": false,
    "hasProsecution": false,
    "hasAccidents": false,
    "hasInsuranceIssues": false,
    "hasDrivingBan": false,
    "additionalDetails": ""
  },
  "licenseNextCheckDue": "2026-09-15",
  "poa1ValidUntil": "2026-01-10",
  "poa2ValidUntil": null,
  "dvlaValidUntil": "2026-06-01",
  "passportValidUntil": null,
  "poa1Provider": "Barclays",
  "poa2Provider": null,
  "dvlaPoints": 3,
  "dvlaEndorsements": "SP30",
  "dvlaCalculatedExcess": "£500",
  "boardAId": "uuid-of-driver"
}
```

**Implementation:** Query `drivers` table by email, compute document validity from date fields, format response to match the shape above.

### 7.2 Routing Engine Endpoint (NEW)

```
POST /api/drivers/next-step
Content-Type: application/json

{
  "email": "driver@example.com",
  "currentStep": "insurance-complete",
  "addressMismatch": false
}
```

**Response:**

```json
{
  "success": true,
  "nextStep": "poa-instructions",
  "reason": "Proof of address documents required",
  "documentStatus": {
    "licence": { "valid": true, "expiryDate": "2026-09-15" },
    "poa1": { "valid": false },
    "poa2": { "valid": false },
    "dvla": { "valid": false },
    "passport": { "valid": false },
    "isUkDriver": true,
    "allValid": false
  }
}
```

**Implementation:** Port the `calculateNextStep()` and `analyzeDocuments()` functions from `get-next-step.js` into a backend service. The routing logic (Section 3 above) is the single source of truth.

### 7.3 Modified Existing Endpoints

**`PUT /api/drivers/:id`** — Must accept all new fields from the migration. The hire form app sends partial updates (e.g., just insurance questionnaire answers, or just a new POA expiry date).

**`GET /api/drivers/lookup`** — Already exists. Must return the full driver record including new fields so the hire form can check document validity.

**`POST /api/hire-forms`** — Already exists. The `copy-a-to-b` action maps to this. Must accept signature data and handle the Board B status calculation (Approved / Not Approved / Action Required).

**`GET /api/hire-forms/by-job/:hirehopJobId`** — Already exists. The `check-hire-form-exists` action maps to this. Must return enough data for the "already completed" check.

### 7.4 Authentication for Hire Form App

The hire form app is a **public-facing standalone app** — drivers are NOT OP users. Authentication needs a separate mechanism:

| Current (Netlify) | Proposed (OP) |
|---|---|
| Session token (HMAC-signed, 40 min TTL) created by `verify-code` | Same approach: OP issues a short-lived JWT after email verification |
| `X-Session-Token` header on `driver-status` calls | `Authorization: Bearer <hire-form-jwt>` header |
| `X-Internal-Key` for server-to-server (router → status) | Not needed — both endpoints on same Express server |

**Option:** Add a `/api/hire-forms/auth/verify` endpoint that accepts the OTP code and returns a short-lived JWT scoped to the driver's email. The hire form app sends this JWT on all subsequent API calls.

---

## 8. Repointing Plan — Phase C Breakdown

### Phase C1: Database Migration + Backend Endpoints

1. Write migration `020_driver_hire_form_fields.sql` (Section 6 above)
2. Add migration to `run.ts` hardcoded list
3. Update `drivers.ts` route to accept all new fields in POST/PUT
4. Build `GET /api/drivers/status` endpoint (driver-status equivalent)
5. Build `POST /api/drivers/next-step` endpoint (routing engine)
6. Update shared types (`Driver` interface) with new fields
7. Run migration on server

### Phase C2: Repoint Read Path (OP Vehicle Module Pages)

The OP's own vehicle module pages (BookOutPage, AllocationsPage, etc.) currently read from Monday.com via `driver-hire-api.ts`. Repoint to OP backend:

1. Update `driver-hire-api.ts` — Monday.com GraphQL → `GET /api/hire-forms/by-job/:id`
2. `useDriverHireForms.ts` follows automatically (imports from driver-hire-api)
3. Verify OP backend returns data in `DriverHireForm` shape consumers expect
4. No changes to BookOutPage, AllocationsPage, CheckInPage, CollectionPage

### Phase C3: Repoint Write Path (Standalone Hire Form App)

The standalone Netlify-hosted hire form app currently writes to Monday.com. Repoint to OP backend:

**Netlify functions to modify:**

| Function | Change Required |
|---|---|
| `monday-integration.js` | Replace Monday.com API calls with OP backend API calls |
| `driver-status.js` | Call `GET /api/drivers/status` instead of Monday Board A |
| `get-next-step.js` | Call `POST /api/drivers/next-step` instead of internal driver-status |
| `validate-job.js` | Call OP backend `/api/jobs` instead of direct HireHop |
| `generate-hire-form.js` | Read driver data from OP instead of Monday Board B |
| `send-verification-code` | **No change** (email OTP stays on Netlify) |
| `verify-code` | **No change** (but may add OP JWT generation) |
| `create-idenfy-session` | **No change** (iDenfy stays on Netlify) |
| `document-processor` | **No change** (Textract stays on Netlify) |

**Key repointing in `monday-integration.js`:**

| Old (Monday.com) | New (OP) |
|---|---|
| `callMondayAPI(query)` → Monday GraphQL | `fetch('/api/drivers/...')` → OP REST |
| `create-driver-board-a` → create Monday item | `POST /api/drivers` |
| `update-driver-board-a` → change Monday columns | `PUT /api/drivers/:id` |
| `find-driver-board-a` → query Monday by email | `GET /api/drivers/lookup?email=` |
| `upload-file-board-a` → Monday file API | `POST /api/files` (R2 upload with driver tag) |
| `copy-a-to-b` → create Monday Board B item | `POST /api/hire-forms` |
| `check-hire-form-exists` → query Monday Board B | `GET /api/hire-forms/by-job/:id` |

### Phase C4: Dual-Write Transition (Optional)

During transition, write to both Monday.com AND OP backend. Allows rollback if issues found.

1. `monday-integration.js` writes to OP first, then Monday.com as backup
2. If OP write fails, fall back to Monday.com only
3. Monitor for 1-2 weeks
4. Remove Monday.com writes once confident

---

## 9. File Upload Mapping

Monday.com Board A has 7 file columns. These map to the OP's existing file upload system (R2 + `files` JSONB on drivers table):

| Monday File Column | Column ID | OP File Tag |
|---|---|---|
| Licence Front | `file_mktrypb7` | `licence_front` |
| Licence Back | `file_mktr76g6` | `licence_back` |
| Passport | `file_mktr56t0` | `passport` |
| POA #1 | `file_mktrf9jv` | `poa1` |
| POA #2 | `file_mktr3fdw` | `poa2` |
| DVLA Check | `file_mktrwhn8` | `dvla_check` |
| Signature | `file_mktrfanc` | `signature` |

The OP already has file upload infrastructure (`/api/files` route, R2 storage). Driver files will be stored with:
- `entity_type: 'driver'`
- `entity_id: <driver_uuid>`
- `tag: 'licence_front'` (etc.)

---

## 10. Insurance Questionnaire → Excess Calculation Flow

The hire form collects 6 yes/no questions + date passed test. This feeds the excess calculation:

### Questionnaire Fields

| Field | Question | Impact |
|---|---|---|
| `hasDisability` | Physical/mental disability or told not to drive? | If Yes → Referral |
| `hasConvictions` | BA/DD/DR/UT/MS90/MS30/IN10/CU80/TT99 conviction, or single SP ≥6 pts? | If Yes → Referral |
| `hasProsecution` | Past 5 years: manslaughter, dangerous driving, DUI, fail to stop? | If Yes → Referral |
| `hasAccidents` | Motoring accidents in past 3 years? | If Yes → Referral |
| `hasInsuranceIssues` | Refused motor insurance or special terms imposed? | If Yes → Referral |
| `hasDrivingBan` | Banned or disqualified in past 5 years? | If Yes → Referral |
| `datePassedTest` | Date passed driving test | Must be ≥2 years ago |

**If ANY answer is "Yes" → `insuranceStatus` = "Referral"**
**If ALL answers are "No" → `insuranceStatus` = "Approved"** (subject to DVLA points check)

### DVLA Points → Excess Amount (from `excess_rules` table)

| Points | Excess | Status |
|---|---|---|
| 0 | £250 | Approved |
| 1-3 | £500 | Approved |
| 4-6 | £750 | Approved |
| 7-9 | £1,000 | Referral |
| 10+ | — | Failed (referral required) |

### Worst-Status-Wins Rule

When both questionnaire and DVLA data exist, the worse status wins:
- Questionnaire says "Referral" + DVLA says "Approved" → **Referral**
- Questionnaire says "Approved" + DVLA says "Referral" → **Referral**
- Either says "Failed" → **Failed**

This logic already exists in the OP's `hire-forms.ts` route (referral trigger detection).

---

## 11. PDF Generation (`generate-hire-form.js`)

**Deferred to later phase.** The PDF generator currently:
1. Reads driver data from Monday Board B
2. Fetches logo + email template from Monday Templates Board
3. Generates multi-page PDF (hire agreement + T&Cs)
4. Emails PDF to driver via SMTP
5. Uploads PDF back to Monday Board B

**When repointed:**
1. Read driver data from OP `GET /api/hire-forms/by-job/:id` (or a dedicated endpoint)
2. Logo + template stored in OP (or env vars)
3. PDF generation stays on Netlify (or migrates to OP backend)
4. Email via OP email service (`emailService.send()`)
5. Upload PDF to R2 via OP file upload

**The PDF contains:**
- Driver name, email, phone, DOB
- Home address, licence address
- Licence number, issued by, valid to, date passed test
- Vehicle reg + model, hire start/end dates + times
- Insurance excess amount
- Declaration text (7 paragraphs)
- Driver's signature image
- Full T&Cs (10 sections)
- Ooosh branding (logo, company details)

---

## 12. External Service Dependencies

These services are called by the hire form app and are NOT being repointed in Phase C:

| Service | Function | Status |
|---|---|---|
| **iDenfy** | AI identity verification (licence photos + selfie) | Stays on Netlify — `create-idenfy-session.js` |
| **AWS Textract** | OCR for DVLA documents | Stays on Netlify — `document-processor.js` |
| **Email OTP** | Verification codes for driver authentication | Stays on Netlify — `send-verification-code.js`, `verify-code.js` |
| **SMTP (Gmail)** | Send hire form PDF to driver | Stays on Netlify initially; migrate to OP email service later |

---

## 13. Testing Strategy

### Unit Tests
- Routing engine: test all step transitions with various document validity combinations
- Status calculation: test all 5 status fields with edge cases
- Excess calculation: test points tiers and referral triggers

### Integration Tests
- Full hire form flow: new driver (all docs needed)
- Returning driver: all docs valid → skip to signature
- Returning driver: some docs expired → route to correct step
- Address mismatch flow: UK driver, POA1 → POA2 → Passport → DVLA
- Insurance referral: questionnaire "Yes" answer → Referral status
- Duplicate hire form check: same email + job → "already completed" screen

### Manual Smoke Tests
- Complete a full new driver flow end-to-end
- Verify a returning driver skips valid documents
- Confirm PDF generation with OP data
- Verify excess calculation matches expected tiers

---

## Appendix A: Monday.com Column ID → OP Field Mapping (Board A)

| Monday Column ID | Monday Field Name | OP `drivers` Column |
|---|---|---|
| `email_mktrgzj` | Email | `email` |
| `text_mktry2je` | Driver Name | `full_name` |
| `text_mkwhc7a` | First Name | — (derive from full_name) |
| `text_mkwhm2n5` | Last Name | — (derive from full_name) |
| `text_mktrfqe2` | Phone Number | `phone` |
| `text_mkty5hzk` | Phone Country | `phone_country` |
| `date_mktr2x01` | Date of Birth | `date_of_birth` |
| `text_mktrdh72` | Nationality | `nationality` |
| `text_mktrrv38` | Licence Number | `licence_number` |
| `text_mktrz69` | Licence Issued By | `licence_issued_by` |
| `text_mkyptmp5` | Licence Issuing Country | `licence_issue_country` |
| `date_mktr93jq` | Date Passed Test | `date_passed_test` |
| `date_mktrmdx5` | Licence Valid From | `licence_valid_from` |
| `date_mktrwk94` | Licence Valid To | `licence_valid_to` |
| `text_mktr8kvs` | Licence Ending | — (derived from `licence_number`) |
| `long_text_mktr2jhb` | Home Address | `address_full` |
| `long_text_mktrs5a0` | Licence Address | `licence_address` |
| `date_mktr1keg` | POA1 Valid Until | `poa1_valid_until` |
| `date_mktra1a6` | POA2 Valid Until | `poa2_valid_until` |
| `date_mktrmjfr` | DVLA Valid Until | `dvla_valid_until` (existing `dvla_check_date` repurposed) |
| `date_mkvxy5t1` | Passport Valid Until | `passport_valid_until` |
| `date_mktsbgpy` | Licence Next Check Due | `licence_next_check_due` |
| `text_mkyarprf` | POA1 Provider | `poa1_provider` |
| `text_mkyapcr6` | POA2 Provider | `poa2_provider` |
| `date_mkw4apb7` | Signature Date | `signature_date` |
| `status` | Has Disability | `has_disability` |
| `color_mktr4w0` | Has Convictions | `has_convictions` |
| `color_mktrbt3x` | Has Prosecution | `has_prosecution` |
| `color_mktraeas` | Has Accidents | `has_accidents` |
| `color_mktrpe6q` | Has Insurance Issues | `has_insurance_issues` |
| `color_mktr2t8a` | Has Driving Ban | `has_driving_ban` |
| `long_text_mktr1a66` | Additional Details | `additional_details` |
| `text_mkwfhvve` | DVLA Points | `licence_points` |
| `text_mkwf6e1n` | DVLA Endorsements | `licence_endorsements` (JSONB) |
| `text_mkwf6595` | DVLA Calculated Excess | — (computed by excess engine) |
| `color_mktrwatg` | Overall Status | `overall_status` |
| `color_mkxvxskq` | Insurance Status | `insurance_status` |
| `color_mkxvmz0a` | Licence Status | — (computed from dates) |
| `color_mkxvkc9h` | POA Status | — (computed from dates) |
| `color_mkxvhf62` | DVLA Status | — (computed from dates) |
| `color_mkxv9218` | Passport Status | — (computed from dates) |
| `text_mkvv2z8p` | iDenfy Check Date | `idenfy_check_date` |
| `text_mkwbn8bx` | iDenfy Scan Ref | `idenfy_scan_ref` |
| `color_mkyej6s3` | POA1 Review Status | — (deferred) |
| `color_mkyea31t` | POA2 Review Status | — (deferred) |
| `color_mkye2thx` | My Overall Status | — (deferred) |
| `text_mkw34ksx` | POA1 URL | — (files JSONB) |
| `text_mkw3d9ye` | POA2 URL | — (files JSONB) |

## Appendix B: Monday.com Column ID → OP Field Mapping (Board B)

| Monday Column ID | Monday Field Name | OP Table.Column |
|---|---|---|
| `text8` | Driver Name | `drivers.full_name` (via FK) |
| `email` | Email | `drivers.email` (via FK) |
| `text9__1` | Phone Number | `drivers.phone` (via FK) |
| `text_mktywe58` | Phone Country | `drivers.phone_country` (via FK) |
| `date45` | Date of Birth | `drivers.date_of_birth` (via FK) |
| `text_mktqjbpm` | Nationality | `drivers.nationality` (via FK) |
| `text6` | Licence Number | `drivers.licence_number` (via FK) |
| `text_mktqwkqn` | Licence Issued By | `drivers.licence_issued_by` (via FK) |
| `text_mkypq7mq` | Licence Issuing Country | `drivers.licence_issue_country` (via FK) |
| `date_mktqphhq` | Licence Valid From | `drivers.licence_valid_from` (via FK) |
| `driver_licence_valid_to` | Licence Valid To | `drivers.licence_valid_to` (via FK) |
| `date2` | Date Passed Test | `drivers.date_passed_test` (via FK) |
| `long_text6` | Home Address | `drivers.address_full` (via FK) |
| `long_text8` | Licence Address | `drivers.licence_address` (via FK) |
| `text86` | Job Number | `vehicle_hire_assignments.hirehop_job_id` |
| `date46` | Hire Start Date | `vehicle_hire_assignments.hire_start` |
| `hour` | Hire Start Time | `vehicle_hire_assignments.start_time` |
| `date14` | Hire End Date | `vehicle_hire_assignments.hire_end` |
| `hour6` | Hire End Time | `vehicle_hire_assignments.end_time` |
| `mirror5` | Vehicle Reg | `fleet_vehicles.registration` (via `vehicle_hire_assignments.vehicle_id`) |
| `mirror_19` | Vehicle Model | `fleet_vehicles.model` (via `vehicle_hire_assignments.vehicle_id`) |
| `lookup_mkwt9hk` | Insurance Excess | `job_excess.excess_amount_required` |
| `item_id9` | Hire Form Number | `vehicle_hire_assignments.id` (UUID) |
| `file_mkyejsr4` | Signature File | `drivers.files` JSONB (tag: 'signature') |
| `date4` | Signature Date | `drivers.signature_date` |
| `files9` | Generated PDF | File in R2 (tag: 'hire_form_pdf') |
| `color_mkwtaftc` | Overall Status | Computed: Approved / Not Approved / Action Required |
| `color_mkyftz8z` | My Overall Status | — (deferred) |
