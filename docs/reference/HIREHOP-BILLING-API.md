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

## 3. Creating an invoice (draft) — `billing_save.php` ✅ (`services/shop-close.ts`, live since 28 Sep 2026)

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

✅ **`all: 1` bills only the lines NOT YET invoiced** (proven 9 Oct 2026, scratch job
15745): three lines → draft 12927 held all three; a fourth line added, `all: 1` again →
draft 12928 held ONLY the fourth. So a second invoice for charges added after the main
invoice is just another `all: 1` call. HireHop tracks this per line as `invoiced_so_far`
(§10). **`all: 0` creates an EMPTY draft** (`debit: 0`, `items: []`) to which lines are
then assigned by hand — §10 is that path.

⚠️ **`all` defaults to ticked in the UI, but that default is a HireHop user setting**
(jon). Never rely on it — always send `all: 1`.

**Response:** `rows[0]` is the new invoice as a `kind: 1` row — `data.ID` (e.g. 12841,
the id every later call uses), `NUMBER: ""` (drafts have no number), `STATUS: 0`,
`NET`, `TAX`, `owing` (= gross), `TAX_POINT` (= now), and `items[]` with per-line
`PRICE`, `VAT_RATE`, `VAT`, `ACC_NOMINAL_ID`. **No `hh_task`** — a draft does not go
to Xero, correctly.

✅ **VAT is rounded PER LINE, same as OP's till** (verified live, 16762 and 16750:
net £19.14 → gross £22.96, where rounding the total would give £22.97). Only one VAT
rate has been seen on a shop invoice so far. `ref` → the Xero invoice's Reference
(the close sends `Shop sales dd/mm/yyyy - dd/mm/yyyy`; confirm on the next close).
Line descriptions in Xero are HireHop's: item name + the LINE's hire dates in
brackets — there is no setting to change it (jon looked, Sep 2026).

The original note: the one capture
had a single line (840 + 168). Per-line `VAT` on items suggests HireHop sums per-line
VAT, which would match OP's till (VAT rounded per line) — but check on real data: the
shop close compares the invoice total to OP's own total to the penny before approving.

---

## 4. Approving an invoice — `billing_save_status.php` ✅ (`services/shop-close.ts`, live since 28 Sep 2026)

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

## 5. Allocating a payment to an invoice — `billing_payments_save.php` ✅ (create and edit)

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

