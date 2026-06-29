# Costs — Payment Automation Spec

Status: **DRAFT / PLANNING** (Jun 2026). Captures two related-but-separable pieces
of work on the `/money/costs` "Bills to Pay" workflow:

1. **Supplier payment terms & due dates** — small, near-term. Make the bill due
   date real (per-supplier terms, EOM-aware) instead of a flat invoice + 30.
2. **Wise payment integration** — large project. Pay supplier bills (and later
   collect/track incoming money + excess) directly from OP via the Wise Business
   API, with batch payments.

This doc is the system of record for both. The first small UI win (Due column +
date trim) shipped alongside this doc; the terms layer and Wise are the
follow-ups below.

---

## Part 1 — Supplier payment terms & due dates

### What shipped first (the "small win")

- `/money/costs` Bills-to-Pay table: invoice date trimmed to `DD/MM` (full date
  on hover), new **Due** column with a countdown chip (`in 5d` grey, `due in 2d`
  / `due today` amber-red, `Nd overdue` red).
- Due date is currently a **flat invoice + `DEFAULT_TERMS_DAYS` (30)** — same
  assumption already used by the mark-paid modal and `addDaysISO` in
  `services/cost-xero-push.ts`. `DEFAULT_TERMS_DAYS` in `CostsPage.tsx` is the
  single hook the terms layer below replaces.
- Invoice number was already surfaced (grey `#…` under the supplier name) and
  already shown in the mark-paid modal — no change needed.

### The terms layer — SHIPPED (Jun 2026)

Built per the design below. Migration **139** (`costs.xero_contact_id` +
`supplier_payment_terms`). Shared service `services/supplier-terms.ts` is the one
due-date calc, used by the costs list, the get-one endpoint, the mark-paid modal
(via the list payload) and the Xero bill push (`cost-xero-push.ts`) — they can't
drift. The capture modal now keeps the picked supplier's `ContactID`; a
fire-and-forget background seed pulls the contact's `PaymentTerms.Bills` from
Xero the first time a Xero-linked supplier is captured. Staff edit/override terms
per-supplier from the Due cell on Bills-to-Pay (`SupplierTermsModal`), endpoints
`GET`/`PUT /api/costs/suppliers/terms`. `DEFAULT_TERMS_DAYS = 30` remains the
fallback when nothing's stored.

**Deferred:** a one-shot backfill seeding terms from Xero for *existing*
suppliers (existing costs have no `xero_contact_id`, so there's nothing to seed
from yet — they pick up terms when next captured/edited, or staff set them
manually). Writing edited terms back to the Xero contact (`PUT /Contacts`) is
still OP-only by design.

### The terms layer (design)

**Goal:** due dates that reflect each supplier's real terms, including EOM
(e.g. the garage's "30 days EOM"), with a sensible default and an editable
override.

**Resolution precedence** (first hit wins):

```
per-cost override (rare)  →  supplier terms  →  default (invoice + 30 days)
```

**Term shape** — two knobs cover every case we have today:

| Field | Values |
|---|---|
| `basis` | `invoice_date` \| `end_of_invoice_month` |
| `days`  | integer N |

- Standard net-30 → `invoice_date` + 30
- Garage "30 days EOM" → `end_of_invoice_month` + 30 (June-dated invoice → 30 Jun
  → +30 → ~30 Jul). **Confirmed semantics with jon (Jun 2026).**
- "Pay by end of month" → `end_of_invoice_month` + 0

This maps 1:1 onto Xero's `PaymentTerms.Bills.Type`:
`DAYSAFTERBILLDATE` → `invoice_date`, `DAYSAFTERBILLMONTH` → `end_of_invoice_month`.
Xero's fixed "Nth of current/following month" variants (`OFCURRENTMONTH` /
`OFOLLOWINGMONTH`) are rarer — leave them out until a supplier actually needs one.

### Reading terms from Xero (we can, today)

The OP Xero connection is a Custom Connection (`client_credentials`) and
**already holds the `accounting.contacts` scope** (`config/xero.ts`) — no
reconsent needed. A Xero Contact GET returns `PaymentTerms.Bills.{Day,Type}`.
So if a supplier's bill terms are set in Xero, we can seed correct, EOM-aware
terms for free.

**The blocker to fix first — capture the Xero contact id on the cost.** Today the
Capture modal autocomplete fetches Xero contacts (`/costs/xero/suppliers` →
`xeroBroker.searchContacts`) but the click handler discards `s.ContactID` and
keeps only the name (`CostCaptureModal.tsx:766`). The cost is then resolved to a
Xero contact by **exact-name match** at push time. There is no `xero_contact_id`
column on `costs`.

Fix (small): add `costs.xero_contact_id` (migration), store `s.ContactID` when a
real Xero suggestion is picked, send it in the create/update payload. Then terms
reading is a direct Contact lookup rather than name-match guesswork.

### Build outline (terms layer)

1. **Migration:** `costs.xero_contact_id TEXT` (nullable). Optional
   `supplier_payment_terms` table keyed by `xero_contact_id` (preferred) or
   `LOWER(supplier_name)` (mirrors the existing invoice-dedup index pattern),
   columns `basis`, `days`, `source` (`xero` | `manual`), `updated_by`,
   `updated_at`.
2. **Capture modal:** keep `ContactID` from the picked suggestion; send it.
3. **Terms resolver (backend):** `resolveSupplierTerms(cost)` →
   `{ basis, days, source }`. Order: stored manual terms → Xero contact
   `PaymentTerms.Bills` (cached, via `xeroBroker`) → default. Seed a
   `supplier_payment_terms` row from Xero the first time we read one.
4. **Due-date calc (shared):** one helper (`computeDueDate(invoiceDate, terms)`)
   used by the list, the PayModal, and the Xero push so all three agree. Replace
   the three current flat-30 calcs.
