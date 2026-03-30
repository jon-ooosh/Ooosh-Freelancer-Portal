# AGENT_MAP.md — Ooosh Operations Platform
## Parallel Development Coordination

**Last updated:** March 2026  
**Purpose:** Coordinates multiple Claude Code agents working simultaneously.  
**Rule:** Each agent owns its listed files only. Never touch files outside your ownership list.  
**Merge rule:** One branch merged at a time. After each merge, all other agents must pull latest main before continuing.

---

## 🗺️ Agent Overview

| Agent | Branch Name | Domain | Status |
|-------|------------|--------|--------|
| Agent 1 | `claude/ooosh-platform-continuation-nRUmV` | Hire Form Repointing, PDF Gen & Allocations | 🟢 In progress |
| Agent 2 | `feature/excess-gate-ledger` | Excess Gate UI & Ledger | 🔴 Not started |
| Agent 3 | `feature/ops-dashboard-streams` | Global Ops Dashboard Widgets + Backline | 🔴 Not started |
| Agent 4 | `feature/deliveries-payments` | Incoming Deliveries, Lost Property & Payment Tracking | 🔴 Not started |

---

## Agent 1 — Hire Form Cutover, PDF Generation & Allocations Migration

**Branch:** `claude/ooosh-platform-continuation-nRUmV`
**Priority:** 🔴 HIGHEST — blocks getting fully off Monday.com
**Estimated scope:** Phase C2 + C4 + Phase D + Hire Form PDF Generation from CLAUDE.md

### What to build
1. **Phase C2 — Read path repointing** in OP vehicle module pages:
   - ✅ Repoint `driver-hire-api.ts` from Monday.com GraphQL → `GET /api/hire-forms/by-job/:hirehopJobId`
   - ✅ `useDriverHireForms.ts` follows automatically (imports from driver-hire-api)
   - ✅ OP backend returns data in `DriverHireForm` shape consumers expect
   - No changes to BookOutPage, AllocationsPage, CheckInPage, CollectionPage themselves

2. **Hire Form PDF Generation** (added scope — replaces Netlify generate-hire-form.js):
   - ✅ `hire-form-pdf.ts` service: exact port of Netlify function (pdf-lib + Roboto fonts)
   - ✅ Migration 024: `hire_form_pdf_key`, `hire_form_generated_at`, `hire_form_emailed_at` columns
   - ✅ Endpoints: `POST /:id/generate-pdf`, `POST /:id/send-email`, `GET /:id/download`
   - ✅ `PATCH /:id` for mid-hire changes (vehicle swap, date extension, status)
   - ✅ `GET /:id` for single hire form with full driver/vehicle/excess details
   - ✅ Email service: attachment support + `hire_form` template (client-facing, Ooosh branded)
   - ✅ Testing UI: HireFormsSection on Job Detail Crew & Transport tab

3. **Phase C4 — Go-live cutover checklist** (document + assist Jon to execute):
   - [ ] Verify env vars on server: `HIRE_FORM_VERIFICATION_SECRET`, `HIRE_FORM_API_KEY`
   - [ ] Confirm migration 020 has run on production
   - [ ] Document test steps for `DATA_BACKEND=op` on Netlify deploy preview
   - [ ] Prepare the Netlify env var flip instruction for Jon

