# Excess & Payment Portal Integration — Handoff Spec

**Date:** 16 Apr 2026
**Branch:** `claude/prepare-live-launch-w1P8X`
**Status:** Payment portal repointed to OP (DATA_BACKEND=op live on Netlify), but excess detection broken.

## What We're Building

The Payment Portal (Netlify app at `ooosh-tours-payment-page.netlify.app`) has been repointed from Monday.com to the OP backend. Hire payments work — a deposit auto-confirms the booking in OP and pushes status to HireHop. **Excess payments and pre-auths are broken.**

## What Works

1. **Hire deposit via portal → OP auto-confirms booking** ✅
   - `POST /api/money/{jobId}/payment-event` with `payment_type: 'deposit'`
   - Updates `pipeline_status` to `confirmed`, pushes HH status 2
   - Sends booking confirmation + payment received emails
   - Triggers hire form auto-email if job starts within 10 days

2. **OP derivation engine creates excess records** ✅
   - When self-drive vehicles detected on HH, auto-creates `job_excess` with `required = van_count × £1,200`
   - Updates required amount on `needed`, `pending`, or `pre_auth` records when van count changes
   - Flags mismatch on `taken`/`partially_paid` records (real money moved)

3. **Hire form submission absorbs existing excess records** ✅
   - `POST /api/hire-forms` checks for existing unlinked `job_excess` (assignment_id IS NULL)
   - Updates required amount to hire-form-calculated figure, preserves amount already taken

4. **Excess-info endpoint has all required fields** ✅ (verified in code)
   - `GET /api/money/{jobId}/excess-info` returns `drivers[]` with `status` alias, `excess_amount` alias
   - Returns `excess_status_flags` with `has_pre_auth`, `has_paid`, `has_retained`, `all_cleared`
   - Accepts HH job number or OP UUID in `:jobId` param

## What's Broken

### Problem: Portal can't see excess status from OP

**Symptom:** Portal logs show `Flags={}`, `Collected=£0.00`, `Status="null"` when calling the OP excess-info endpoint for a job that HAS a pre-auth'd excess record visible on the OP Money tab.

**Test job:** HH #15746 (OP UUID: `fda20b81-5784-4ae7-8d4f-00a2596b3f29`)
- 1 self-drive van (was 2, reduced to 1)
- £1,200 pre-auth taken via Stripe through the portal
- OP Money tab shows: "Pre-auth Taken, Required: £2,400, Collected: £1,200" (required should be £1,200 after sync)
- Portal still asks for excess payment — doesn't see the pre-auth

**Root cause candidates (investigate in order):**

1. **Deployment mismatch:** The `excess_status_flags` code was added across multiple commits. Some PRs were merged to main, some weren't when the server was deployed. The server may be running stale code. **First step: check what commit the server is actually on** (`cd /var/www/ooosh-portal && git log --oneline -5`).

