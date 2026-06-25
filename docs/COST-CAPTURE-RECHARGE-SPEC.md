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

## Build notes — testing round 4 (1 Jun 2026)

**Card holder + last 4 are now stamped from the user's Profile.** Migration 102 adds `users.cot_card_last4`; users set it on their own Profile page. On cost create (and edit) with `payment_method='cot_card'`, the backend looks up the uploader's name + their stored last 4 and stamps both on the cost. The modal no longer asks staff to enter either every time.

**Unmapped payment methods are a soft skip, not a red error.** `cost-xero-push.ts` distinguishes "no bank account mapped for this method" from a real push failure — it leaves `xero_sync_state='pending'` and writes an advisory note into `xero_error`. The CostsPage renders this as a grey "Not synced" pill (tooltip explains why), instead of the red "Failed + Retry" we were showing. Methods the user deliberately leaves unmapped (e.g. Reimburse me / Other) stay calm in the hub.

**Capture modal on mobile.** Full-screen below `sm` (no surrounding grey, no rounded corners, full-height). The two panes (receipt + form) now share a single scroll on mobile — previously the receipt pane was sticky and ate input height.

**Optgroup styling.** Global rule in `styles/index.css` makes `<optgroup>` labels bold/dark on a light-grey strip across every `<select>` in the app — fixes the muddy default look the "What's this cost for?" picker (and any other future grouped select) inherited from Chrome.

**Re: COT reconciliation.** The Spend Money we push waits for Codat's bank-feed line; Xero's matching engine auto-suggests our Spend Money against the line — staff/accountant one-click reconcile. Future enhancement: poll Xero `/BankTransactions` for `IsReconciled=true` and flip our `xero_sync_state` to `reconciled` automatically.

## Build notes — testing round 5 (2 Jun 2026)

**Job picker in the modal.** "Link to job (optional — needed to recharge)" with debounced job search against `/api/search` (filtered to `type='job'`). Lights up the existing recharge controls. Pre-fills from `presetJobId` for entry-point integrations OR from `existing.job_id` on edit (displays `hh_job_number` + `job_name` when available). Sends `job_id` on both create AND edit so staff can change/clear the link later.

**Push now on "Not synced".** The soft "Not synced" pill kept a Push now button. Lets staff re-trigger after fixing the underlying gap (e.g. mapping just set in Settings) without having to edit/save to nudge the push.

## AI receipt extraction (Jun 2026)

**Endpoint:** `POST /api/costs/extract` (multipart, STAFF_ROLES). Accepts image (JPEG/PNG/GIF/WebP) or PDF. Returns structured JSON: `supplier / cost_date / amount_gross / amount_vat / amount_net / description / category_code / confidence` (+ optional `supplier_matched` when canonicalised against an existing Xero contact).

**Model:** Claude Haiku 4.5 via `@anthropic-ai/sdk`. Fast, ~£0.001/receipt at current rates.

**Prompt caching:** the system prompt + 16-code category enum is byte-identical across every call (no timestamps, no per-request state). One `cache_control: { type: 'ephemeral' }` breakpoint on it — from request 2 onwards the prefix serves at ~10% input cost. Cache hit visible in `usage.cache_read_input_tokens` (logged for telemetry).

**Structured output:** `output_config.format: { type: 'json_schema', schema: ... }` enforces the response shape — `category_code` is constrained to the 16-value enum, amounts are numeric, confidence is `high|medium|low`. No regex / no markdown-code-fence stripping needed.

**Supplier canonicalisation:** post-extraction we hit `xeroBroker.searchContacts(supplier, 5)` and substring-match against existing Xero contacts (case-insensitive both ways). Replaces typo variants with the canonical Xero name; `supplier_matched: { from, to }` returned for visibility. Fails silently if Xero is unreachable.

**UX:** `✨ Extract details with AI` button on the receipt pane (create mode only) — appears once a file is selected. Pre-fills supplier, date, amounts (via `onGrossChange` so the 20% VAT auto-calc fires), description, category. Shows a confidence-coloured banner: green / amber / red. Staff verify and correct before saving.

