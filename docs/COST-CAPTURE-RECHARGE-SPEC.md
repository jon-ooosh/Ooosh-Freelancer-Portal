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

- **Vehicle costs** link 1:1 to the existing fuel/service log (which already carries `cost` + `receiptFile`) rather than duplicating — see §7a. The vehicle log stays the maintenance home; `costs` is the financial spine underneath it.
- **Repair/damage costs** link to the existing `platform_issues` record (the Problems module) — see §7b.
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
- **Bundled invoice** (5 jobs on one): an **allocation modal** splits one cost across jobs — "£80 → job 12345, £22 → job 23456" — writing a `cost_allocations` row per line. Each line shows that job's expected rate inline so the split is checked as it's entered. Allocated total must reconcile to the invoice gross.
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

### App type — DECIDED: Custom Connection

OP connects to exactly **one** Xero org (Ooosh's own), server-side, no end-user in the auth loop — the textbook case for a **Custom Connection** (`client_credentials` grant). Confirmed facts (Xero developer docs, May 2026):

- **No refresh tokens.** The `client_credentials` grant has none. The server mints a fresh 30-min access token on demand with `client_id` + `client_secret` — **fully programmatic, indefinitely. No manual 60-day reauthorisation** (that headache is exclusive to the Web app authorization-code flow).
- **Free** under the Starter tier (5 connections, 1,000 API calls/day/org). No separate per-connection fee.
- **One organisation per connection** — exactly our case.
- **Egress is a non-issue:** reading COT transactions for reconciliation is a few dozen rows/month (KB, not GB). The 1,000 calls/day Starter rate limit is the only ceiling and is far above our need.

> No `xero_tokens` table or refresh scheduler needed. The broker just caches the current access token and re-mints on 401/expiry.
> **Prerequisite:** Jon creates the Xero developer app as a *Custom Connection* and supplies `client_id` + `client_secret` (server env vars).

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

## Component 7a: Vehicle service/fuel log — adjunct, not replacement

The existing `vehicle_service_log` / `vehicle_fuel_log` are **not replaced**. They hold vehicle-domain fields (mileage, next-due date/mileage, garage, service type) that don't belong on a generic cost. Instead:

- A service/fuel record with a cost links **1:1** to a `costs` row (`costs.vehicle_service_log_id` / `costs.vehicle_fuel_log_id`).
- **Enter from either side, no double-entry:** saving the existing Add Service/Fuel modal with a cost can create the linked `costs` row; capturing a `cost_type = vehicle` cost can write through to the service/fuel log.
- This ensures vehicle spend flows into Xero coding + reconciliation (Component 4c) — otherwise reconciliation would have a vehicle-shaped hole.

## Component 7b: Problems module — repair cost wire-up

The `platform_issues` Problems module already anticipates this: its resolution panel shows Estimated/Actual cost with the note *"Cost is informational only — future wire-up to HireHop / Xero pending. Don't double-enter into the Money tab."* **This system is that wire-up.**

- A repair invoice (TTS360, garage, parts) logged against a problem links via `costs.platform_issue_id`.
- The cost flows to Xero, and if the damage is **client-caused**, into the recharge bucket (4a) → billed back via HireHop.
- The problem's **"Actual" cost reads from the linked `costs` row** instead of being a dead informational field — removing the "don't double-enter" caveat. Estimated stays a manual field on the issue (it's a pre-cost guess).

## Component 8: Job close-out integration

Attacks the "can I confidently close this hire?" pain.

- An **"Outstanding costs"** indicator on Job View → Money tab: any unresolved cost (un-recharged recharge, unpaid bill) flagged on the job.
- Ties into the existing **Returns & Close-Out requirement** system (same pattern as `damage_review`): a job can't cleanly close with an unresolved cost. Either resolve, recharge, or explicitly mark "no further costs".

---

## Component 9: Database — Migration 070

> Migrations already run to 069, so this is **070** (`070_cost_capture.sql`), added to the hardcoded array in `backend/src/migrations/run.ts`. **Built in the foundation PR.**

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
  platform_issue_id   UUID REFERENCES platform_issues(id),       -- repair/damage costs (§7b)
  vehicle_service_log_id UUID REFERENCES vehicle_service_log(id), -- 1:1 maintenance link (§7a)
  vehicle_fuel_log_id    UUID REFERENCES vehicle_fuel_log(id),    -- 1:1 fuel link (§7a)

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

## Component 11a: Reporting & queryability

Because every cost is **structured data** (not a photo emailed into Xero), the dataset is fully analysable — a deliberate win over the Jotform black hole. The schema captures the dimensions that make the useful slices cheap:

| Question | Query shape |
|---|---|
| Fuel recharged to clients vs absorbed by us | `costs WHERE category='fuel' GROUP BY recharge_mode` (× vehicle / period) |
| Total spend per vehicle | `costs WHERE vehicle_id=? GROUP BY category` (joins service/fuel log) |
| Outstanding payables (incl. by freelancer) | `costs WHERE payment_status!='paid'` |
| Recharges billed vs pending per job | `costs WHERE job_id=? AND recharge_mode!='none'` |
| Spend by Xero account code / period | `costs GROUP BY xero_account_code, date_trunc('month', cost_date)` |

Phase 1 ships these as filters/exports on the hub; a dedicated **`/money/costs/reports`** dashboard (charts) is Phase 3. The point is the *data shape* is right from day one, so reports are additive, never a schema migration.

## Component 12: Phasing

**Phase 1 — Capture + tracking + recharge + Xero (core)**
- [ ] Migration 066 + `run.ts`
- [ ] `costs` + `cost_allocations`, `routes/costs.ts`, RBAC
- [ ] AI extraction endpoint (Claude vision) + editable confirm form
- [ ] Branching capture form; entry points (hub, Job View, mobile, vehicle write-through)
- [ ] Recharges Pending view + flag-and-confirm HH push (+ generic recharge stock items)
- [ ] Bills to Pay view + approval workflow (with uploader-is-booker shortcut)
- [ ] Xero broker + Custom Connection (client_credentials, no token table)
- [ ] Create bills (ACCPAY) + attach receipts + chart-of-accounts picker
- [ ] Vehicle service/fuel log ↔ `costs` 1:1 link (§7a)
- [ ] Problems module repair-cost link (§7b) — Actual cost reads from linked `costs`
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

1. **Codat→Xero shape** — bank-feed statement lines vs spend-money transactions (decides attach vs create — Component 3). *The one remaining external unknown.*
2. **Generic HH recharge stock items** — create the small set in HireHop, capture their stock IDs.
3. **Reimbursement payouts** — how staff reimbursements are actually paid (payroll? bank transfer?) so the `paid` step records correctly.
4. **Company stock / capex vs overhead** — confirm whether company-stock/capex costs need different Xero account coding from general overhead (likely yes — capex to an asset/stock account). Affects category mapping defaults only.

### Decided
- **Xero app type:** Custom Connection — `client_credentials`, free (Starter tier), single-org, no refresh tokens. ✓
- **Recharge to HH:** flag-and-confirm, never auto-push. ✓
- **Approval:** uploader-is-booker satisfies verify inline → admin approves + pays. ✓
- **Service log & Problems module:** adjunct with 1:1 `costs` links, not replaced. ✓

---

## Build notes — testing round 1 (29 May 2026)

Frontend hub + manual capture shipped (PR #592) and tested live. Decisions + follow-ups from that round:

**Xero scopes — `accounting.transactions` is gone.** Xero split the old umbrella scope into granular ones. The Ooosh Custom Connection was granted `accounting.banktransactions` / `.settings` / `.contacts` / `.attachments` — which covers reads, spend-money, COT reconciliation, and receipt attachment. **ACCPAY supplier bills need `accounting.invoices`** (a bill is an Invoice of type ACCPAY). Action when bill-creation is wired:
- [ ] Tick `accounting.invoices` (+ `.read`) on the Custom Connection and reconnect.
- [ ] Add `accounting.invoices` to `DEFAULT_SCOPES` in `config/xero.ts` (only AFTER it's granted — requesting an ungranted scope fails the whole client_credentials token mint and breaks the working reads).

**Curated account picker.** `GET /api/costs/xero/accounts` returns only a staff-facing subset (`STAFF_COST_ACCOUNT_CODES` in `routes/costs.ts`), ordered for the dropdown; `?all=true` returns the full chart. Current set: 320 crew, 325 crew costs, 326 sub-hire, 399 PCNs/fines, 406 vehicle upkeep, 409 vehicle repairs, 473 equipment upkeep, 310 shop stock, 410 fuel, 411 parking, 425 postage/courier, 429 other, 494 office expenses, 710 office equipment, 720 computer equipment, 764 new equipment. Move to `system_settings` if it ever needs editing without a deploy.

**Capture modal UX (done this round):** receipt moved to top (AI extraction will fill the rest from it); image receipt preview; card holder defaults to logged-in user; net/VAT/gross auto-calc at 20% with a toggle to edit manually; uploaded-by column + tidy UK date on the hub.

**Card last-4 — follow-up.** Currently remembered in `localStorage` so staff don't retype it. Proper fix: a per-staff COT card register (last4 + card label) on the user/person profile, auto-filled at capture. Different staff carry different COT cards, so a single global setting won't do.
- [ ] Per-staff COT card field(s) on profile + auto-fill in capture modal.

**"Nothing pushed to Xero yet" is expected.** Capture stores the cost + receipt in OP/R2 only. Pushing to Xero (creating a bill / attaching the receipt / reconciling a COT-card line) is the not-yet-wired fast-follow. A COT-card purchase (e.g. the D'Addario strings on Chris's card) reconciles against the COT bank feed — it's not an ACCPAY bill.

**AI auto-fill (fast-follow).** Receipt-at-top is laid out for it. `POST /api/costs/extract` (Claude vision) → returns supplier/date/amounts/suggested account → pre-fills the modal for staff to confirm. Needs `ANTHROPIC_API_KEY`.

## Build notes — testing round 2 (29 May 2026)

**Single "What's this cost for?" picker.** The separate Cost Type + Xero account dropdowns were merged into one plain-English picker (no codes, no Xero/accountant terminology). The `COST_CATEGORIES` map in `CostCaptureModal.tsx` is the single source of truth — each label carries a hidden Xero account code + a derived `cost_type` (which is only a filter/display field, nothing load-bearing). The hub "Type" column now shows the friendly `category` label. The backend curated `/xero/accounts` endpoint stays as a Xero diagnostic; the picker no longer depends on a live Xero fetch (works even if Xero is down). Keep `COST_CATEGORIES` (frontend) and `STAFF_COST_ACCOUNT_CODES` (backend) in step.

**Edit / Delete.** Surfaced the existing `PATCH` / `DELETE` endpoints as row actions on the hub (Delete = admin/manager). The capture modal doubles as the edit modal (`existing` prop → PATCH). Receipt can be replaced; the saved receipt is viewable inline.

**Xero-lock semantics (forward-design for when the push lands).** Edit/Delete are OP-only today (nothing is pushed yet). Once the push is wired: while a record is still draft/unreconciled in Xero, edits propagate (update bill) and delete voids it; once it's authorised/reconciled in Xero it's locked — the UI blocks edit/delete and offers void-and-recreate. The hub already guards `xero_sync_state === 'reconciled'` on delete as the seed of this.

**Bigger receipt preview.** Image receipts render full-width (max 256px tall, click to open full size); PDFs render an inline `<embed>` preview.

## Build notes — testing round 3 (30 May 2026)

**Two-pane resizable modal.** On md+ the capture modal now splits into a receipt-preview pane (left) and form pane (right) with a draggable divider. Width persists per-user in `localStorage` (`ooosh_cost_modal_split_pct`), clamped 25–70%. Mobile keeps the stacked layout. Click backdrop (or Esc) to dismiss.

**Supplier autocomplete from Xero contacts.** Typing in the Supplier field debounces (300ms) and queries `GET /api/costs/xero/suppliers?search=` — backed by a new `xeroBroker.searchContacts()` method using Xero's `searchTerm` (active contacts, capped at 10). Picks an existing supplier with one click; free-text is still allowed (resolved at push time via `getOrCreateContact`). Degrades silently if Xero is unreachable.

**Grouped categories.** The "What's this cost for?" picker is now grouped under headings — People / Vehicles / Equipment / Office & other — using native `<optgroup>`. Helps staff land on the right choice. The "Crew travel" label is broadened to "Travel (taxis, trains etc.)"; same Xero code (325).

## Build notes — Xero push wired (1 Jun 2026)

**Spend Money + receipt attach, automatic on save.** Once a paid cost is saved, the backend fires `services/cost-xero-push.ts` in `setImmediate` (so the API response isn't blocked on Xero). It creates a Spend Money on the mapped bank account, then downloads the receipt from R2 and attaches it via `PUT /BankTransactions/{id}/Attachments/{filename}`. Codat's bank-feed line auto-suggests the Spend Money for one-click reconciliation — replaces the "wall of un-reconciled lines" Ooosh have been wading through.

**State machine (`costs.xero_sync_state`).**
- `pending` → not yet pushed (fresh / unpushable)
- `bill_created` → Spend Money created (rendered "Sent")
- `attached` → + receipt attached (rendered "Synced")
- `reconciled` → bank line matched in Xero (future — set by webhook/sync)
- `error` → push failed; `xero_error` carries the message; **Retry** button in `/money/costs`

**Bank-account mapping** lives in `system_settings` under category `xero_bank_accounts`, one row per OP payment method (`xero_bank_cot_card / petty_cash / paypal / reimburse_me / other`). Values are Xero `AccountID` UUIDs. Admin sets the mapping via a new **Settings → Xero Bank Accounts** section that pulls the live bank-account list from `GET /api/costs/xero/bank-accounts`. Unmapped methods surface as a soft error on the cost with a retry once mapped.

**Forward-only by design.** A cost already in `bill_created` / `attached` / `reconciled` is idempotent — the push skips it. PATCH retriggers the push *only* when the cost is `pending` / `error` / has no `xero_object_id`. Edits to already-pushed costs are deliberately not auto-mirrored to Xero yet — that's a follow-up (update existing transaction when `bill_created` / `attached`, void-and-recreate once `reconciled`).

**ACCPAY (supplier bills) still deferred.** `not_yet_paid` costs hold in OP as payables; the push only fires once staff flip them to paid (with a `paid_method`). Needs `accounting.invoices` scope on the Custom Connection — flag for when the volume warrants it.

**Supplier fuzzy-match guard (not yet built).** Today free-text supplier entry creates a new Xero contact if no exact-name match — risks typo duplicates. Follow-up: at save time, surface "did you mean…?" suggestions when the input is close to an existing contact but not exact; at push time, do a `searchTerm` query as a final guard before falling back to `getOrCreateContact`.

**AI receipt extraction (next stage).** Claude vision reads the uploaded receipt and pre-fills supplier / date / amounts / category — reduces both manual data entry and the misclassification risk that surfaced in testing. Needs `ANTHROPIC_API_KEY`.
