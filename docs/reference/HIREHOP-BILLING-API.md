# HireHop billing API — invoices, payments, allocations, Xero

**What this is.** Everything OP has learned — by capturing HireHop's own UI in the
browser Network tab — about creating invoices, approving them, recording payments,
allocating payments to invoices, refunding, and how each of those reaches Xero.

**Who needs it.** The shop's weekly close (`docs/SHOP-SALES-SPEC.md` §20) is the first
user of invoice creation and allocation. The planned **bookkeeping module** (auto-
reconciling invoices with their payments across all jobs, jon, late 2026) builds on
exactly these calls. Read this before writing ANY new billing write.

**Status legend:** ✅ used in production code · 🟢 captured from the HireHop UI, not yet
in code · ❓ not yet known.

---

## 0. Three rules that have each cost a live round

1. **Capture before you write.** Do the action in HireHop's UI with the Network tab
   open and copy the **Payload** (and, for anything that creates a row, the
   **Response** — it carries the new id). HireHop's API docs have been wrong for four
   endpoints so far (`SHOP-SALES-SPEC.md` §2.9).
2. **`success: true` does not mean HireHop did it.** It has returned success for a
   no-op twice (a `delete:` key on `save_job.php`; a negative payment application
   silently clamped to £0). **Verify every write by re-reading `billing_list.php`.**
3. **A save does not reach Xero by itself.** Every billing save that should appear in
   Xero needs a follow-up `accounting/tasks.php` call. Use
   `services/hh-xero-sync.ts` `syncSavedRowToXero(label, saveResponse)` — it reads the
   task name and ids from the save's own response. A missing sync call is how job
   15187's refund reached HireHop, missed Xero, and told nobody for three months.

---

## 1. Reading a job's billing — `billing_list.php` ✅

```
GET /php_functions/billing_list.php?main_id=<HH job>&type=1
```
Always read fresh (`cacheTTL: 0, skipCache: true`) — a stale read here is a wrong
refund. `services/hh-deposit-release.ts readBillingRows()` is the reader.

Row `kind`s:

| kind | What | Notes |
|---|---|---|
| **0** | Job total | `accrued` = the job's **ex-VAT** net total (`job-value-sync.ts`, the shop balance check) |
| **1** | Invoice (and credit note) | `status` 0 draft · 2 approved. `debit` = gross, `owing` = still to pay. `data.NET`, `data.TAX`, `data.items[]` (each with its own `VAT`) |
| **3** | Payment application | Published TWICE: a deposit-side row (`parent_is: 'deposit'`, `credit < 0`) and an invoice-side row (`parent_is: 'invoice'`, `credit > 0`), sharing `data.ID`. `data.OWNER` = invoice id (**0 = a refund out to the client**), `data.OWNER_DEPOSIT` = deposit id |
| **6** | Deposit (a payment received) | `credit` = amount; refunds can appear as negative. Unallocated balance = `-owing` (or `credit - paid`) — `readDepositAvailability()` takes the smaller |

A deposit exported to Xero carries `data.ACC_DATA.OverpaymentID`: **in Xero a HireHop
deposit is an Overpayment**, and allocating it to an invoice applies that overpayment.

---

## 2. Recording a payment (deposit) — `billing_deposit_save.php` ✅

`services/hh-deposit.ts pushDepositToHH()`. Key fields: `ID: 0` (create), `DATE`,
`DESCRIPTION`, `AMOUNT` (gross, positive), `MEMO`, `ACC_ACCOUNT_ID` (bank — see
`HH_BANK_IDS`), `ACC_PACKAGE_ID: 3` (Xero), `JOB_ID`, `CLIENT_ID`, currency block,
`local`, `tz`, `no_webhook: 1`. Then `syncSavedRowToXero` (task `post_deposit`).

Bank ids: 165 Amex · 168 Till (Cash) · 169 Worldpay · 170 Lloyds · 173 PayPal ·
265 Wise (BACS) · 267 Stripe GBP.

**HireHop rejects negative deposits.** Money back is a refund application (§5).

---

## 3. Creating an invoice (draft) — `billing_save.php` 🟢 (in code: `services/shop-close.ts`, not yet run live)

Captured on scratch job 16757, 25 Sep 2026 (New → Invoice):

```
POST /php_functions/billing_save.php
  id            = 0                 ← create
  desc          = (empty)
  ref           = (empty)
  memo          = (empty)
  bank          = 169               ← the invoice's default bank (Worldpay)
  tax_total     = 0.00
  tax_rate      = 0
  all           = 1                 ← "Include all owing items" — ALWAYS send 1
  novat         = 0
  aggregated    = 0
  local         = 2026-09-25 10:51:25   ← Europe/London wall clock
  tz            = Europe/London
  currency[CODE]=GBP, currency[NAME]=United Kingdom Pound, currency[SYMBOL]=£,
  currency[DECIMALS]=2, currency[MULTIPLIER]=1, currency[NEGATIVE_FORMAT]=1,
  currency[SYMBOL_POSITION]=0, currency[DECIMAL_SEPARATOR]=., currency[THOUSAND_SEPARATOR]=,
  upto          = (empty)           ← ❓ probably "invoice items up to this date" (DATE_UPTO)
  job           = 16757
```

⚠️ **`all` defaults to ticked in the UI, but that default is a HireHop user setting**
(jon). Never rely on it — always send `all: 1`.