5. **Editable override UI:** small "terms" affordance on the cost row / supplier
   (default 30 / invoice-date, pre-filled from Xero when available). Per-supplier,
   so the garage is set once and applies to all its invoices.
6. **(Optional, later):** write edited terms back to the Xero contact
   (`PUT /Contacts`) so Xero's own due dates agree. v1 stays OP-only to limit
   blast radius.

### Caveats

- Not every supplier has terms in Xero — fall back to default (30), never error.
- Costs aren't linked to organisations; keep terms keyed by Xero contact id /
  supplier name, not `organisations.xero_contact_id`.

---

## Part 2 — Wise payment integration

### Status

**Nothing built.** `wise` exists only as a payment-method label that maps a
cost's Spend-Money/Bill to a Xero bank account (`xero_bank_wise`,
migration 105) — marking a "wise" bill paid records the accounting entry, **no
money moves.** Migration 094 has a forward-looking note ("future Wise recipient")
on the encrypted excess bank details, but no integration code exists.

### Vision & scope

In scope for this project: **pay supplier bills directly from the Bills-to-Pay
surface, including batch payments.** Out of scope but explicitly on the roadmap
(and the reason to build the foundation reusably):

- Tracking **incoming** client payments to Wise (currently a manual gap in the
  "payments from clients" process).
- **Receiving and reimbursing insurance excesses** via Wise (the encrypted excess
  bank-details fields already anticipate this).

**Therefore: build a reusable Wise broker/service** (same shape as the HireHop and
Xero brokers — auth, rate limit, retry, and the SCA request-signing in ONE place),
not a one-off "pay a bill" function. The future incoming/excess flows plug into
the same broker.

### Confirmed facts (jon, Jun 2026)

- Ooosh has a **Wise Business account**; believe API access is available
  (needs confirming + token minting).
- Generally **sufficient funds in the Wise balance**, or can top up as required.
- **Batch payments are essential** — the garage pays 30-days-EOM, so 20-30
  invoices land at once. Otherwise ≤ ~20 suppliers/week.

### The Wise payment flow (happy path)

1. **Recipient** — create/look up a Wise recipient account from the supplier's
   bank details (`POST /v1/accounts`). One recipient per supplier; cache the
   recipient id.
2. **Quote** — `POST /v3/profiles/{profile}/quotes` (sourceCurrency =
   targetCurrency = GBP for domestic).
3. **Transfer** — `POST /v1/transfers` (quote + recipient + reference =
   invoice number).
4. **Fund** — `POST /v3/profiles/{profile}/transfers/{id}/payments`
   `{ type: "BALANCE" }` (pays from the Wise balance).
5. **Track** — store the Wise `transferId` on the cost; reconcile state via the
   Wise webhook (`transfers#state-change`) → flip the cost to paid + record the
   value date.

**Batch:** Wise "batch groups" let several transfers be created then funded
together — maps cleanly onto ticking multiple bills in Bills-to-Pay and paying
the run in one action.

### The hard parts (spike these first, in Wise sandbox)

- **Strong Customer Authentication (SCA).** Sensitive calls (creating a transfer)
  can return `403` with `x-2fa-approval`; you must sign a one-time token with a
  registered private key (public key uploaded to Wise) and re-submit. This is the
  main complexity — it lives in the broker.
- **Funding source.** Confirm the GBP balance funding model + behaviour when the
  balance is short (top-up flow / clear error, never a half-paid batch).
- **Idempotency.** Real money out, automated, often batched. Use Wise's
  idempotency support + our own guard so a double-click / retry can NEVER
  double-pay. (We've already been bitten by double-push on the Xero side — take
  this seriously; per-cost advisory lock pattern from `cost-xero-push.ts` is the
  precedent.)
- **Supplier bank details.** We don't hold supplier account details today (only
  encrypted *client* excess details). Capture + encrypt (reuse
  `services/encryption.ts`) sort code/account (or IBAN), create the Wise
  recipient, store the recipient id.

### Build phases (proposed)

- **Phase 0 — sandbox spike.** Prove auth + SCA signing + create/fund a single
  transfer + webhook state in the Wise sandbox. De-risks the timeline before any
  product build. Output: a thin `services/wise-broker.ts` + a throwaway script.
- **Phase 1 — supplier recipients.** Capture + encrypt supplier bank details on
  the cost/supplier; create/cache Wise recipients; admin-only.
- **Phase 2 — pay a single bill from OP.** "Pay via Wise" on a Bills-to-Pay row →
  confirm → transfer → store id → webhook reconciles to paid + records the Xero
  payment leg (reuse existing `/pay` Xero machinery). Hard idempotency + audit.
- **Phase 3 — batch.** Tick N bills → fund as one batch group. The 30-EOM garage
  run is the headline use case.
- **Phase 4+ (separate projects).** Incoming client payment tracking; excess
  receive/reimburse via Wise.

### RBAC / safety

- Admin-only (real money out the door, automated). Explicit confirm step with the
  total + recipient list. Full audit (`audit_log`) on every transfer.
- Reconciliation: a cost is only "paid via Wise" once the webhook confirms the
  transfer state — never optimistically.

### Env vars (Phase 0+)

- `WISE_API_TOKEN` (or OAuth client) — confirm which Wise grants.
- `WISE_PROFILE_ID` — the business profile.
- `WISE_PRIVATE_KEY` — SCA signing key (the public half registered with Wise).
- `WISE_WEBHOOK_SECRET` — webhook signature verification.
- Sandbox vs live base URL switch.

(Add to `backend/.env.example` when Phase 0 lands; the actual values live only in
the server `.env`, never the repo — same as the Xero/Stripe keys.)
