# Payment Portal Repointing Spec — Monday.com → Ooosh OP

## Overview

The Payment Portal currently reads from Monday.com for excess amounts and status tracking, and writes back to Monday.com after payments. This spec describes how to replace those Monday.com calls with the Ooosh Operations Platform (OP) API, using a `DATA_BACKEND` env var toggle.

**Toggle:** `DATA_BACKEND` env var on Netlify.
- `monday` (default) — current behaviour, calls Monday.com
- `op` — new behaviour, calls OP backend

**OP Backend URL:** Set via `OP_BACKEND_URL` env var (e.g. `https://staff.oooshtours.co.uk`)
**OP API Key:** Set via `OP_API_KEY` env var (an API key from the `api_keys` table)

---

## Authentication

All OP API calls use an API key in the `X-API-Key` header:

```javascript
const headers = {
  'X-API-Key': process.env.OP_API_KEY,
  'Content-Type': 'application/json',
};
```

---

## OP Endpoints Available

### 1. `GET /api/money/:jobId/summary`
**Replaces:** `get-job-details-v2.js` Monday.com calls for financial data.

**Accepts:** Job UUID or HireHop job number.

**Returns:**
```json
{
  "data": {
    "job": { "id": "uuid", "hh_job_number": 15630, "client_name": "Client Ltd" },
    "financial": {
      "hire_value_ex_vat": 1152.10,
      "hire_value_inc_vat": 1382.52,
      "vat_amount": 230.42,
      "total_deposits": 166.13,
      "total_hire_deposits": 166.13,
      "total_excess_deposits": 0,
      "balance_outstanding": 1216.39,
      "required_deposit": 345.63,
      "deposit_paid": false,
      "deposit_percent": 12.02,
      "deposits": [
        { "id": 8090, "amount": 166.13, "date": "2026-03-31", "description": "...", "is_refund": false, "bank_name": "Worldpay" }
      ]
    },
    "excess": {
      "records": [...],
      "total_required": 1200,
      "total_collected": 0,
      "status": "needed"
    },
    "vat_adjustment": { ... } // or null
  }
}
```

### 2. `GET /api/money/:jobId/excess-info`
**Replaces:** `monday-driver-excess.js` — the core excess amount lookup.

**Accepts:** Job UUID or HireHop job number.

**Returns:**
```json
{
  "data": {
    "job_id": "uuid",
    "hirehop_job_id": 15630,
    "job_name": "Band Name — Client — Van",
    "job_date": "2026-04-02T09:00:00.000Z",
    "job_end": "2026-04-05T09:00:00.000Z",
    "hire_duration_days": 3,
    "van_count": 2,
    "pre_auth": {
      "method": "pre-auth",
      "eligible": true,
      "days_until_end": 3,
      "reason": "Hire is ≤4 days and ends within 5 days"
    },
    "drivers": [
      {
        "excess_id": "uuid",
        "driver_id": "uuid",
        "driver_name": "John Smith",
        "vehicle_reg": "RX22SXL",
        "vehicle_type": "Premium",
        "excess_amount_required": 1200.00,
        "excess_amount_taken": 0.00,
        "excess_outstanding": 1200.00,
        "excess_status": "needed",
        "excess_calculation_basis": "DVLA 3 points",
        "payment_method": null,
        "payment_reference": null,
        "licence_points": 3,
        "requires_referral": false,
        "suggested_collection_method": "payment"
      }
    ],
    "totals": {
      "total_excess_required": 2400.00,
      "total_excess_collected": 0.00,
      "total_excess_outstanding": 2400.00,
      "drivers_total": 2,
      "drivers_cleared": 0,
      "drivers_pending": 2,
      "standard_per_van": 1200,
      "standard_total": 2400
    }
  }
}
```

**Pre-auth `method` values:**
- `"pre-auth"` — eligible, hire ≤ 4 days and ends within 5 days
- `"too_early"` — hire ≤ 4 days but ends > 5 days away
- `"payment"` — hire > 4 days, regular charge only

**Fallback logic:** If `drivers` array is empty but `van_count > 0`, use `totals.standard_total` (£1,200 × van count) as the excess amount. This matches the current portal fallback.

### 3. `POST /api/money/:jobId/payment-event`
**Replaces:** Monday.com status column updates after Stripe payments.

**Request body:**
```json
{
  "payment_type": "excess",
  "amount": 1200.00,
  "payment_method": "stripe_gbp",
  "payment_reference": "pi_xxxxxxxxxxxx",
  "stripe_payment_intent": "pi_xxxxxxxxxxxx",
  "source": "payment_portal",
  "excess_id": "uuid-of-excess-record",
  "notes": "Excess payment via Payment Portal"
}
```

**Payment types:** `deposit` | `balance` | `excess` | `refund` | `excess_refund` | `other`

**Payment methods mapping** (Stripe → OP):
| Portal method | OP `payment_method` value |
|---|---|
| Card (Stripe) | `stripe_gbp` |
| Bank transfer | `wise_bacs` |
| PayPal | `paypal` |

**Excess ID:** If the payment is for excess, include the `excess_id` from the excess-info response. This links the payment to the correct excess record and updates its status automatically.

### 4. `POST /api/money/:jobId/record-payment`
**For admin operations** — recording payments that should also push to HireHop.

Same shape as `payment-event` but also pushes to HireHop as a deposit. Use this for admin claim/refund operations.

