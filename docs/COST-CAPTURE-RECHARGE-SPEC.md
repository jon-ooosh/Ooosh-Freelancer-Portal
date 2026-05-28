# Cost Capture & Recharge — Implementation Spec

**Status:** Scoping → ready to build (Phase 1)
**Branch:** `claude/review-receipt-uploader-Nk3zx`
**Replaces:** The current Jotform receipt uploader (which only emails the captured photo to Xero's receipt inbox — no metadata carried forward)
**Dependencies:** Email service ✓, R2 file storage ✓, Inbox/notification system ✓, HireHop broker ✓. New: Xero integration.

---

## Overview

A **staff-facing** system for capturing any business cost — a receipt, an invoice, a freelancer's fee — and routing it to the right place. It replaces the Jotform process and adds the intelligence that Jotform throws away.

Three jobs:

1. **Capture** — photo + who/what/how-much/how-paid. Mobile-first (phone camera), also clean on desktop (drag-drop emailed invoices). AI reads the receipt; **every deduced field is editable**.
2. **Route** — a branching form decides where the cost *goes*: business overhead, a hire (HireHop job), a vehicle, company stock, replacement parts, or a freelancer invoice.
3. **Resolve** — the cost feeds up to three downstream ledgers:
   - **Recharge** → bill back to a client (flag-and-confirm push to HireHop)
   - **Payable** → "bills I need to pay" (freelancer invoices, reimbursements)
   - **Reconcile** → matched against Xero (so the bookkeeper stops chasing unallocated amounts)

**Not in scope (for now):** freelancer/public access. Everything is behind OP staff auth. A cut-down freelancer-portal submission path is a possible future phase (see §12).

---

## Component 1: The cost model

A single `costs` entity with optional **facets** (job, vehicle, freelancer), rather than separate silos — because one upload can be several things at once (the classic: a client-caused refuel is *both* a vehicle cost *and* a client recharge).

### Core fields

| Field | Source |
|---|---|
| `uploaded_by` (user), `uploaded_at` | OP session |
| `supplier_name`, `cost_date`, `amount_gross`, `amount_vat`, `amount_net`, `currency` | **AI-extracted, staff-confirmed/edited** |
| `description` / what it's for | staff |
| `category` + `xero_account_code` | AI auto-suggest from supplier pattern, mapped to live Xero chart of accounts |
| `cost_type` (the router) | `overhead` · `job` · `vehicle` · `stock` · `parts` · `freelancer_invoice` |
| `payment_method` | `cot_card` · `petty_cash` · `paypal` · `reimburse_me` · `not_yet_paid` · `other` |
| `cot_card_holder` / card last-4 | when `payment_method = cot_card` |
| `payment_status` | `paid` · `awaiting_payment` · `awaiting_invoice` |
| `receipt_r2_key`, `receipt_filename` | R2 (camera or upload) |
| `job_id` (+ HH job number) | facet link |
| `vehicle_id` | facet link |
| `quote_assignment_id` | facet link (freelancer → the job assignment, for expected-vs-actual) |
| `recharge_mode` | `none` · `full` · `partial` |
| `recharge_amount`, `recharged_to_hh_at`, `recharge_hh_item_id` | recharge facet |
| `approval_state` | `submitted` · `verified` · `approved` · `paid` (payables only) |
| `xero_sync_state` | `pending` · `bill_created` · `attached` · `reconciled` · `error` |
| `status` | `draft` · `confirmed` · `resolved` |

### Why one model

- **Vehicle costs** write through to the existing fuel/service log (which already carries `cost` + `receiptFile`) rather than duplicating — the vehicle facet *is* the same record, surfaced on the vehicle page.
- **Recharge** and **payable** are just states/flags on the cost, so a single list view can answer "what do we owe?" and "what can we bill back?" without joins across silos.

---

## Component 2: Capture flow

### Entry points

- **`/money/costs` → "Add cost"** (global hub, admin/manager).
- **"Add a cost" button on the Job View → Money tab** — pre-fills `job_id` + HH number. The natural home for hire-related costs.
- **Vehicle detail page** — existing "record fuel/service" entry points feed the same model with the vehicle facet pre-filled.
- **Mobile** — a stripped "snap a receipt" flow: camera → AI reads → confirm 3 fields → done. Friction reduction is the single biggest lever on the "staff don't log" problem.

### AI extraction

- On upload, the image/PDF goes to a `POST /api/costs/extract` endpoint → Claude vision → returns `{ supplier, date, gross, vat, net, currency, line_items[], suggested_category }`.
- The form pre-fills with the extraction; **all fields remain editable** (extraction errors are expected, not exceptional).
- `suggested_category` maps to a Xero account code; staff can override from the live chart-of-accounts picker.

### Branching form (the router)

Mirrors the Jotform's "Is this paid?" radio but adds the "what is it" branch:

```
What is this cost for?
├─ Business overhead (milk, cleaning) → category only, no facet
├─ A hire (job)        → HH job picker → "Recharge to client?" none/full/part(+amount)
├─ A vehicle           → vehicle picker → reuse existing fuel/service options
│                                        → (optional) also recharge to a job
├─ Company stock       → stock/capex category
├─ Replacement parts   → vehicle OR general stock
└─ Freelancer invoice  → job(s) + assignment → expected-vs-actual check (Component 5)

How was it paid?  [COT card · petty cash · PayPal · reimburse me · not yet paid · other]
```

---

## Component 3: Payment method → Xero action

The key insight: **anything paid by COT card is already in Xero** (COT → Codat bank feed → Xero), so OP must **never re-create that transaction** — it only enriches it. Other payment types aren't in Xero yet, so OP creates them.

| Payment status | Already in Xero? | OP's Xero action |
|---|---|---|
| Paid by **COT card** | **Yes** (Codat feed) | Attach receipt + apply account code + tracking. Do **not** create a transaction. *(See verification note.)* |
| **Not yet paid** (freelancer / supplier invoice) | No | Create a **bill (ACCPAY)** with line items, code, VAT + attach receipt → becomes the "to pay" list. |
| **Petty cash / PayPal / reimburse-me** | No | Create spend-money (or bill) + attach receipt. |

> **⚠️ Verification required at build time:** confirm the *shape* COT pushes into Xero via Codat — reconcilable **bank-statement feed lines** (most likely) vs fully-formed spend-money transactions. This decides whether OP attaches to an existing object, or creates the coded spend-money for the feed line to reconcile against (a raw unreconciled feed line may not accept an attachment until a transaction exists). The principle — *enrich, don't duplicate* — holds either way.

**Transition safety net:** keep emailing the photo to Xero's receipt inbox (current behaviour) as a zero-risk fallback during the build, then cut over to the API attach (which carries the full metadata Jotform discards).

---

## Component 4: The three resolution ledgers

All three are filtered views over `costs`, surfaced under the Money nav.

### 4a. Recharges Pending (`/money/costs?view=recharge`)
Costs flagged `recharge_mode != none` that haven't hit HireHop yet.
- **Flag-and-confirm, never auto-push.** Staff eyeball the amount, then confirm.
- On confirm: push a chargeable line item to HH via `save_job.php` (`items: {b<stockId>: qty}` — same mechanism as the additional-driver charge). Needs a small set of generic "recharge" stock items in HH (e.g. *Recharge — Fuel*, *Recharge — Damage/Replacement*, *Recharge — Other*) so an arbitrary amount can be billed.
- Records `recharged_to_hh_at` + `recharge_hh_item_id`.

### 4b. Bills to Pay (`/money/costs?view=payable`)
Costs with `payment_status IN (awaiting_payment, awaiting_invoice)`. Your freelancer-invoice tracker.
- `awaiting_invoice`: logged at purchase, no invoice yet → sits in a chase list.
- `awaiting_payment`: invoice in hand, runs through the approval workflow (Component 6).

### 4c. Reconciliation (`/money/costs?view=reconcile`)
The bookkeeper-pain killer. Reads COT card transactions **from Xero** and matches them to uploaded receipts by amount + date + card-holder.
- **Receipt with no transaction** → fine, awaiting feed.
- **Transaction with no receipt** → chase the buyer *within days* (inbox notification to the card-holder), not months later via the bookkeeper.
- Match confidence shown; staff confirm ambiguous matches.

---

## Component 5: Freelancer expected-vs-actual

- Freelancer invoice links to one or more `quote_assignments` — we hold the **agreed rate** there.
- Card shows *expected* (agreed fee + any pre-agreed expenses) vs *invoiced*, with variance flagged.
- **Bundled invoice** (5 jobs on one): allow one cost record to allocate across multiple jobs/assignments, each slice checked against its expected rate.
- **Freelancer-incurred client costs** (their train fare we recharge on): tag that line `recharge` → it flows into the job's recharge bucket (4a) so it's billed back.

---

## Component 6: Approval workflow (payables only)

Already-paid COT costs need **coding only, no approval**. The workflow applies to things we still owe.

```
submitted → verified (booker) → approved (admin) → paid (admin)
```

**The circular-flag fix:** the "verify" step is satisfied *at upload when the uploader is the booker*. Will uploading Anna's invoice **is** Will vouching for it — so it skips straight to your approve-and-pay queue. Expected-vs-actual is shown inline at upload; the booker ticks "amount verified". A separate routed verify-task only fires when **uploader ≠ booker** (future: freelancer self-submits via portal, or admin uploads on someone's behalf — we know the booker from `quote_assignments`, so it lands in *their* inbox).