4. **Phase D — Allocations migration**:
   - [ ] Switch `AllocationsPage.tsx` to read from `vehicle_hire_assignments` instead of R2
   - [ ] Keep compatibility API for existing book-out/check-in flows
   - [ ] R2 becomes read-only fallback (don't delete R2 writes yet)

### Files owned by Agent 1
```
frontend/src/modules/vehicles/lib/driver-hire-api.ts
frontend/src/modules/vehicles/hooks/useDriverHireForms.ts
frontend/src/modules/vehicles/pages/AllocationsPage.tsx
backend/src/routes/hire-forms.ts
backend/src/services/hire-form-pdf.ts              (new)
backend/src/services/fonts/Roboto-*.ttf            (new)
backend/src/migrations/024_hire_form_pdf.sql        (new)
docs/HIRE-FORM-CUTOVER-CHECKLIST.md                (new file to create)
```

### Files to READ but NOT edit
```
frontend/src/modules/vehicles/pages/BookOutPage.tsx
frontend/src/modules/vehicles/pages/CheckInPage.tsx
frontend/src/modules/vehicles/pages/CollectionPage.tsx
backend/src/routes/driver-verification.ts
```

### Do NOT touch
```
frontend/src/components/Layout.tsx
```

### Definition of done
- [x] `driver-hire-api.ts` calls OP backend, not Monday.com GraphQL
- [x] Hire form PDF generation matches Netlify output exactly
- [x] PDF stored in R2, downloadable, emailable via OP email service
- [x] Mid-hire changes (vehicle swap, date extension) via PATCH endpoint
- [x] Testing UI on Job Detail page for PDF generation verification
- [ ] AllocationsPage reads from `vehicle_hire_assignments` table
- [ ] BookOut/CheckIn flows tested manually
- [ ] Cutover checklist doc written and ready for Jon to execute

---

## Agent 2 — Money System (Unified Financial View)

**Branch:** `claude/review-system-architecture-XClBY`
**Priority:** 🔴 HIGH — gates job dispatch, replaces Monday.com for excess tracking, foundation for payment portal repointing
**Estimated scope:** Step 3 (all phases) from CLAUDE.md

### What's been built (Phase A + B)
1. ✅ **Insurance excess backend** — `job_excess` table, CRUD, override, move, by-person/by-org, client balance endpoints, migration 034
2. ✅ **Excess gate warning** — `ExcessGateBanner.tsx` on Job Detail Drivers & Vehicles tab, manager override with reason picklist
3. ✅ **Excess ledger** — `ExcessLedgerPage.tsx` at `/money/excess` (client ledger + all-records views)
4. ✅ **Excess actions** — `ExcessPaymentModal.tsx` (payment, claim, reimburse, waive, rollover, move)
5. ✅ **Address book integration** — `ExcessHistorySection.tsx` on Person + Org detail pages
6. ✅ **Email templates** — 6 templates for excess lifecycle events
7. ✅ **Nav** — "Money > Excess" in Layout.tsx

### What to build next (Phase C — Money Tab)
1. **"Money" tab on Job Detail** — unified financial view per job:
   - Financial Summary section: read hire value, deposits, balance from HireHop via broker
   - Insurance Excess section: embed existing excess components
   - Payment History section: merge HH deposits + OP payments into single timeline
   - Record Payment form: one entry point → creates HH deposit + records in OP
   - Client Account section: rolled-over balance, payment terms
2. **`job_payments` table** — unified payment recording (type: deposit/balance/excess/refund, method, reference)
3. **Migration** for `job_payments` + `payment_terms` on organisations table
4. **Backend routes** — `money.ts` with HH financial read endpoints, payment recording with HH write-back
5. **Wire email triggers** to excess status transitions
6. **Auto-suggest client balance** on new hire assignments

### Future phases (spec'd, not yet building)
- **Phase D** — VAT adjustment display (port `vat-adjustment.js` from Payment Portal)
- **Phase E** — Payment Portal repointing (non-destructive, `DATA_BACKEND` env var toggle)
- **Phase F** — Staff card payments via Stripe (take payment directly from Money tab)

### Files owned by Agent 2
```
frontend/src/pages/ExcessLedgerPage.tsx           (built)
frontend/src/components/ExcessGateBanner.tsx       (built)
frontend/src/components/ExcessPaymentModal.tsx     (built)
frontend/src/components/ExcessHistorySection.tsx   (built)
frontend/src/pages/MoneyPage.tsx                   (new — Money tab component, or integrated into JobDetailPage)
backend/src/routes/money.ts                        (new — unified money endpoints)
backend/src/routes/excess.ts                       (extended)
backend/src/services/vat-adjustment.ts             (new — Phase D)
backend/src/migrations/035_job_payments.sql        (new)
frontend/src/components/Layout.tsx                 ← COORDINATE with other agents
```

### Files to READ but NOT edit
```
backend/src/config/hirehop.ts             (HH broker patterns)
backend/src/services/hirehop-broker.ts    (how to read HH data)
backend/src/services/hirehop-writeback.ts (how to push to HH)
frontend/src/pages/JobDetailPage.tsx      (tab injection points)
shared/types/index.ts                     (add new types only)
```

### Do NOT touch
```
frontend/src/modules/vehicles/  (Agent 1's domain)
backend/src/routes/pipeline.ts
backend/src/routes/quotes.ts
```

### Definition of done (Phase C)
- [x] Excess gate banner on Job Detail Drivers & Vehicles tab
- [x] Manager override with reason capture
- [x] `/money/excess` global ledger page
- [x] Excess actions (payment/claim/reimburse/waive/rollover/move)
- [x] Address book integration (Excess History on person + org pages)
- [x] "Money" tab on Job Detail with financial summary from HireHop
- [x] Insurance excess embedded in Money tab
- [x] `job_payments` table + payment history reads from HH billing_list (source of truth)
- [x] Record Payment → creates HH deposit (two-step Xero sync) + OP audit record
- [x] Deposit calculator (25% / £100 floor / full if <£400) on Money tab
- [x] Job values populate from HH billing_list (bulk sync endpoint + per-job side-effect)
- [x] "Overview" tab (renamed from Job Requirements) with payment progress bar
- [x] Client balance auto-suggest on Money tab
- [ ] Email triggers on excess/payment status transitions (NEXT)
- [ ] Wire email triggers into record-payment and excess status changes

---

## Agent 3 — Global Ops Dashboard Widgets & Backline Module

**Branch:** `feature/ops-dashboard-streams`  
**Priority:** 🟡 MEDIUM-HIGH — needed for new staff member to see operational state  
**Estimated scope:** Stream 2 (dashboard widgets) + Stream 3 (backline/sub-hires) from CLAUDE.md

### What to build

#### Stream 2 — Global Operations Dashboard widgets (on existing `/dashboard` page)
Add these widgets to `DashboardPage.tsx` — each pulls from existing API endpoints:
- **Transport overview widget:** Jobs with transport (confirmed quotes), who's driving, dates
- **Backline overview widget:** Jobs with backline requirements, prep status
- **Incoming deliveries widget:** Expected arrivals today across all jobs
- **Payment summary widget:** Deposits pending, balances outstanding

#### Stream 3 — Backline + Sub-hires Module
New tables (migration 025 — Agent 3 writes this) and pages:

**Database (migration 025):**
```sql
job_backline (job_id, status, notes, item_count, checked_out_count)
job_subhires (job_id, what, supplier, status, cost, po_ref, due_date, received)
```

**Backend routes** (new files only — do not edit existing routes):
```
backend/src/routes/backline.ts    (new)
backend/src/routes/subhires.ts    (new)
```
Register these in `backend/src/routes/index.ts`

**Frontend pages:**
```
frontend/src/pages/BacklinePage.tsx      (new — global board view)
```
Backline is also visible as a section within `JobDetailPage.tsx` — add a "Backline" tab. Coordinate with Agent 4 who may also be adding a tab.

**Status flows:**
- Backline: not started → in progress → prepped → checked out → returned → issues
- Sub-hires: need → sourcing → ordered → received → returned

### Files owned by Agent 3
```
frontend/src/pages/DashboardPage.tsx           ← ADD widgets only, don't remove existing content
frontend/src/pages/BacklinePage.tsx            (new)
frontend/src/components/BacklineWidget.tsx     (new)
frontend/src/components/TransportWidget.tsx    (new)
frontend/src/components/PaymentSummaryWidget.tsx (new)
backend/src/routes/backline.ts                 (new)
backend/src/routes/subhires.ts                 (new)
backend/src/migrations/025_backline_subhires.sql (new)
frontend/src/components/Layout.tsx             ← COORDINATE — see warning below
```

### ⚠️ Layout.tsx conflict warning  
See Agent 2's note. If Agent 2 has already merged their Layout change, pull main first then add:
- "Backline" under Operations nav group (or confirm Operations nav already added by transport work)

### Files to READ but NOT edit
```
frontend/src/pages/JobDetailPage.tsx   (understand tab structure before adding Backline tab)
backend/src/routes/index.ts            (read to understand how to register new routes)
backend/src/migrations/run.ts          (MUST add 025 filename to the hardcoded array!)
shared/types/index.ts                  (read existing types, add new ones carefully)
```

### Do NOT touch
```
frontend/src/modules/vehicles/    (Agent 1)
frontend/src/pages/ExcessLedgerPage.tsx (Agent 2)
backend/src/routes/excess.ts
backend/src/routes/quotes.ts
backend/src/routes/jobs.ts
```

### ⚠️ Migration runner warning
When adding migration 025, you MUST also add the filename to the hardcoded array in:
`backend/src/migrations/run.ts`
This is a known gotcha — migrations don't auto-discover, they use a hardcoded list.

### Definition of done
- [ ] Dashboard shows transport, backline, payment, and deliveries widgets with real data
- [ ] Backline status can be set per job (via Job Detail tab)
- [ ] Sub-hires can be logged and tracked per job
- [ ] Global backline board page at `/backline` shows cross-job view
- [ ] Migration 025 runs cleanly on server

---

## Agent 4 — Incoming Deliveries, Lost Property & Payment Tracking

**Branch:** `feature/deliveries-payments`  
**Priority:** 🟡 MEDIUM — needed before busy period for day-to-day ops  
**Estimated scope:** Stream 4 (deliveries/lost property) + Stream 6 (payment tracking) from CLAUDE.md

### What to build

#### Stream 4 — Incoming Deliveries + Lost Property

**Database (migration 026 — Agent 4 writes this):**
```sql
incoming_deliveries (job_id, description, expected_date, box_count, received_count, status, sender_name)
lost_property (job_id, description, found_date, found_location, photo, client_notified, collected, dispose_after)
```

**Status flows:**
- Deliveries: expected → some received → all received → notified client → given to client
- Lost property: found → client notified → collection arranged → collected / dispose after date

**Backend routes** (new files):
```
backend/src/routes/deliveries.ts     (new — incoming deliveries, NOT transport quotes)
backend/src/routes/lost-property.ts  (new)
```

**Frontend pages:**
```
frontend/src/pages/DeliveriesPage.tsx      (new — /operations/deliveries)
frontend/src/pages/LostPropertyPage.tsx    (new — /operations/lost-property)
```

#### Stream 6 — Payment Tracking (pre-Xero)

**Database:** Add to migration 026:
```sql
job_payments (job_id, type: deposit/balance/refund, amount, method, status, date, reference)
```
Also add `payment_terms` column to `organisations` table.

**Backend:**
```
backend/src/routes/payments.ts    (new — job payment records, NOT Stripe portal)
```

**Frontend:**
- Payment summary section on Job Detail (progress bar: deposit → balance → paid)
- Payment terms field on Organisation detail page
- Feeds data to Agent 3's PaymentSummaryWidget

### Files owned by Agent 4
```
frontend/src/pages/DeliveriesPage.tsx           (new)
frontend/src/pages/LostPropertyPage.tsx         (new)
backend/src/routes/deliveries.ts                (new — incoming deliveries)
backend/src/routes/lost-property.ts             (new)
backend/src/routes/payments.ts                  (new — job payment records)
backend/src/migrations/026_deliveries_payments.sql (new)
frontend/src/components/Layout.tsx              ← COORDINATE — see warning below
```

### ⚠️ Layout.tsx conflict warning
Add "Deliveries" and "Lost Property" under Operations nav group only. Follow the same pattern as Agent 2 and 3 — pull main first if others have already merged their Layout changes.

### Files to READ but NOT edit
```
frontend/src/pages/JobDetailPage.tsx      (add payment section/tab — coordinate if Agent 3 also adding tab)
frontend/src/pages/OrganisationsPage.tsx  (read for pattern, add payment_terms field)
backend/src/routes/index.ts              (read to register new routes)
backend/src/migrations/run.ts            (MUST add 026 filename to hardcoded array!)
shared/types/index.ts                    (read + add new types)
```

### Do NOT touch
```
frontend/src/modules/vehicles/     (Agent 1)
frontend/src/pages/ExcessLedgerPage.tsx (Agent 2)
frontend/src/pages/BacklinePage.tsx     (Agent 3)
backend/src/routes/excess.ts
backend/src/routes/backline.ts         (Agent 3's new file)
```

### ⚠️ Migration runner warning
Same as Agent 3 — add `026_deliveries_payments.sql` to the hardcoded array in `backend/src/migrations/run.ts`.

### ⚠️ Coordination with Agent 3
Both agents may want to add a tab to `JobDetailPage.tsx` — Agent 3 for Backline, Agent 4 for Payments. 
**Rule:** If both are working simultaneously, each agent adds only their own tab component. Do not restructure the tab system — just append your tab to the existing array.

### Definition of done
- [ ] Incoming deliveries can be logged per job with box counts and status tracking
- [ ] Lost property can be logged with description, location, photo, and client notification
- [ ] Global pages at `/operations/deliveries` and `/operations/lost-property`
- [ ] Job payments can be recorded (deposit, balance, refund) with method and reference
- [ ] Payment progress visible on Job Detail
- [ ] Payment terms field on Organisation detail
- [ ] Migration 026 runs cleanly

---

## 🚦 Shared Files — Coordination Required

These files may need changes from multiple agents. Rules are strict:

| File | Who can edit | Rule |
|------|-------------|------|
| `frontend/src/components/Layout.tsx` | Agents 2, 3, 4 | Only edit your own nav item. Pull main before editing if others have merged. |
| `frontend/src/pages/JobDetailPage.tsx` | Agents 2, 3, 4 | Only add your own tab/section. Never restructure existing tabs. |
| `backend/src/routes/index.ts` | Agents 3, 4 | Only add your new route registration line. Don't edit existing lines. |
| `backend/src/migrations/run.ts` | Agents 3, 4 | Only add your migration filename to the array. Don't edit other entries. |
| `shared/types/index.ts` | Agents 3, 4 | Only add new types. Never modify existing type definitions. |

---

## 📋 Merge Order & Sequencing

Agents can work in parallel but merges must be sequential:

**Recommended merge order (by priority):**
1. Agent 1 (`feature/hire-form-cutover`) — highest priority, fewest shared file conflicts
2. Agent 2 (`feature/excess-gate-ledger`) — high priority, mostly isolated files
3. Agent 3 (`feature/ops-dashboard-streams`) — medium, after Agent 2 merges Layout
4. Agent 4 (`feature/deliveries-payments`) — medium, after Agent 3 merges Layout + run.ts

**After each merge:**
> Tell all other active agents: "Main has been updated with [branch name]. Please run `git fetch origin && git merge origin/main` into your current branch before continuing. Check for any conflicts in shared files."

---

## 🚀 Starting a New Agent Session

Copy and paste this briefing at the start of every new Claude Code session:

```
You are working on the Ooosh Operations Platform — a full-stack React/Node.js/PostgreSQL 
business operations system for Ooosh Tours Ltd.

Repo: https://github.com/jon-ooosh/Ooosh-Freelancer-Portal
Your branch: [INSERT BRANCH NAME]
Your domain: [INSERT DOMAIN FROM AGENT_MAP.md]

CRITICAL RULES:
1. Only touch files listed under "Files owned by" your agent section in AGENT_MAP.md
2. Never commit directly to main
3. Never modify shared types/interfaces — only add new ones
4. Check AGENT_MAP.md for coordination warnings before editing shared files
5. Commit and push regularly to your branch
6. When complete, tell me your branch is ready for PR review

Read CLAUDE.md fully before starting — it contains the full spec, current status, 
tech stack, API patterns, and all conventions you must follow.

Read AGENT_MAP.md to understand your exact file ownership and what to avoid.
```

---

## 📊 Progress Tracking

Update this section as work completes:

### Agent 1 — Hire Form Cutover & PDF Generation
- [x] Phase C2: driver-hire-api.ts repointed to OP backend
- [x] Phase C2: useDriverHireForms follows automatically
- [x] Hire form PDF generation service (exact port of Netlify function)
- [x] PDF endpoints: generate, download, send-email, PATCH for mid-hire changes
- [x] Email service: attachment support + hire_form template
- [x] Testing UI on Job Detail Crew & Transport tab
- [ ] Phase D: AllocationsPage reading from vehicle_hire_assignments
- [ ] Phase C4: cutover checklist document written
- [ ] Branch ready for PR

### Agent 2 — Excess Gate & Ledger
- [x] Excess gate banner on Job Detail (ExcessGateBanner.tsx with manager override)
- [x] Dispatch warning with override (not hard block — amber warning, manager can override with reason)
- [x] Manager override with reason capture (picklist + notes, logged to audit trail)
- [x] /money/excess ledger page built (client ledger + all-records views, status filters)
- [x] Payment/claim/reimburse/waive/rollover/move actions (ExcessPaymentModal.tsx)
- [x] Excess History tabs on PersonDetailPage + OrganisationDetailPage
- [x] Migration 034 (dispatch_override, suggested_collection_method, person_id, notes)
- [x] Backend: override, move, by-person, by-org, client-balance endpoints
- [x] 6 email templates for excess lifecycle events
- [x] Branch merged to main (26 Mar 2026)
- [ ] Wire email triggers to status transitions
- [ ] Auto-suggest client balance on new assignments
- [ ] Payment Portal repointing (Phase F — see CLAUDE.md)

### Agent 3 — Ops Dashboard & Backline
- [ ] Dashboard transport widget
- [ ] Dashboard backline widget
- [ ] Dashboard payment summary widget
- [ ] Migration 025 written and added to run.ts
- [ ] Backline status per job (Job Detail tab)
- [ ] Sub-hires per job
- [ ] /backline global board page
- [ ] Branch ready for PR

### Agent 4 — Deliveries, Lost Property & Payments
- [ ] Incoming deliveries per job + global page
- [ ] Lost property per job + global page
- [ ] Job payment recording
- [ ] Payment progress on Job Detail
- [ ] Payment terms on Organisations
- [ ] Migration 026 written and added to run.ts
- [ ] Branch ready for PR