**Response:** `rows[0]` is the new invoice as a `kind: 1` row — `data.ID` (e.g. 12841,
the id every later call uses), `NUMBER: ""` (drafts have no number), `STATUS: 0`,
`NET`, `TAX`, `owing` (= gross), `TAX_POINT` (= now), and `items[]` with per-line
`PRICE`, `VAT_RATE`, `VAT`, `ACC_NOMINAL_ID`. **No `hh_task`** — a draft does not go
to Xero, correctly.

❓ **VAT rounding with several odd-pence lines is not yet verified.** The one capture
had a single line (840 + 168). Per-line `VAT` on items suggests HireHop sums per-line
VAT, which would match OP's till (VAT rounded per line) — but check on real data: the
shop close compares the invoice total to OP's own total to the penny before approving.

---

## 4. Approving an invoice — `billing_save_status.php` 🟢 (in code: `services/shop-close.ts`, not yet run live)

Captured 25 Sep 2026 (right-click → Approved):

```
POST /php_functions/billing_save_status.php
  id     = 12841                  ← the invoice id from §3
  status = 2                      ← 2 = approved (0 = draft)
  date   = 2026-09-25 10:53:23    ← becomes the invoice date / TAX_POINT (time is dropped: 00:00:00)
  type   = 1                      ← 1 = invoice
  local  = 2026-09-25 10:53:23
```

**Response:** the invoice row now has `NUMBER: "OT-INV-12245"`, `STATUS: 2`,
`DUE_DATE`, `AUTH_USER`, and at the top level:

```
"sync_accounts": true, "hh_task": "post_invoice_credit", "hh_id": 12841,
"hh_acc_package_id": 3, "hh_package_type": 1
```

Then the UI calls `accounting/tasks.php` with exactly those
(`hh_package_type=1, hh_acc_package_id=3, hh_task=post_invoice_credit, hh_id=12841,
hh_acc_id=`) → `{"package_updated": true}`. After that the invoice carries
`ACC_ID` (the Xero invoice GUID) and `exported: 1`.

→ `syncSavedRowToXero(label, approveResponse)` does this unchanged. Note **HireHop
uses `post_invoice_credit` for invoices AND credit notes** (`MONEY-AND-EXCESS.md`).

**Approval is the Xero commit point.** Drafts stay in HireHop only.

---

## 5. Allocating a payment to an invoice — `billing_payments_save.php` 🟢 (create) / ✅ (edit)

Captured 25 Sep 2026 (right-click the deposit → allocate to invoice → Save):

```
POST /php_functions/billing_payments_save.php
  id      = 0                 ← create a new application
  date    = 2026-09-25
  desc    = (empty)
  paid    = 1.5               ← how much of the deposit goes to the invoice
  memo    = (empty)
  bank    = 168               ← the DEPOSIT's bank (Till), not the invoice's
  OWNER   = 12841             ← the INVOICE id
  deposit = 9336              ← the DEPOSIT id
```

(The UI sent no `no_webhook` / `correction`; OP's existing edit call adds
`correction: 0, no_webhook: 1` and works — keep `no_webhook: 1` so OP's own write
doesn't echo back through the webhook.)

**Response:** the refreshed rows — the deposit (`owing: 0`, `paid: 1.5`), the new
application twice (`d12598_dep` / `d12598_inv`, `data.OWNER: 12841`,
`data.OWNER_DEPOSIT: 9336`, `data.INVOICE_NUMBER`), the invoice with `owing` reduced
(1008 → 1006.5), and top-level `hh_task: "post_payment", hh_id: 12598` (the
APPLICATION id) → `accounting/tasks.php` → Xero applies the overpayment to the invoice.

The same endpoint, variants:

| `OWNER` | `id` | Meaning | Where in code |
|---|---|---|---|
| invoice id | 0 | **allocate** a deposit to an invoice | 🟢 `shop-close.ts` (built, not yet run live) |
| invoice id | existing app id | **change** an allocation's amount | ✅ `hh-deposit-release.ts setApplicationAmount()` |
| **0** | 0 | **refund** out of a deposit to the client | ✅ `hh-deposit.ts refundDepositOnHH()` |

Traps already paid for:
- **A negative `paid` does nothing** — success, a real row, clamped to £0. Editing the
  existing application down is the only way to release money from an invoice.
- **Error 370** = refunding a deposit that is fully allocated to an invoice. Release
  it off the invoice first (`hh-deposit-release.ts releaseFromInvoice()`).
- **Xero 2263** ("Authorised documents…") = the Xero overpayment is fully allocated
  and Xero refuses further payments against it — the credit-note shape
  (`MONEY-AND-EXCESS.md`).

---

## 6. Job status — ✅

`POST /frames/status_save.php { job, status, no_webhook: 1 }`, then re-read
`/api/job_data.php` and check `STATUS` — exactly as `services/shop-period.ts` sets a new
weekly job to Dispatched (5). Shop jobs are never in OP's `jobs` table, so the week close
sets the status directly this way. **Completed
(11) keeps sale stock consumed; anything below Dispatched (5), Cancelled (9) or Not
Interested (10) releases it** (`SHOP-SALES-SPEC.md` §2.1).

---

## 7. Not yet captured ❓

- Creating a **credit note** (approving one is documented in `MONEY-AND-EXCESS.md`).
- What `upto`, `aggregated`, `novat` do on invoice create.
- Voiding / deleting an approved invoice (and what it does in Xero).
- VAT rounding across several odd-pence lines (§3).