- **Visibility:** manager+ see the full payables queue.
- **Payment:** **admin only** marks `paid` (date + method). On `paid`, the Xero bill is settled / spend-money recorded.
- Ties into the existing **Inbox/notification system** for routing + nudges.

---

## Component 7: Xero integration

No Xero integration exists today (everything reaches Xero *through* HireHop). This builds a **direct** connection — baked in from Phase 1 since it shapes the data model.

### App type — decision

OP connects to exactly **one** Xero org (Ooosh's own), server-side, no end-user in the auth loop.

- **Recommended: Custom connection** (client-credentials / M2M grant). Purpose-built for "my own back-office app ↔ my own Xero". No interactive consent, no refresh-token juggling. Premium (small monthly fee per connection), UK-available.
- **Fallback: Web app** (authorization-code grant). Free for one org. Requires a one-time OAuth consent, then OP stores + refreshes tokens server-side (30-min access tokens, 60-day rotating refresh tokens).
- ✗ Mobile/desktop (PKCE) — not us.

> **Prerequisite:** Jon to create the Xero developer app and confirm which type. Spec assumes Custom connection; if Web app, add a `xero_tokens` table + refresh scheduler.

### What we use

| Capability | Xero API | Use |
|---|---|---|
| Chart of accounts | `GET /Accounts` | live category picker + auto-suggest mapping |
| Create bill | `PUT /Invoices` (Type `ACCPAY`) | unpaid freelancer/supplier invoices |
| Spend money | `PUT /BankTransactions` (`SPEND`) | petty cash / PayPal / reimbursements not on a feed |
| Attach receipt | `PUT /{Invoices\|BankTransactions}/{id}/Attachments` | the receipt photo lands in Xero |
| Read COT transactions | `GET /BankTransactions` (COT account) | reconciliation (Component 4c) |
| Tracking categories | `GET /TrackingCategories` | optional — tag costs by job/department |
| Tax rates | `GET /TaxRates` | VAT handling on bills |

- All Xero calls go through a new `xero-broker.ts` (token mgmt, rate-limit ≈60/min, retry) mirroring the HireHop broker pattern.
- `xero_sync_state` on each cost tracks where it is; failures are non-fatal and surfaced for retry.

---

## Component 8: Job close-out integration

Attacks the "can I confidently close this hire?" pain.

- An **"Outstanding costs"** indicator on Job View → Money tab: any unresolved cost (un-recharged recharge, unpaid bill) flagged on the job.
- Ties into the existing **Returns & Close-Out requirement** system (same pattern as `damage_review`): a job can't cleanly close with an unresolved cost. Either resolve, recharge, or explicitly mark "no further costs".

---

## Component 9: Database — Migration 066

> Verify the next free migration number before building, and **add the filename to the hardcoded array in `backend/src/migrations/run.ts`**.

```sql
CREATE TABLE IF NOT EXISTS costs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Capture
  uploaded_by     UUID NOT NULL REFERENCES users(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  supplier_name   VARCHAR(200),
  cost_date       DATE,
  amount_gross    NUMERIC(12,2),
  amount_vat      NUMERIC(12,2),
  amount_net      NUMERIC(12,2),
  currency        VARCHAR(3) NOT NULL DEFAULT 'GBP',
  description     TEXT,
  category        VARCHAR(100),
  xero_account_code VARCHAR(20),

  -- Routing
  cost_type       VARCHAR(30) NOT NULL,    -- overhead|job|vehicle|stock|parts|freelancer_invoice
  payment_method  VARCHAR(20),             -- cot_card|petty_cash|paypal|reimburse_me|not_yet_paid|other
  cot_card_holder VARCHAR(120),
  cot_card_last4  VARCHAR(4),
  payment_status  VARCHAR(20) NOT NULL DEFAULT 'paid',  -- paid|awaiting_payment|awaiting_invoice

  -- Facets
  job_id              UUID REFERENCES jobs(id),
  vehicle_id          UUID REFERENCES fleet_vehicles(id),
  quote_assignment_id UUID REFERENCES quote_assignments(id),

  -- Recharge
  recharge_mode       VARCHAR(10) NOT NULL DEFAULT 'none',  -- none|full|partial
  recharge_amount     NUMERIC(12,2),
  recharged_to_hh_at  TIMESTAMPTZ,
  recharge_hh_item_id VARCHAR(40),

  -- Approval (payables)
  approval_state  VARCHAR(20),             -- submitted|verified|approved|paid
  verified_by     UUID REFERENCES users(id),
  verified_at     TIMESTAMPTZ,
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  paid_by         UUID REFERENCES users(id),
  paid_at         TIMESTAMPTZ,
  paid_method     VARCHAR(40),

  -- Receipt
  receipt_r2_key   VARCHAR(500),
  receipt_filename VARCHAR(200),

  -- Xero
  xero_sync_state  VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending|bill_created|attached|reconciled|error
  xero_object_id   VARCHAR(60),            -- Xero Invoice/BankTransaction ID
  xero_synced_at   TIMESTAMPTZ,
  xero_error       TEXT,

  status          VARCHAR(20) NOT NULL DEFAULT 'draft',     -- draft|confirmed|resolved
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bundled-invoice allocations: one cost split across many jobs/assignments
CREATE TABLE IF NOT EXISTS cost_allocations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_id             UUID NOT NULL REFERENCES costs(id) ON DELETE CASCADE,
  job_id              UUID REFERENCES jobs(id),
  quote_assignment_id UUID REFERENCES quote_assignments(id),
  amount              NUMERIC(12,2) NOT NULL,
  recharge            BOOLEAN NOT NULL DEFAULT FALSE,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_costs_job ON costs(job_id);
CREATE INDEX IF NOT EXISTS idx_costs_vehicle ON costs(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_costs_payable ON costs(payment_status) WHERE payment_status != 'paid';
CREATE INDEX IF NOT EXISTS idx_costs_recharge ON costs(recharge_mode) WHERE recharge_mode != 'none';
```

---

## Component 10: Backend API (`routes/costs.ts`)

| Endpoint | Purpose |
|---|---|
| `POST /api/costs/extract` | Image/PDF → Claude vision → extracted fields |
| `POST /api/costs` | Create cost (after staff confirm) |
| `GET /api/costs` | List + filters (view=recharge\|payable\|reconcile, type, status, date) |
| `GET /api/costs/:id` | Detail |
| `PATCH /api/costs/:id` | Edit |
| `POST /api/costs/:id/recharge` | Flag-and-confirm → push HH chargeable item |
| `POST /api/costs/:id/verify` | Booker verifies (payables) |
| `POST /api/costs/:id/approve` | Admin approves (payables) |
| `POST /api/costs/:id/pay` | Admin marks paid (admin only) |
| `POST /api/costs/:id/xero-sync` | Create bill / attach receipt / retry |
| `GET /api/costs/reconcile/unmatched` | COT Xero txns with no receipt + receipts with no txn |
| `POST /api/costs/:id/match-xero` | Confirm a reconciliation match |
| `GET /api/costs/by-job/:jobId` | Job View Money tab + close-out flag |

RBAC: capture/list = staff+; verify = manager+; approve/pay = admin.

---

## Component 11: Frontend

- **`/money/costs`** hub page: tabs *Inbox/Unreviewed · Recharges · Bills to Pay · Reconciliation*. Card layout (mobile-friendly), filter pills, search.
- **`AddCostModal`** / mobile capture: camera input → extraction spinner → editable confirm form with the branching router.
- **Job View → Money tab:** "Add a cost" button + outstanding-costs section.
- **Vehicle detail:** existing fuel/service entry points write through to `costs`.
- Reuse `RequirementCard` patterns + Money-tab styling for consistency.

---

## Component 12: Phasing

**Phase 1 — Capture + tracking + recharge + Xero (core)**
- [ ] Migration 066 + `run.ts`
- [ ] `costs` + `cost_allocations`, `routes/costs.ts`, RBAC
- [ ] AI extraction endpoint (Claude vision) + editable confirm form
- [ ] Branching capture form; entry points (hub, Job View, mobile, vehicle write-through)
- [ ] Recharges Pending view + flag-and-confirm HH push (+ generic recharge stock items)
- [ ] Bills to Pay view + approval workflow (with uploader-is-booker shortcut)
- [ ] Xero broker + app connection (Custom connection)
- [ ] Create bills (ACCPAY) + attach receipts + chart-of-accounts picker
- [ ] Job close-out outstanding-costs flag

**Phase 2 — Reconciliation + polish**
- [ ] Read COT transactions from Xero; auto-match by amount/date/card
- [ ] "Transaction with no receipt" chase notifications to card-holder
- [ ] Bundled-invoice allocation UI; freelancer expected-vs-actual variance flags
- [ ] Spend-money for petty cash / PayPal / reimbursements
- [ ] Tracking categories (job/department tagging)

**Phase 3 — Future (not scheduled)**
- [ ] Cut-down freelancer-portal submission path (freelancer self-submits invoice → routes verify-task to booker)
- [ ] Supplier-pattern learning for category auto-suggest
- [ ] Spend analytics / overhead dashboards

---

## Open verification items (before/at build)

1. **Codat→Xero shape** — bank-feed statement lines vs spend-money transactions (decides attach vs create — Component 3).
2. **Xero app type** — Custom connection (recommended) vs Web app — Jon to set up the developer app.
3. **Generic HH recharge stock items** — create the small set in HireHop, capture their stock IDs.
4. **Reimbursement payouts** — how staff reimbursements are actually paid (payroll? bank transfer?) so the `paid` step records correctly.