**Inert without key:** `isAnthropicConfigured()` guard returns 503 cleanly. The button shows a friendly "AI extraction isn't enabled on the server yet" message instead of an error trace — capture still works manually with the existing form.

**Activation:** add `ANTHROPIC_API_KEY=sk-ant-...` to `backend/.env` and restart `ooosh-portal`. No migration, no other config.

**Cost ceiling:** Haiku 4.5 input is $1/1M tokens (output $5/1M). System prompt ~600 tokens cached after request 1; per-image overhead ~1000–1500 tokens depending on resolution; output JSON ~200 tokens. **Per-receipt: ~£0.001–£0.002**, dropping further as cache reads accumulate. Negligible at Ooosh volumes.

---

## Roadmap & handoff (Jun 2026)

### Status: Phase 1 functionally complete

What's **live and working** in production (as of this handoff):

| Capability | State |
|---|---|
| Costs hub at `/money/costs` (4 views, stats, filters, search) | ✅ live |
| Capture modal: receipt upload + preview, single category picker (16 plain-English options, grouped under People/Vehicles/Equipment/Office), supplier autocomplete from Xero contacts, smart 20% VAT auto-calc, Job picker for recharge | ✅ live |
| **AI receipt extraction** via Claude Haiku 4.5 vision — pre-fills supplier, date, amounts, description, category, with confidence-coloured banner | ✅ live |
| Mobile full-screen modal, two-pane resizable layout on desktop, click-outside / Esc to close | ✅ live |
| Edit + Delete on rows (Delete = admin/manager), Xero-lock-aware | ✅ live |
| COT card holder + last 4 stamped server-side from user Profile | ✅ live |
| `xero_account_code` is captured on every cost (from the picker) | ✅ live |
| **Push to Xero on save** — Spend Money on the mapped bank account + receipt attached (auto + manual retry) | ✅ live |
| Settings → Xero Bank Accounts mapping UI (live dropdown of Xero bank accounts) | ✅ live |
| Sync-state badges in hub (Sent / Synced / Reconciled / Failed / Not synced / Pending) with Push now | ✅ live |
| Payables workflow (verify → approve → pay), recharge flag-and-confirm | ✅ live |

### Operational clarifications (not bugs)

- **"Skipped: Bank account mapping missing"** when clicking Push now: this is expected for payment methods you left unmapped in Settings (typically "Other" / "Reimburse me"). Pick a different method on the cost, or map the method in Settings → Xero Bank Accounts.
- **"Stamped automatically as..."** notice removed from the modal (Jun 2026 cleanup) — only shows the "set last 4 in Profile" hint when the user hasn't set theirs.
- **Recharge → Partial amount** is now labelled "net of VAT" — VAT is added at HireHop bill time.

### Open design questions (next chat)

These are the meaty items left for Phase 2. None block live use of the current system.

#### 1. Recharge push to HireHop (Component 5 / Component 11)

Today's behaviour: staff flag a cost for recharge (none / full / partial); the cost row stamps `recharge_mode` + `recharge_amount`. The HireHop push is **not wired** — the original spec says "flag-and-confirm, never auto-push" and notes the prerequisite is "create the small set of generic HH recharge stock items, capture their IDs."