### 5. `POST /api/excess/:excessId/payment`
**Direct excess payment recording** — updates just the excess record.

```json
{
  "amount": 1200.00,
  "method": "stripe_gbp",
  "reference": "pi_xxxxxxxxxxxx"
}
```

### 6. `POST /api/excess/:excessId/reimburse`
**For refunds/reimbursements.** Admin/manager only.

```json
{
  "amount": 1200.00,
  "method": "stripe_gbp"
}
```

---

## Functions to Repoint

### 1. `monday-driver-excess.js`
**Current:** Queries Monday.com board 841453886 for driver excess amounts.
**New:** `GET ${OP_BACKEND_URL}/api/money/${jobId}/excess-info`
**Notes:** The response includes per-driver breakdown, pre-auth eligibility, and van count. Use `data.drivers` for individual amounts and `data.totals.total_excess_required` for the total. If no drivers, fall back to `data.totals.standard_total`.

### 2. `monday-integration.js` (payment status updates)
**Current:** Updates Monday.com `status58` column after payment.
**New:** `POST ${OP_BACKEND_URL}/api/money/${jobId}/payment-event`
**Notes:** Send the full payment details. The OP handles status transitions internally. No need to map to column IDs.

### 3. `monday-excess-checker.js` (pre-auth status check)
**Current:** Reads Monday.com columns for pre-auth status, Stripe link.
**New:** `GET ${OP_BACKEND_URL}/api/money/${jobId}/excess-info`
**Notes:** Check `data.drivers[].excess_status` — value `pre_auth` means pre-auth is taken. `data.drivers[].payment_reference` contains the Stripe payment intent ID.

### 4. `handle-stripe-webhook.js` (post-payment)
**Current:** After Stripe payment succeeds, updates Monday.com + creates HH deposit.
**New:** After Stripe payment succeeds, `POST ${OP_BACKEND_URL}/api/money/${jobId}/payment-event`. The OP will update the excess record status. HireHop deposit creation stays as-is (portal already does this directly).
**Important:** Don't double-write to HH. If the portal creates the HH deposit, don't also ask OP to create one. Use `payment-event` (not `record-payment`) to avoid the HH push.

### 5. `admin-claim-preauth.js` (capture pre-auth)
**Current:** Captures Stripe PaymentIntent, updates Monday.com.
**New:** After capture, `POST ${OP_BACKEND_URL}/api/money/${jobId}/payment-event` with `payment_type: 'excess'` and the capture amount.

### 6. `admin-refund-payment.js` (process refund)
**Current:** Creates Stripe refund, updates Monday.com + HH.
**New:** After Stripe refund, `POST ${OP_BACKEND_URL}/api/money/${jobId}/payment-event` with `payment_type: 'excess_refund'`. Or call `POST /api/excess/${excessId}/reimburse` directly for proper OP status tracking.

---

## Implementation Pattern

Create a helper file `functions/op-backend.js`:

```javascript
const fetch = require('node-fetch');

const OP_BACKEND_URL = process.env.OP_BACKEND_URL;
const OP_API_KEY = process.env.OP_API_KEY;

function isOpMode() {
  return process.env.DATA_BACKEND === 'op';
}

async function opFetch(path, options = {}) {
  const url = `${OP_BACKEND_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'X-API-Key': OP_API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OP API error ${res.status}: ${body}`);
  }

  return res.json();
}

module.exports = { isOpMode, opFetch };
```

Then in each function:

```javascript
const { isOpMode, opFetch } = require('./op-backend');

// In the handler:
if (isOpMode()) {
  const excessInfo = await opFetch(`/api/money/${jobId}/excess-info`);
  // Use excessInfo.data instead of Monday.com data
  return { statusCode: 200, body: JSON.stringify(excessInfo.data) };
}

// Existing Monday.com code as fallback
```

---

## Env Vars to Set on Netlify

| Var | Value | Notes |
|---|---|---|
| `DATA_BACKEND` | `monday` (default) → flip to `op` when ready | Controls which backend is used |
| `OP_BACKEND_URL` | `https://staff.oooshtours.co.uk` | OP API base URL |
| `OP_API_KEY` | (from api_keys table on OP server) | API key for authentication |

---

## Testing Plan

1. Set `DATA_BACKEND=op` on a Netlify deploy preview (not production)
2. Test each flow:
   - Load payment page for a job → check excess amounts load from OP
   - Make a test card payment → verify payment-event fires to OP
   - Check pre-auth eligibility displays correctly
   - Test admin claim/refund flows
3. Monitor OP server logs: `journalctl -u ooosh-portal -f | grep money`
4. Once verified, flip `DATA_BACKEND=op` on production
5. Monitor for 1-2 weeks, then remove Monday.com fallback code

---

## Status Mapping (Monday.com → OP)

| Monday.com `status58` value | OP `excess_status` equivalent |
|---|---|
| `"Excess paid"` | `taken` |
| `"Pre-auth taken"` | `pre_auth` |
| `"Partially paid"` | `partially_paid` |
| `"Pre-auth claimed"` | `taken` (after capture) |
| `"Excess reimbursed / released"` | `reimbursed` or `partially_reimbursed` |
| `"Retained from previous hire"` | `rolled_over` |

The OP handles all status transitions internally — the portal just needs to send the payment event and the OP figures out the status.