2. **job_excess record has wrong job_id:** The derivation engine creates the record using `jobId` from the derivation context. The payment-event endpoint resolves the job from HH number. If these resolve to different UUIDs (shouldn't happen, but verify), the excess-info query would miss the record. **Check:** `SELECT id, job_id, excess_status, excess_amount_required, excess_amount_taken FROM job_excess WHERE job_id = (SELECT id FROM jobs WHERE hh_job_number = 15746);`

3. **The excess record has excess_status = 'not_required':** The query filters these out: `WHERE je.excess_status != 'not_required'`. Unlikely given the Money tab shows "Pre-auth Taken", but verify.

4. **The portal is calling a different endpoint or caching:** Check portal logs for the exact URL it's calling. Should be `GET /api/money/15746/excess-info`. If it's calling something else, that explains the mismatch.

### Problem: Excess requirement card shows wrong data on Overview tab

**Symptom:** Overview tab shows "Insurance Excess: £0.00 required" with "Unknown: Pre-auth Taken £2,400.00" below it.

**Root cause:** The excess requirement card (`RequirementCard.tsx`) calls `GET /api/money/{jobId}/excess-info` on render. The "£0.00 required" is a fallback when the totals come back empty. The "£2,400" comes from the driver record's `excess_amount_required` which hasn't been updated yet (needs Sync HH to trigger derivation engine).

**Fix:** After deploying the pre-auth update fix, clicking "Sync HH" on the job should update required from £2,400 to £1,200. If the excess-info query itself is broken (returns empty), the card will still show wrong data.

### Problem: Excess payment/pre-auth emails are generic

**Symptom:** Pre-auth and excess payments got "Payment Received" emails instead of the specific excess templates.

**Root cause (fixed):** The email trigger in `payment-event` checked `excess_id` (the original request param, undefined when portal doesn't send one) instead of `resolvedExcessId` (the auto-created/found ID). Fixed in commit `5aea22b`.

**Templates exist and are correct:**
- `excess_payment_confirmed` — "Insurance Excess Received" with reimbursement timeline
- `excess_preauth_confirmed` — "Pre-Authorisation Confirmed" explaining it's not a charge

## Architecture: How Excess Flows Between Systems

```
HireHop (items)
  → OP Derivation Engine detects self-drive vehicles
  → Creates job_excess record: required = van_count × £1,200, status = 'needed'
  
Payment Portal (client pays)
  → Stripe charges/pre-auths the client
  → Portal creates HH deposit directly
  → Portal calls POST /api/money/{jobId}/payment-event
  → OP finds or auto-creates job_excess record
  → Updates: status → 'taken' or 'pre_auth', amount_taken = payment amount
  → Links hh_deposit_id for reconciliation
  → Sends appropriate email template
  
Portal checks excess status
  → GET /api/money/{jobId}/excess-info
  → Reads excess_status_flags: { has_pre_auth, has_paid, has_retained, all_cleared }
  → If all_cleared: skip excess UI
  → If not cleared: show excess payment form with outstanding amount
  
Hire Form submitted (driver)
  → POST /api/hire-forms creates assignment + excess
  → Checks for existing unlinked job_excess record
  → If found: absorbs it (updates required, preserves taken)
  → If not: creates new record
```

## Key Files

| File | Purpose |
|------|---------|
| `backend/src/routes/money.ts` | All money/excess endpoints, payment-event, excess-info |
| `backend/src/services/hh-requirement-derivation.ts` | Creates/updates job_excess when vehicles detected |
| `backend/src/routes/hire-forms.ts` | Hire form submission, excess record absorption |
| `backend/src/services/money-emails.ts` | Email sending for payment/excess events |
| `backend/src/services/email-templates/index.ts` | Email template content |
| `frontend/src/components/RequirementCard.tsx` | Excess requirement card on Overview tab |
| `frontend/src/pages/JobDetailPage.tsx` | Money tab, excess display |

## Database Tables

```sql
-- The excess tracking record
SELECT * FROM job_excess WHERE job_id = (SELECT id FROM jobs WHERE hh_job_number = 15746);

-- The requirement card
SELECT * FROM job_requirements WHERE job_id = (SELECT id FROM jobs WHERE hh_job_number = 15746) AND requirement_type = 'excess';

-- API keys (portal auth)
SELECT name, key_prefix, service, is_active FROM api_keys;

-- Payment audit log
SELECT * FROM job_payments WHERE hirehop_job_id = 15746 ORDER BY created_at DESC;
```

## What to Do Next

1. **Verify server deployment state:** `cd /var/www/ooosh-portal && git log --oneline -5` — confirm the latest commits are deployed
2. **Run the DB queries above** to verify the job_excess record exists and has the right job_id
3. **Test the endpoint directly:** `curl -H "X-API-Key: <key>" https://staff.oooshtours.co.uk/api/money/15746/excess-info` — see the raw response
4. **If response is empty:** The job_excess record's job_id doesn't match, or the record was lost
5. **If response has data but portal doesn't see it:** Portal-side caching or URL mismatch
6. **Fix the £2,400 required amount:** Click Sync HH on job 15746 after deploying — derivation engine will update to £1,200
7. **Test end-to-end:** Create a fresh test job with 1 van, take a pre-auth through portal, verify OP and portal both show it correctly

## Payment Portal Side

The portal (`ooosh-tours-payment-page` Netlify repo) has been repointed with `DATA_BACKEND=op`. Key env vars:
- `DATA_BACKEND=op`
- `OP_BACKEND_URL=https://staff.oooshtours.co.uk`
- `OP_API_KEY=ppk_live_...` (matches `api_keys` table prefix)

Portal checks excess via `checkExcessStatusFromOP()` in `monday-excess-checker.js`, which calls `GET /api/money/{jobId}/excess-info` and reads `excess_status_flags`.

## Retained Excess (Client Ledger Balance)

Was always manual in Monday.com (staff set "Retained from previous hire" status). Not a regression. OP tracks rolled-over balances via `client_excess_ledger` view. Portal already handles `has_retained: true` flag. Future: surface client balance in `excess-info` response so portal can auto-detect.
