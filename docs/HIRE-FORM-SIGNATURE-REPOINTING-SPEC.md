# Hire Form App — SignaturePage & Generate Repointing Spec

## Overview

The hire form app's `SignaturePage.js` and `generate-hire-form.js` need OP mode support. When `DATA_BACKEND=op`, after a driver signs the hire form, the app should call the OP backend instead of Monday.com for:

1. **Creating the assignment** (already done — `POST /api/hire-forms`)
2. **Generating the PDF** (new — `POST /api/hire-forms/:id/generate-pdf`)
3. **Post-signature automations** (new — `POST /api/hire-forms/:id/post-signature`)

The existing Monday.com code stays as the default fallback (`DATA_BACKEND=monday`).

---

## Authentication

**Important:** The hire-forms endpoints use `HIRE_FORM_API_KEY` (env var on the OP server), NOT the `api_keys` database table. This is different from the payment portal which uses the `api_keys` table.

The hire form app should send the API key in the `X-API-Key` header:

```javascript
const headers = {
  'X-API-Key': process.env.HIRE_FORM_API_KEY,
  'Content-Type': 'application/json',
};
```

**Env var on Netlify:** `HIRE_FORM_API_KEY` — this should match the `HIRE_FORM_API_KEY` env var on the OP server.

**Base URL:** `OP_BACKEND_URL` env var (e.g. `https://staff.oooshtours.co.uk/api` — note: includes `/api`).

If an `opFetch()` helper already exists in the repo (from earlier repointing work), use that — it already handles the URL construction and API key header.

---

## OP Endpoints

### 1. `POST /api/hire-forms` — Create assignment (ALREADY REPOINTED)

This endpoint is already called by the hire form app in OP mode. It:
- Creates or updates the driver record
- Creates a `vehicle_hire_assignment`
- Creates a `job_excess` record
- Returns the assignment ID

**Response:**
```json
{
  "data": {
    "assignment_id": "uuid-of-created-assignment",
    "driver_id": "uuid-of-driver",
    "excess_id": "uuid-of-excess-record",
    "is_new_driver": false,
    "excess_amount": 1200.00,
    "requires_referral": false
  }
}
```

The `assignment_id` from this response is used as the `:id` parameter in the next two calls.

### 2. `POST /api/hire-forms/:id/generate-pdf` — Generate hire form PDF

**`:id`** = the `assignment_id` from step 1.

**Query params:**
- `send_email=true` — also emails the PDF to the driver (optional)

**Request:** No body needed — all data is loaded from the assignment record.

**Response:**
```json
{
  "data": {
    "pdf_key": "hire-forms/uuid/HireForm_RX22SXL_JohnSmith_20260403.pdf",
    "filename": "HireForm_RX22SXL_JohnSmith_20260403.pdf",
    "size": 45321,
    "email_sent": true,
    "email_redirected_to": null
  }
}
```

**What it does server-side:**
- Generates an exact replica of the current Netlify `generate-hire-form.js` output (same pdf-lib logic, same Roboto fonts, same layout)
- Uploads to R2 storage
- Updates the assignment with `hire_form_pdf_key` and `hire_form_generated_at`
- If `send_email=true`: emails the PDF to the driver as an attachment and sets `hire_form_emailed_at`

### 3. `POST /api/hire-forms/:id/post-signature` — Post-signature automations

**`:id`** = the `assignment_id` from step 1.

**Request:** No body needed.

**Response:**
```json
{
  "success": true,
  "assignmentId": "uuid",
  "results": {
    "additionalDriverCharge": {
      "charged": true,
      "driverCount": 3,
      "vehicleCount": 2,
      "chargePerExtra": 20,
      "extraDrivers": 1,
      "totalCharge": 24.00
    },
    "midTour": {
      "detected": false,
      "hhStatus": 2
    }
  }
}
```