The design work needed:
- **HH stock item IDs**: agree the recharge categories that map to stock items in HH. Probable set: `Fuel`, `Parking & tolls`, `Travel (taxis/trains)`, `Vehicle damage`, `Sub-hire`, `Other recharge`. Each needs a stock item created in HireHop manually, and the resulting stock ID stored in `system_settings` (similar pattern to the Xero bank account mapping). We *already know how to create line items in HH* — the "add extra driver" / `additional driver charge` flow does this against stock ID 1324. So mechanically this is straightforward once the IDs exist.
- **Mapping cost category → HH stock item**: most of the 16 OP categories map naturally (Fuel → "Fuel" stock, Parking → "Parking & tolls", Travel → "Travel", Vehicle repairs/upkeep → "Vehicle damage", Sub-hire → "Sub-hire", everything else → "Other recharge"). Could live as another `system_settings` mapping.
- **Closed-job handling**: HireHop refuses line-item adds on closed jobs (we know this from the PCN tool). When push fails, surface the error inline ("Cannot add to HH — job closed. Create the bill another way.") and leave `recharge_mode='full|partial'` + `recharged_to_hh_at=NULL` so the cost sits in the **Recharges** view as a known-unresolved item. Don't block save.
- **The big conceptual issue jon raised — quoted vs actual**: many costs on a job are *already represented by a quote line* (e.g. a £300 D&C delivery quote already includes the freelancer's anticipated fee + travel + fuel). The freelancer's £200 invoice + £25 train + £35 fuel receipt are the *actuals* against the quote, not new line items to bill the client. Pushing them to HH would double-bill. This is **Component 5 territory — Freelancer expected-vs-actual variance** — and it needs the cost capture flow to distinguish:
  - **Pass-through cost** (already covered by the quote, just tracking spend) — never recharge, do NOT push.
  - **Above-and-beyond cost** (incurred for the job, not covered by the quote) — eligible for recharge push.

  Today the flag is one binary (`recharge_mode`). Probably wants an extra `cost_intent` field on the cost row: `quote_actual` (matches a quote line — reconcile only) vs `extra` (recharge to client). The capture modal would let staff pick, default to "quote_actual" when linked to a job that already has a delivery quote.

#### 2. Vehicle picker on the capture modal

When a cost is `cost_type='vehicle'`, we should know **which vehicle**. The DB already has `costs.vehicle_id` (FK to `fleet_vehicles`); the modal doesn't expose it yet. Small enhancement: a vehicle search picker mirroring the Job picker, debounced search via `/api/vehicles/fleet?search=…`. Pre-fills from `presetVehicleId` when entered from a Vehicle Detail page (entry point not yet built).

The reg comes along once `vehicle_id` is set — no additional storage.

#### 3. Xero reconciliation sync (`bill_created/attached` → `reconciled`)

Right now `xero_sync_state` reaches `attached` when we push + attach. Xero/Codat's bank-matching flips the bank-feed line to reconciled, but OP doesn't notice. A daily scheduler that polls `GET /BankTransactions?where=IsReconciled==true AND ModifiedDateUTC>=lastCheck` and updates matching OP costs would close the loop. Small piece — `services/cost-xero-reconcile-sync.ts` + a cron entry, no new schema.

#### 4. Entry points

The modal already accepts `presetJobId / presetVehicleId / presetIssueId`. Need the buttons on:
- **Job Detail → Money tab**: "+ Add cost" with the job preset (and the cost-intent default = `quote_actual`).
- **Vehicle Detail**: "+ Add cost" with the vehicle preset (default category `vehicle`).
- **Issue Detail (Problems register)**: "+ Add cost to this issue" with the issue preset (default category `parts` / `vehicle repairs`).

Each is a small mount, no new backend work.

#### 5. Deferred / nice-to-have

- ACCPAY bills (supplier bills) — needs `accounting.invoices` scope added to the Custom Connection. Defer until "not yet paid" volume warrants it.
- Edit-after-push mirroring to Xero (update existing transaction; void-and-recreate when reconciled).
- Bundled-invoice **allocation split** UI (the backend allocations endpoint exists, no UI yet — `PUT /api/costs/:id/allocations`).
- COT card register per staff (currently each user sets their own in Profile; admin-managed could replace).
- `/money/costs/reports` analytics dashboard (P&L by category, spend by job, etc.).

### Suggested order for the next chat

1. **Design Component 5 (quote-actual vs extra cost)** — biggest conceptual piece. Adds `cost_intent` column or similar, modal UX changes, and the variance display on the Job Detail Money tab.
2. **HH stock items + recharge push wiring** — once jon creates the small set of HH stock items and shares the IDs, the push code is a small service + mapping in `system_settings`. Failed-on-closed-job handling is part of this.
3. **Vehicle picker on modal** — quick win.
4. **Xero reconciliation sync** — quick win.
5. **Entry points on Job / Vehicle / Issue Detail pages**.

### How to pick this up

Read this spec (`docs/COST-CAPTURE-RECHARGE-SPEC.md`) — it has running build notes for every round of work to date. The key implementation files:

- `backend/src/routes/costs.ts` — all the cost API endpoints
- `backend/src/services/cost-xero-push.ts` — push state machine
- `backend/src/services/cost-receipt-extract.ts` — AI extraction
- `backend/src/services/xero-broker.ts` — Xero API gateway
- `frontend/src/components/CostCaptureModal.tsx` — the capture/edit modal
- `frontend/src/pages/CostsPage.tsx` — the hub
- `frontend/src/components/XeroBankAccountsSection.tsx` — settings mapping

---

## Build notes — Phase A: real payment instruments + payables-as-bills (Jun 2026)

First chunk of the "finish Cost Capture" work. Resolves the "Other won't sync"
dead-end and turns "Not yet paid" into a proper Xero purchase-ledger flow.
Decisions taken with jon up front:

- **"Other" removed.** A Xero Spend Money must book against a real bank account;
  "Other" has none, so it could never reconcile and sat stuck on "Not synced".
  The "unsure / sort later" case is now handled properly by "Not yet paid"
  landing a bill in Xero. Migration 105 nulls existing `other` rows (rather than
  guessing a method) and tightens the CHECK constraint.
- **Real instruments added:** Amex card, Lloyds credit card, Wise transfer,
  Lloyds bank transfer (alongside COT card, petty cash, PayPal). Credit cards are
  just BANK-type accounts in Xero, so they push as Spend Money identically — the
  liability sits on the card account exactly like real life.
- **"Not yet paid" + "Reimburse me" are now pay-later BILLS.** They land as an
  **AUTHORISED ACCPAY bill** in Xero on OP **approval** (so they show in Xero's
  "Bills to pay"). When marked paid (date — may be future — + method), a
  **Payment is recorded against the bill** on the bank account mapped to that pay
  method. This is the correct accounting treatment, not a workaround: Spend Money
  = paid now; Bill + Payment = pay later.
- **"Reimburse me" bills are raised against the STAFF MEMBER**, not the receipt
  vendor (the vendor's already been paid by the staff member — the company owes
  the staff member). The vendor is noted on the bill line and the receipt
  attached as evidence. Bill contact defaults to the uploader's name.

### Two-camp model

| Camp | Methods | Xero object | Bank account |
|---|---|---|---|
| Paid-now | cot_card, amex, lloyds_cc, petty_cash, paypal, wise, lloyds_transfer | Spend Money (on save, once paid) | `xero_bank_<method>` mapping |
| Pay-later | not_yet_paid, reimburse_me | Authorised ACCPAY bill (on approval) → Payment (on mark-paid) | bill needs none; payment uses `xero_bank_<paid_method>` mapping |

### Lifecycle (pay-later)

```
capture (awaiting_payment, approval_state=verified)   → nothing in Xero yet
  → admin approve                                       → AUTHORISED bill + receipt in Xero (xero_sync_state=attached)
  → admin Mark paid (date + method)                     → Payment recorded against the bill (xero_payment_id set)
  → (later) Codat bank line matches                      → reconciled (future sync)
```

The push service (`cost-xero-push.ts`) is idempotent and resumable — "Push now"
does the right next step at any stage. `recordBillPayment` guards on
`xero_payment_id` so a re-run never double-pays.

### ⚠️ Gated on a Xero scope (one-line flip)

ACCPAY bills + payments need the **`accounting.transactions`** scope on the Xero
Custom Connection (currently NOT granted). Until then, the bill push soft-skips
with a calm "needs accounting.transactions scope" advisory (grey "Not synced"
pill, not a red error) — everything else (Spend Money, reads) keeps working.

**To enable bills:**
1. Tick `accounting.transactions` on the Ooosh Custom Connection in the Xero
   developer portal + reconnect.
2. Uncomment the `accounting.transactions` line in `DEFAULT_SCOPES`
   (`backend/src/config/xero.ts`) + redeploy. (Order matters — requesting an
   ungranted scope fails the whole client_credentials token mint and breaks the
   working reads.)
3. Existing approved bills: hit **Push now** in `/money/costs` to create them.

### What shipped

- Migration 105: retire `other` (null existing + tighten constraint), add the 4
  new instruments to the bank-account mapping, drop `xero_bank_other` +
  `xero_bank_reimburse_me` (reimburse is a bill now), add `paid_value_date` +
  `xero_payment_id` columns.
- Backend: payment-method enum updated; `BILL_METHODS` split; `/approve` fires
  the bill creation; `/pay` captures the value date + method and fires the
  payment-against-bill push; `cost-xero-push.ts` rewritten to two flows;
  `xero-broker.payInvoice()` added.
- Frontend: modal payment-method picker grouped into Paid already / Pay later;
  Settings → Xero Bank Accounts lists the new instruments; CostsPage Xero badges
  are bill-aware (In Xero / Bill paid); a "Mark bill paid" modal captures date +
  method.

### Still to do (next chunks)

- Component 5 — `cost_intent` (quote-actual vs extra) before any HH recharge push.
- HH recharge stock items + push (needs the HH stock IDs).
- Vehicle picker on the modal; Xero reconciliation sync; entry points on
  Job/Vehicle/Issue detail pages.

---

## Build notes — Phase B: cost_intent (quote-actual vs extra) (Jun 2026)

The conceptual piece flagged in the Phase 1 handoff. A job often already carries
a quote (e.g. a £300 D&C delivery). The freelancer's fee + train + fuel logged
against it are **actuals consumed by that quote**, not new charges — recharging
them would double-bill. `cost_intent` distinguishes the two. This is the gate
that makes the Phase C HireHop recharge push safe.

Decisions taken with jon: **job-level total** variance (not per-quote), and
**default to "part of the quote"** when the linked job has a quote.

### Model
- `cost_intent` (migration 112): `quote_actual` | `extra`, NULL on overhead /
  vehicle costs with no job. Existing rows stay NULL (the recharge guard only
  blocks `quote_actual`, so NULL behaves exactly as before).
- **quote_actual** — part of fulfilling a quote. Tracked for variance, **never
  recharged** (already billed via the quote). Backend hard-guards: the recharge
  endpoint 400s on a `quote_actual` cost, and create/update coerce
  recharge_mode->'none' (defence-in-depth behind the modal disabling the control).
- **extra** — incurred for the job but not covered by a quote. Recharge controls
  stay available; Phase C's HH push will filter to `extra` only.

### Capture modal
- When a job is linked, an intent toggle appears ("Part of the quote" / "Extra").
  Default: the modal fetches the job's quotes once on link — `quote_actual` if it
  has any, else `extra`. Skips once the user touches the toggle, and in edit mode
  (seeded from the cost, inferring for legacy rows: recharge-flagged -> extra).
- "Part of the quote" hides the recharge controls + shows a one-line note.

### Money tab — "Job Costs" panel
- **Expected (from quotes)** = sum of quote freelancer fees (the crew/transport
  cost baseline). **Actuals (part of quote)** = sum of quote_actual cost gross.
  **Variance** = actuals - expected (red over / green under). Client-quoted total
  shown as a muted reference line.
- **Extra costs** listed separately with their recharge status.
- Legacy unclassified (NULL-intent) costs surfaced in a footnote so nothing's
  hidden from the totals.
- Reads `/costs/by-job/:jobId` + `/quotes?job_id=` - best-effort, non-blocking;
  hidden when the job has neither costs nor quotes.

### Still to do
- Phase C - HH recharge stock items + push (filters to `extra`; needs the HH
  stock IDs). Vehicle picker on the modal; Xero reconciliation sync; entry points
  on Job / Vehicle / Issue detail pages.

---

## Build notes — capture modal round 2 (Jun 2026)

Live-testing feedback after the bill flow went end-to-end. Modal correctness +
UX, plus the Xero tax-treatment that makes No-VAT actually mean No-VAT.

**VAT controls — 20% / No VAT / Manual.** Replaced the single "Auto 20%"
checkbox with a 3-way segmented control. The document is authoritative: AI
extraction returns `vat_treatment` (`standard` | `no_vat`) and drives the mode —
**no VAT is assumed unless it's shown** (the original bug — freelance invoices
were being force-split at 20%). No VAT → gross = net, vat = 0. Manual → edit all
three. Default (before AI / on manual category pick) is category-driven:
freelance crew invoices → No VAT, everything else → 20%.