🔴 **HireHop NEVER pushes an allocation to Xero** (jon, 28 Sep 2026: "it never has —
we've always applied the credit in Xero by hand"; re-proven on the real week 16750).
Deposits reach Xero as overpayments at creation and then stay orphaned. So OP applies
the credit in Xero ITSELF: `xero-broker.ts allocateOverpayment()` →
`PUT /Overpayments/{ACC_DATA.OverpaymentID}/Allocations` against the invoice's
`ACC_ID`, and reads back Xero's `AmountDue` (`shop-close.ts applyCreditsInXero`).
This is the piece the bookkeeping module will reuse for every job.

The first live use, for the record (scratch job 16762, 25 Sep 2026): Save and `tasks.php` both succeeded (`package_updated: true`), yet the
application rows kept `ACC_ID: ""`, `ACC_EXPORTED: ""`, `ACC_CHANGED: 1`, and Xero
left the invoice at *Awaiting payment* with both overpayments unapplied. **HireHop's own
UI did exactly the same** (re-saving the application from the UI: same payload shape —
`id, date, desc, paid, memo, bank, correction: 0, CUSTOM_FIELDS, bill` — same result),
so it is HireHop↔Xero, not OP. Suspect: that invoice was dated 11 Jan 2026 (a fake
past week) and the overpayments 25 Sep — Xero refuses an allocation dated before the
overpayment if HireHop dates it by the invoice. Unconfirmed. **The invoice-side
application row's `ACC_ID` is the read-back** — `shop-close.ts` now checks it,
retries the push once, and otherwise stops without completing the job.

The same endpoint, variants:

| `OWNER` | `id` | Meaning | Where in code |
|---|---|---|---|
| invoice id | 0 | **allocate** a deposit to an invoice | ✅ `shop-close.ts` |
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
- What `upto`, `aggregated`, `novat` do on invoice create (`all` is now known — §3, §10).
- Whether `billing_save_items.php` (§10) accepts the SAME job line twice with different
  prices and VAT codes (the EU split, `HIRE-CLOSE-OUT-SPEC.md` §10.1), and what
  `invoiced_so_far` then reads.
- Deleting a payment application (jon deleted 16015's stray refund by hand on 9 Oct
  without the network tab open — next time).
- Voiding / deleting an approved invoice (and what it does in Xero).
- VAT rounding across several odd-pence lines (§3).

---

## 8. THE RECIPE — settling an invoice end to end (proven live 28 Sep 2026)

**This is the base of the bookkeeping module.** It is what the shop's weekly close
does (`services/shop-close.ts`), and it is the first time OP has taken a HireHop job
all the way from "payments sitting on it" to "invoice paid in HireHop AND Xero, job
Completed". First real run: week 21–27 Sep 2026, job 16750, OT-INV-12253, £47.50.

### Who holds what

| Thing | HireHop | Xero | How OP finds the Xero side |
|---|---|---|---|
| A payment received | deposit (billing `kind = 6`) | an **Overpayment**, created when HireHop saves the deposit | deposit row `data.ACC_DATA.OverpaymentID` |
| An invoice | `kind = 1`, `STATUS` 0 draft · 2 approved · **3 paid** | an ACCREC invoice, created when HireHop approves it | invoice row `data.ACC_ID` |
| A payment applied to an invoice | `kind = 3` application (published twice — deposit side and invoice side) | an **Allocation** of the overpayment to the invoice | — **HireHop never creates this. OP does.** |

### The steps

1. **Pre-flight** — nothing half-done in OP, the job's lines and money match OP's
   own record, no invoice on the job yet (shop: `checkShopPeriod` + the close's
   blockers). Refuse rather than improvise.
2. **Draft** — `billing_save.php` (§3), `all: 1`. Read back: exactly one invoice on
   the job, status 0. The broker retries POSTs, so count invoices, don't trust the reply.
3. **Penny check** — the draft's gross = what OP expects = the money held. Stop at
   the draft if not; a draft never reaches Xero.
4. **Approve** — `billing_save_status.php` (§4), `date` = the invoice date. Read back
   `STATUS >= 2` and a `NUMBER`. Never approve an invoice already at 2 or 3.
5. **Invoice → Xero** — `syncSavedRowToXero` with `hh_task: post_invoice_credit`
   (default it yourself if the reply lacks it — the helper's default is
   `post_payment`, wrong for an invoice). Read back `ACC_ID` on the invoice row.
6. **Allocate in HireHop** — `billing_payments_save.php` (§5), `id: 0`, `OWNER` =
   invoice id, `deposit` = deposit id, `bank` = the DEPOSIT's bank, `paid` = what
   the deposit still holds. Read back: invoice `owing` = 0, no deposit left holding
   money. **Do not bother calling HireHop's Xero push for these — it answers
   `package_updated: true` and does nothing** (proven on 16762 and 16750; jon: it
   never has, the office has always pressed "Apply credit" in Xero by hand).
7. **Allocate in Xero — OP does it** — for each invoice-side application: take its
   deposit's `OverpaymentID`, `GET /Overpayments/{id}` (`xero-broker.getOverpayment`),
   work out what it has NOT already applied to this invoice, and
   `PUT /Overpayments/{id}/Allocations` (`xero-broker.allocateOverpayment`) with that
   amount, dated today (never before the overpayment or the invoice). Idempotent by
   construction: a resume, or someone pressing "Apply credit" by hand, is never
   doubled. Scope: the bills token's `accounting.payments` — it worked first time.
8. **Read back from XERO** — `GET /Invoices/{ACC_ID}` → `AmountDue` = 0. This, not
   anything HireHop says, is what "paid" means.
9. **Complete the job** — `status_save.php` (§6) status 11, read back.

### What the bookkeeping module will need beyond this

- Jobs with more than one invoice, part-payments, and deposits bigger than the
  invoice (allocate `min(deposit available, invoice owing)`, oldest deposit first).
- Refunds already in the chain: an `OWNER = 0` application is money back to the
  client, not an allocation (§5); the refunded part of a deposit must never be
  allocated. `hh-deposit-release.ts readDepositAvailability()` already gets this right.
- Credit notes (§7 — not captured), and the Xero 2263 shape (`MONEY-AND-EXCESS.md`).
- Deposits pushed before OP existed may have no `OverpaymentID` (never reached
  Xero) — surface them, don't guess.

---

## 9. Sales-stock items and their nominal group — `/modules/consumables/*` 🟢

Captured 28 Sep 2026 (Sales stock → edit an item → Save).

- **Read:** `GET /modules/consumables/list.php?page=&rows=&del=0` — the till's
  catalogue mirror already uses it (`shop-stock.ts`). Rows carry every field below.
- **Save:** `POST /modules/consumables/save.php` (the UI sends multipart form data).
  It saves the WHOLE item — `ID, TITLE, ALT_TITLE, IMAGE_ID, PART_NUMBER, BARCODE, MEMO,
  CATEGORY_ID, EXCLUDE_FROM_WEBSHOP, VAT_RATE, MAX_DISCOUNT, ACC_NOMINAL,
  ACC_NOMINAL_PO, COST_PRICE, BOUGHT_FROM, REORDER_LEVEL, REORDER_QTY, WEIGHT,
  LOCATION, WIDTH, LENGTH, HEIGHT, VOLUME, COUNTRY_ORIGIN, HS_CODE, STATUS, FLAG,
  PRICES` (JSON `{"_1":{"PRICE":11.25,"TYPE":0},"_2":…,"_3":…}`) `, DEPOT_LIMITS`
  (`[]`). **Send every field back; changing one field means re-sending the rest.**
  The reply is a list page holding the saved item — the read-back.
- **`ACC_NOMINAL` is HireHop's own nominal-GROUP id**, not a Xero code. HireHop maps
  groups to Xero accounts in Settings › Accounting. Groups seen: 6 Shop Sales (→ 270),
  24 Backline hire (the default, → 200), 1 Sale, 2 Purchase, 22 Misc income … Blank =
  the default group. Invoice lines instead carry `ACC_NOMINAL_ID` (175, 189…) — a
  third numbering, the Xero-account mapping. Don't mix them up.
- `backend/src/scripts/shop-nominal-fix.ts` moves every sale item to group 6 (dry
  run by default; reads back each save and stops on any difference). **Run 28 Sep
  2026 with `--default-only`: 822 items moved, every read-back clean.** The price
  `TYPE` the listing omits was sent as 0 and read back unchanged.
- HireHop rate-limits a run like this (error 327 — the broker waits and retries)
  and occasionally answers with a 502 error PAGE; that one is not retried (a POST
  may have landed), so the script stops and a re-run carries on.

---

## 10. Invoice LINES — assign, edit, VAT per line ✅ captured 9 Oct 2026 (scratch job 15745)

HireHop's invoice editor works on the INVOICE's copy of each line, not the job's
item. **VAT is set per invoice line, never on the job item** (the item grid has no VAT
field; `items_save.php`'s `vat_rate: 0` means "derive from the stock's tax rules" —
§9). So an invoice can carry a zero-rated line without the job's supply list, status
or availability being touched. Not built anywhere in OP yet; this is the capture.

### 10.1 What is left to invoice — `billing_assign_list.php` (GET)

```
GET /php_functions/billing_assign_list.php
  pq_datatype=json  job=15745  tz=Europe/London  zero=0  kind=1234  upto=  bill_id=12929  head=  title=
```

`rows[].cell.data` per job line: `item_id` (the JOB line id, e.g. 168521), `KIND` (2
stock, 4 charge), `main_id` (stock / charge-list id), `TITLE`, `QUANTITY`,
`UNIT_PRICE`, `PRICE`, `VAT_RATE` 20, `VAT_ACC_ID` 20 (= tax code id, §10.4),
`NOMINAL_ID` (0 = none set → the invoice falls back to the DEFAULT nominal, 175
Backline hire — seen on two drum-hardware lines), `charge_from` / `date_upto`,
`charge_days`, **`invoiced_so_far`** (0 until invoiced — this is how `all: 1` knows what
is left), `BASE_UNIT_PRICE`, `MULTIPLIER`.

### 10.2 Put chosen lines on a draft — `billing_save_items.php` (POST)

```
POST /php_functions/billing_save_items.php
  main_id=15745  type=1  bill=12929
  data[0][checked]=1  data[0][item_id]=168520  data[0][equip]=1162  data[0][qty]=1
  data[0][unit_price]=1  data[0][discount]=0  data[0][price]=1
  data[0][vat]=20  data[0][vat_acc_id]=20  data[0][nominal_id]=0
  data[0][title]=(Pearl DR503) - PCX100 rack clamp  data[0][memo]=  data[0][kind]=2
  data[0][from]=2026-10-29 09:00:00  data[0][upto]=2026-10-30 09:00:00
  data[0][base_unit_price]=1  data[0][multiplier]=1
  selected=
```

Response = the invoice row (§3 shape) with `items[]` now holding the line as invoice
line `ID` 104283, `MAIN_ID` 168520 (the job line), `ACC_NOMINAL_ID` 175,
`ACC_TAX_RATE_ID` 20. `price`, `discount`, `vat`, `vat_acc_id`, `nominal_id` and
`title` are all per row and all ours to set — this is the call that can build an
invoice line by line. ❓ Untested: the same `item_id` twice in one call (§7).

### 10.3 Change one invoice line — `billing_save_item.php` (POST, singular)

```
POST /php_functions/billing_save_item.php
  id=104283  bill=12929  kind=2  total=1
  desc=(Pearl DR503) - PCX100 rack clamp  memo=
  vat_rate=0  vat_id=33  nominal_id=175  unit=0  main_id=15745  type=1  selected=104283
```

Response: the invoice row with that line at `VAT_RATE: 0`, `ACC_TAX_RATE_ID: 33`,
`VAT: 0`, and the invoice's `TAX` and `owing` recomputed (£1.20 → £1.00). `total` is
the line's net; `nominal_id` can be changed in the same call.

### 10.4 Tax codes (the Xero mapping, from `tax_codes[]` on every billing response)

| HireHop id | Rate | Description | Xero tax type |
|---|---|---|---|
| **20** | 20 | 20% (VAT on Income) — DEFAULT | OUTPUT2 |
| 22 | 5 | 5% (VAT on Income) | RROUTPUT |
| 26 | 0 | Exempt Income | EXEMPTOUTPUT |
| 27 | 0 | No VAT | NONE |
| 30 | 0 | Zero Rated EC Goods Income | ECZROUTPUT |
| 31 | 0 | Zero Rated EC Services | ECZROUTPUTSERVICES |
| **33** | 0 | Zero Rated Income (the one the UI offers, `assigned: 1`) | ZERORATEDOUTPUT |

Which 0% code the EU split should use (33 vs 31) is the bookkeeper's call — ask before
building `HIRE-CLOSE-OUT-SPEC.md` §10.1.

### 10.5 Job lines, for completeness — `items_batch_save.php` / `items_save.php`

Adding a line to a job (any kind, even one) is `items_batch_save.php`:
`parent=0 flag=0 sid=168527 skind=2 job=15745 data={"c89":1} no_availability=0` —
`data` maps `c<charge-list id>` (or the stock equivalent) to a quantity; `sid`/`skind`
is the line it is inserted after. Response `itms[]` carries the new job line (`ID`
7964, `kind` 4, `UNIT_PRICE`, `PRICE`, `ACC_NOMINAL`, `CATEGORY_ID` 500 "Charges").
Editing it is `items_save.php` with `id=7964 … unit_price=50 price=20 vat_rate=0
acc_nominal=24 …` (the `acc_nominal` here is a LIST-level id, not the §10.4 nominal
id — the invoice resolves it; the assign list showed `NOMINAL_ID: 190` Misc income for
this line). A kind-4 charge line is not stock: no availability, no scan, no prep.

### 10.6 Xero today (checked 9 Oct 2026)

Every OP-pushed deposit sits in Xero as an **unapplied Overpayment** and every
HireHop invoice as **Awaiting payment** until the bookkeeper applies the credit by hand
(OT-INV-12252 awaiting; OT-INV-11574 paid, by hand in April). HireHop never pushes
an allocation. The shop close's `applyCreditsInXero` is the only thing in the business
that does it automatically — the hire close-out generalises it.