**What it does server-side:**
- **Additional driver charge:** Counts drivers assigned to this job vs vehicle count in HireHop. If drivers > 2 per vehicle, adds a £20+VAT charge per extra driver (HireHop item 1324).
- **Mid-tour detection:** Checks if the job is already dispatched (HH status 5 or 6). If so:
  - Sets `hire_start = NOW()` on the assignment (driver shouldn't have been driving before form submission)
  - Sends bell notifications to all admin/manager users
  - Sends email notification to `info@oooshtours.co.uk`
  - Returns `midTour.detected = true`

**Both checks are non-blocking** — if either fails, the endpoint still returns 200 with the error logged in the results object.

---

## What to Change

### `SignaturePage.js`

Currently, after the driver signs:
1. The hire form data is submitted (in OP mode, already calls `POST /api/hire-forms`)
2. The Monday.com `copy-a-to-b` action fires (superseded in OP mode)
3. The `generate-hire-form.js` function generates the PDF (still points to Netlify)

**In OP mode, after successful `POST /api/hire-forms` returns `assignment_id`:**

```javascript
if (isOpMode()) {
  const assignmentId = response.data.assignment_id;
  
  // Step 1: Generate PDF and email it to the driver
  try {
    await opFetch(`/hire-forms/${assignmentId}/generate-pdf?send_email=true`, {
      method: 'POST',
    });
    console.log('[SignaturePage] PDF generated and emailed via OP');
  } catch (err) {
    console.error('[SignaturePage] PDF generation failed (non-blocking):', err);
    // Don't fail the whole flow — the assignment was already created
  }
  
  // Step 2: Post-signature automations (additional driver charge + mid-tour check)
  try {
    await opFetch(`/hire-forms/${assignmentId}/post-signature`, {
      method: 'POST',
    });
    console.log('[SignaturePage] Post-signature automations completed');
  } catch (err) {
    console.error('[SignaturePage] Post-signature failed (non-blocking):', err);
  }
  
  // Step 3: Show confirmation to driver (existing UI — no change needed)
}
```

**Key points:**
- Both calls are fire-and-forget from the user's perspective — the driver sees the confirmation page regardless
- The confirmation email to the driver is still handled by the hire form app (no OP duplication)
- The `generate-pdf` call with `send_email=true` handles the PDF email separately (this is the Ooosh-branded hire form copy, not the confirmation)

### `generate-hire-form.js`

This Netlify function generates the hire form PDF. In OP mode, it should delegate to the OP backend:

```javascript
if (isOpMode()) {
  const { assignmentId } = JSON.parse(event.body);
  
  if (!assignmentId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'assignmentId required in OP mode' }) };
  }
  
  const result = await opFetch(`/hire-forms/${assignmentId}/generate-pdf?send_email=true`, {
    method: 'POST',
  });
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      source: 'op',
      pdf_key: result.data.pdf_key,
      filename: result.data.filename,
      email_sent: result.data.email_sent,
    }),
  };
}
```

---

## What NOT to Change

- **Driver verification flow** (send-verification-code, verify-code, create-idenfy-session, document-processor) — NO CHANGE
- **Driver status lookup** (`driver-status.js`) — already repointed
- **Job validation** (`validate-job.js`) — already repointed
- **Next step routing** (`get-next-step.js`) — already repointed
- **Monday.com `copy-a-to-b`** (`monday-integration.js`) — already superseded in OP mode
- **The confirmation email** the hire form app sends to the driver — keep as-is, no OP duplication

---

## Env Vars (already set on Netlify)

| Var | Value | Notes |
|---|---|---|
| `DATA_BACKEND` | `monday` (default) → flip to `op` when ready | Controls which backend is used |
| `OP_BACKEND_URL` | `https://staff.oooshtours.co.uk/api` | OP API base URL (includes `/api`) |
| `HIRE_FORM_API_KEY` | (matches OP server env var) | API key for authentication |

---

## Call Sequence Diagram

```
Driver signs form
       │
       ▼
[SignaturePage.js]
       │
       ├─── POST /api/hire-forms ──────────────► OP creates driver + assignment + excess
       │    (already working)                     Returns: { assignment_id }
       │
       ├─── POST /api/hire-forms/:id/generate-pdf?send_email=true
       │    (NEW)                                 OP generates PDF → R2 → emails driver
       │
       ├─── POST /api/hire-forms/:id/post-signature
       │    (NEW)                                 OP checks additional driver charge
       │                                          OP checks mid-tour detection
       │
       ▼
[Confirmation Page]
  Driver sees success
```

---

## Testing Plan

1. Set `DATA_BACKEND=op` on a Netlify deploy preview
2. Complete a hire form end-to-end on a test job:
   - Verify driver created/updated in OP
   - Verify assignment created in OP
   - Verify PDF generated (check R2 bucket or `hire_form_pdf_key` on assignment)
   - Verify email received by driver (check email_log table)
   - Verify additional driver charge logic (if multiple drivers on job)
3. Test mid-tour scenario: submit form for a job with HH status 5 (dispatched)
   - Should see `hire_start = NOW()` on the assignment
   - Should see bell notification for admin users
   - Should see email to info@oooshtours.co.uk
4. Monitor OP logs: `journalctl -u ooosh-portal -f | grep hire-form`