**Correct Xero tax treatment on push.** Both Spend Money and bill line items now
set an explicit `TaxType`: a No-VAT cost pushes as `NONE` (so it no longer
inherits the account's 20% default and over-reclaims), a VAT cost resolves the
org's purchase tax type for the implied rate via `xeroBroker.getPurchaseTaxType()`
(cached; falls back to the account default if unresolved). The implied rate is
derived from vat/net so 5%/other rates resolve too.

**Freelance → pay-later default.** Selecting "Freelance crew invoices" defaults
the payment method to "Supplier bill (pay later)" (and No VAT) — until the user
overrides. Applies via AI category detection too.

**Job-number suggestion chip.** AI extraction returns a `job_number` if the
invoice clearly references one (e.g. "Attention: Ooosh Tours (#15291)"). Shown as
a tap-to-link suggestion — never auto-linked; clicking resolves it to a real job
via search and links it (or says it couldn't find it).

**In-modal quote comparison.** When a job is linked, a compact "This job so far"
box shows client-quoted total, our cost estimate (Σ quote freelancer fees) and
costs logged so far (quote-actuals + extras), so staff can judge Part-of-quote vs
Extra at capture time. Reuses `/quotes?job_id` + `/costs/by-job`.

**Polish.** AI Extract button enlarged + relabelled "Auto-fill from receipt (AI)"
with a helper line. Left receipt pane restructured to a single scroll (fixed
header + flex-fill preview; the PDF/image scrolls inside that area) — kills the
double scrollbar.

No migration. Backend: `cost-receipt-extract.ts` (schema + prompt),
`xero-broker.ts` (tax-type resolver), `cost-xero-push.ts` (TaxType on lines).

---

## Build notes — Approve-on-upload + entry points (Jun 2026)

**Approve & save (one-click).** The capture modal shows a green "Approve & save"
button alongside "Save cost" for a payable (pay-later method) when the user is
admin/manager — creates the cost AND advances it straight to `approved` (which
fires the bill push for pay-later methods), skipping the separate approve step.
"Save cost" still logs-without-approving for "not ready to approve yet".
`POST /api/costs` accepts an `approve: true` control flag, honoured only for an
approver + a payable. **`/approve` widened from admin-only to admin+manager**
(per jon: a manager uploading an invoice should be able to approve it). **Mark
paid stays admin-only** (money actually leaving + the Xero payment).

**Entry points.** "+ Add cost" now mounts the capture modal from two more
surfaces beyond the Costs hub:
- **Job Detail → Money tab** → "Job Costs" panel (preset job; panel now always
  renders with the button even when empty).
- **Issue Detail (Problems)** → header button (preset issue + vehicle + job, so
  the category/links default sensibly for a repair cost).
The Vehicle entry point already exists via the Service History tab.

No migration.

---

## Build notes — HireHop recharge push (Jun 2026)

The last piece of the original "capture → recharge" promise: an `extra` cost
flagged for recharge can now be pushed to its HireHop job as a billable hire
line, from the **Recharges** view ("Push to HireHop" button). Explicit staff
action — never auto-fires. Idempotent (a cost already recharged is a no-op,
guarded by `recharged_to_hh_at`).

**Mechanism** (`services/cost-recharge-hh.ts`) — mirrors the proven quotes→HH
pattern, adapted for HIRE items: `save_job.php` adds the line (`b<stockId>`,
qty 1), then `items_save.php` (kind 2) sets a custom **unit price = the NET
amount** with the stock's own nominal. The recharge stock items are 20%-rated,
so HireHop adds the VAT on top — matching the "net of VAT, VAT added at HH"
design. Full recharge → the cost's `amount_net`; partial → the entered
`recharge_amount`. `vat_rate:0` in items_save means "derive from the stock's tax
rules" (same as the quotes push), so lines bill at 20%.

**Category → HH stock map** (jon's stock IDs, all hire items @ 20%):

| OP category (Xero code) | HH stock | ID | nominal |
|---|---|---|---|
| Fuel (410) | Fuel recharge | 1325 | 31 |
| Parking (411) / Travel (325) | Travel cost | 1772 | 29 |
| Parking fines / PCNs (399) | PCN / fine handling | 1744 | 22 |
| Vehicle repairs (409) | Vehicle damage cost | 1741 | 3 |
| Everything else | Cost / fee / recharge (catch-all) | 1796 | 22 |

Hardcoded in the service (stable; move to system_settings + a Settings UI if
they ever churn).

**Closed-job handling.** `job_data.php` checked first; a locked job or HH status
in {7,9,10,11} returns `manualActionRequired` with a message — the cost is left
un-recharged so it stays in the Recharges view as a known-unresolved item. HH
errors are surfaced (the broker's nested-error extraction names validation
issues).

**On success:** stamps `recharged_to_hh_at` + `recharge_hh_item_id`, posts an HH
job note, and the cost drops out of the Recharges-pending list.

**Endpoint:** `POST /api/costs/:id/push-recharge` (STAFF_ROLES). The legacy
`/recharge` stays the flag-setter (sets mode/amount); the push is the separate
explicit action.

⚠️ **Needs one live-test pass** (like the bill flow): the hire-item add +
price-edit is modelled on the working labour-item path but virtual hire items
may have HH-specific nuances. Push a real `extra` cost to a scratch job and
confirm the line + price + 20% VAT land correctly; the surfaced HH errors will
name anything off.

---

## Build notes — Bundled-invoice allocation split UI (Jun 2026)

Wires a UI to the long-existing `PUT /api/costs/:id/allocations` backend. One
cost (e.g. a freelancer's bundled invoice covering several jobs) splits across
those jobs — a `cost_allocations` row per line.

- **`CostAllocationModal.tsx`** — add jobs (search picker), enter an amount per
  line, optional per-line `recharge` flag. Each line shows that job's expected
  crew/transport cost (sum of its quote freelancer fees) inline as a sanity
  check. A running reconciliation bar enforces "allocated total = cost gross"
  (±1p) before Save is enabled; saving with no lines clears the split.
- **CostsPage** — a `⑂` "Split across jobs" row action opens it; the icon shows
  the allocation count + turns purple when a cost is already split. The list
  query now returns `allocation_count`.
- **Backend** — `allocationSchema` now allows an empty array (to clear a split);
  the `PUT` was already a transactional delete-all + re-insert.

No migration (`cost_allocations` shipped in 092). Allocation is metadata for
per-job cost attribution/reporting — it does not change the cost's own `job_id`
or its Xero push.

---

## Build notes — Edit-after-push: warn + manual re-sync (Jun 2026)

Closed the gap where editing a cost that's **already in Xero** (fixing the
account code/amount/supplier after a bill or spend-money was created) left Xero
stale — the PATCH only ever re-pushed costs that weren't yet in Xero.

- **Migration 147** — `costs.xero_stale BOOLEAN`. Set by the PATCH handler when
  an already-pushed cost (`xero_object_id` + `bill_created`/`attached`/`reconciled`)
  is edited with a **Xero-affecting field** (amount net/vat/gross, account code,
  supplier, description, vat_treatment, cost_date, payment_method, invoice_number).
  Non-Xero edits (notes, payment_status) don't flag it. We deliberately do NOT
  auto-re-push — a reconciled object mustn't be silently mutated.
- **`XeroCell`** shows an amber **"Xero out of date · Re-sync"** pill (takes
  precedence over the synced pills).
- **`POST /api/costs/:id/resync-xero`** → `resyncCostToXero()` updates the
  existing Xero object IN PLACE (`updateBill` / `updateSpendMoney` — POST with the
  object ID, never a fresh create, so it can't duplicate). Shares the per-cost
  advisory lock. **Hard refusals (409):** a PAID bill (amounts locked once a
  payment exists) and a RECONCILED spend-money — Xero won't allow the edit. The
  frontend then offers a **dismiss** (`{ dismiss: true }` → clears `xero_stale`
  without touching Xero) for "I've fixed it directly in Xero".
- **Broker:** added `updateBill` / `updateSpendMoney` (POST-with-ID) to
  `xero-broker.ts`.

> ⚠️ The in-place update path (POST-with-ID for Invoices / BankTransactions)
> follows Xero's documented semantics but wasn't live-verified at build time —
> confirm one real re-sync of each kind (an unpaid AUTHORISED bill and an
> unreconciled spend-money) before relying on it. Worst case is a clean error +
> the stale flag staying put, never a duplicate or a corrupted object.

---

## Build notes — COT receipt chaser + admin card register (Jun 2026)

Third of the three nice-to-haves. Migration **148**.

### Receipt chaser (OP-side)
Company-card (COT) purchases are already in Xero via the bank feed — the one
thing OP needs is the receipt. `services/cost-receipt-chaser.ts` runs **weekly,
Wednesday 12:00 Europe/London**, and sends ONE digest per card-holder
summarising their own cot_card costs (older than a 3-day grace) still missing a
receipt, deep-linked to `/money/costs?missing_receipt=1&mine=1`. The weekly
cadence is the throttle — no per-cost dedup; `costs.receipt_chase_sent_at` is
stamped only as a "last chased" record. It looks at ALL outstanding costs (it
backfills), but as a single weekly digest a bigger backlog just means a higher
count, never more emails. A cost drops out the moment `receipt_r2_key` is set.
The cost list gained
`?missing_receipt=1` (+ `&mine=1`) filters and a clearable banner. A fleet-wide
**"COT Receipts"** amber NeedsAttention bucket surfaces the backlog
(`cot_receipts_outstanding_count` on `/api/dashboard/operations`).

> OP-side only — chases what staff logged in OP. Purchases never logged at all
> are the job of the future Xero-matched reconciliation (Component 4c).

### Admin card register
`users.cot_card_label` added alongside the existing `cot_card_last4`. **Admin**
manages both from **Settings → COT Card Register** (`GET /api/users/cot-cards`,
`PATCH /api/users/:id/cot-card`, admin-only). The capture flow already stamps the
holder + last 4 server-side from the user's record, so **staff never type card
details** — the register is purely admin-set. The capture hint now points staff
at an admin rather than their own Profile.

---

## Build notes — feedback round 2 (Jun 2026)

Batch of fixes/improvements off the first live week of the cost hub. No migration.

### Supplier terms pull-through fix (the real bug)
Xero supplier terms never applied because **`costs.xero_contact_id` was never
populated** — `createBill` took a contact *name* and the returned bill never wrote
the Xero ContactID back, so `seedTermsFromXeroIfMissing` had nothing to work with
and terms always fell back to invoice+30. Fix in `pushBill`: resolve/create the
Xero contact FIRST, persist its id onto the cost, seed terms from it, THEN compute
the due date and create the bill against the contact id (`createBill` gained an
optional `contactId`). Skipped for `reimburse_me` (the "contact" there is the
staff member). Establishes the link on first push, so terms pull through on this
and every future bill for the supplier.

### Freelancer Friday terms (Xero can't model this)
Ooosh pays freelancers "the first Friday one week after approval". New
`freelancerDueDate(approvedAt)` = first Friday on/after (approval + 7 days). Used
for any `cost_type='freelancer_invoice'` bill, overriding supplier/Xero terms — in
the costs list display (once approved), the Xero bill push, and the re-sync path.
Lands payment 7–13 days out, matching the published terms. (The 30-day "overdue"
threshold in the T&Cs is a dispute nuance, not modelled — "overdue" in the UI is
simply past the Friday due date.)

### Capture-time split
The "split across jobs" allocation modal now surfaces at capture: a **"Split
across multiple jobs"** tick in the capture modal footer (new-cost only) hands the
saved cost straight to the allocation modal via a new `onSavedAndSplit` callback.

### Bills to Pay — sortable Due + filters
The Due column is now click-to-sort, and the payable view gained due-date filter
pills: **Overdue / This Friday / This week / Next 7 days** (client-side over the
server-computed `due_date`; undated bills sort last ascending).

### UI fix
The Xero-status cell got `whitespace-nowrap` so the "In Xero" pill no longer wraps
to two lines now the split button shares the row.
