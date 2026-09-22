# Shop Sales Module — Spec

**Status:** designed Sep 2026, not built.
**Branch:** `claude/vigilant-wright-64q3yg`

---

## 0. The load-bearing principle — the unit of truth is the TRANSACTION, not the week

Today, shop sales live in a weekly "Shop Sales" dummy job in HireHop: a **shared open
drawer with no receipts**. Multiple users, seven days, no per-transaction integrity. There
is no moment at which anyone can say "this sale is complete and balanced", so the only
available reconciliation is "does the week's total look about right?" — which is why it
usually isn't.

Every symptom traces to that one property:

| Symptom | Cause |
|---|---|
| Someone forgot to 100%-discount a drum head we used ourselves | No transaction exists to be incomplete, so nothing flags it |
| Someone forgot to enter the payment | Lines and payments aren't bound together |
| A studio sitter can't look up a price or record a sale | The drawer is behind HireHop's staff-only login |
| The job shouts "not dispatched" in OP forever | A job-shaped thing that isn't a job |

**The fix: OP becomes the till. HireHop stays the single stock database and becomes the
ledger OP writes to.** A sale is one atomic OP record — lines, tender, who, when — pushed
to HireHop as a unit. Line and payment can never diverge because no human performs them as
two separate acts.

**Corollary (the real prize):** once OP is the only path, manual payment entry can be
gated off in HireHop entirely. That closes the *separate* long-standing problem of staff
applying non-shop job payments by hand in HH instead of through OP. Every other safeguard
is a convention people forget under pressure; this one is structural.

---

## 1. Scope

**In scope:**
- A staff till in OP: search sale stock, build a basket, take payment, push to HireHop.
- A cut-down sitter till in the freelancer portal (price lookup + record a sale).
- Internal consumption ("we used a drum head") as a first-class one-tap action.
- Reversals: undo, correction and refund, with an honest model of what's already committed.
- A local mirror of HireHop's sale-stock catalogue so the till never hits HH at point of sale.
- Weekly reconciliation surface + balance alarm.

**Out of scope:**
- Sales onto a hire job through the normal quote/job flow — already works, don't touch it.
- `thetour.store` (the WebBoutiques webshop). It already reads HH sale stock over the API
  independently. See §16 — explicitly parked.
- Stock takes / reorder reports — HireHop's own consumables module does these.
- After-invoice credit notes (§8, Window C) — manual in v1.

---

## 2. The three transactions — and the trap

Three things are happening that have been lumped together as "shop sales". They have
different requirements and **must use different mechanisms**:

| | Stock moves | Money moves | Mechanism |
|---|---|---|---|
| **Sale** (walk-in, band member, staff) | yes | yes, now | Line on a HH job + deposit |
| **Internal consumption** (our snare's head was knackered) | yes | **no** | HH stock adjustment (`tally_save.php`) |
| **Sale onto a hire** (client asked for 12-gauge strings) | yes | on their invoice | Existing job flow — unchanged |

The distinction between rows 2 and 3 is the client's intent, and it is a clean line:

- **Client asked for it** (a restring, a specific gauge, particular heads) → chargeable, it
  goes on their job like any other sale.
- **It happened to need doing** (head at end of life while prepping, old strings) → consumption.
  No money exists. Don't invent any.

### ⚠️ THE DOUBLE-DECREMENT TRAP — read this before writing any push code

**A stock movement is EITHER a job line OR a tally adjustment. Never both.**

HireHop decrements sale stock by itself when a consumable is added to a job. If OP also
fires a `tally_save.php` adjustment for the same item, the shelf count drops twice. This is
the single most likely way this module does real damage, and it is silent — nothing errors,
the count just drifts.

Every write path must be able to answer "which one of the two am I?" before it fires.

### Why consumption is NOT a 100%-discounted sale

The current workaround models internal use as a sale at 100% discount. That is an
accounting fudge with three concrete problems:

1. It makes a **stock** event require a **money** action, which is precisely why people
   forget it.
2. Sale stock items carry a **`MAX_DISCOUNT`** field (0–100). Any item with a max discount
   below 100 **cannot be 100%-discounted at all** — so there may already be silent failures.
3. A £0 line inside the weekly job destroys the invariant in §9 (lines must equal deposits)
   and makes the weekly job unreadable at a glance.

`tally_save.php` takes `cons` (sale item ID), `qty`, and a **compulsory `details` reason
string**. That is exactly what internal consumption is. No job, no discount, no invoice to
keep clean, a named user on every adjustment, and a queryable burn-rate trail for reordering.

Confirmed with jon (Sep 2026): **stock adjustments have no Xero effect** — consumables are
expensed at purchase and are not carried on the balance sheet. Nothing to reconcile.

---

## 3. Data model

Next free migration number at build time (**232** at time of writing — take the next free
one, parallel branches collide; add the filename to the `migrations` array in
`backend/src/migrations/run.ts` or it silently never runs).

### 3.1 `shop_sale_periods` — the weekly container

```
id                uuid pk
period_start      date        UNIQUE      -- Monday of the week
period_end        date
hh_job_number     integer                 -- the HH "Shop Sales W/C ..." job
invoiced_at       timestamptz null        -- set when the weekly invoice is raised
created_at        timestamptz
```

`period_start UNIQUE` is load-bearing: it stops two tills racing to create two HireHop jobs
for the same week. `getOrCreateShopPeriod(date)` inserts-on-conflict-do-nothing, then reads.

### 3.2 `shop_sales` — one row per transaction

```
id                  uuid pk
period_id           uuid fk → shop_sale_periods  null   -- null for job-routed sales
kind                text   -- 'sale' | 'consumption' | 'reversal'
status              text   -- 'queued' | 'pushed' | 'failed' | 'cancelled'
reverses_sale_id    uuid fk → shop_sales null           -- set on kind='reversal'
hh_job_number       integer null                        -- shop job OR the client's job
hh_deposit_id       integer null                        -- returned by pushDepositToHH
tender              text null    -- key into HH_BANK_IDS: worldpay | amex | till_cash | ...
gross_amount        numeric(10,2)
recorded_by         uuid fk → users
recorded_in         text   -- 'staff_till' | 'sitter_till'
sold_to_person_id   uuid null    -- optional, for a receipt
sold_to_job_id      uuid null    -- the band's job, when routed there
needs_review        boolean default false   -- sitter sales, until ticked off
notes               text null
push_after          timestamptz  -- the Window A hold (§8)
pushed_at           timestamptz null
push_error          text null
created_at          timestamptz
```

**Soft-cancel, never delete** (house rule). A cancelled sale keeps its row with
`status='cancelled'`; a returned sale keeps its row and gains a linked `reversal`.

### 3.3 `shop_sale_lines`

```
id                 uuid pk
sale_id            uuid fk → shop_sales on delete cascade
hh_stock_id        integer          -- consumables list.php ID
name_snapshot      text             -- what it was called at time of sale
qty                numeric(10,2)
unit_price         numeric(10,2)    -- ex VAT
vat_rate_snapshot  integer null
hh_line_id         integer null     -- HH supply-list line, for later amendment
hh_tally_id        integer null     -- HH adjustment id, for kind='consumption'
```

`name_snapshot` and `unit_price` are snapshots on purpose — a price change next month must
not rewrite what someone was charged.

### 3.4 `shop_stock_cache` — the catalogue mirror (§10)

```
hh_stock_id     integer pk
title           text
alt_title       text
category_id     integer
category_path   text
price           numeric(10,2)     -- from PRICES (PRICE1 is DEPRECATED)
vat_rate        integer
max_discount    numeric(5,2) null
quantity        numeric(10,2)     -- shelf count as of refreshed_at
barcode         text null
status          integer           -- 0=Active 1=Hidden 2=Deleted
refreshed_at    timestamptz
```

---

## 4. The staff till

New page, `frontend/src/pages/ShopTillPage.tsx`, reachable from Money and from Quick Actions.

Flow, optimised for someone standing at a counter with a customer waiting:

1. **Search** — type-ahead over `shop_stock_cache` (Postgres, instant, zero HH calls).
   Barcode field focused by default for scanner input. Show price and shelf count with an
   "as of 6 min ago" stamp so nobody trusts the count more than it deserves.
2. **Basket** — qty adjustable, price editable by `MANAGER_ROLES` only (and never above
   `MAX_DISCOUNT`'s implied floor).
3. **Route** — default "Shop (walk-in)". If the till is opened from a job, or a band is in a
   rehearsal room, offer that job instead (§5). **The route stays editable for the whole life
   of the basket** — see §4.1; the customer changing their mind is the normal case, not an
   exception.
4. **Tender** — `getHHBankId()` keys: Worldpay / AmEx / Cash / Stripe / PayPal / bank transfer,
   or **Invoice later** (only enabled when routed to a job — see §9).
5. **Save** — writes `shop_sales` + lines in one transaction, returns instantly. Push is
   queued (§7). The customer walks away; nothing waits on HireHop.
6. **Receipt** — optional, emailed via `email-service.ts`. Nobody wants one for a can of Coke.
   See §4.2 for how the address is found.

**Consumption** is a separate, deliberately different-looking action ("Used for Ooosh") — no
tender, no basket total, but a **required reason** and a suggested job link that goes into the
`details` string ("Snare re-head — prepping job 16412 — Dave").

### 4.1 Changing the route mid-transaction

The common real-world shape: five items rung up, then *"oh — I'm with the band picking up a
van shortly, can this go on that invoice?"*, or *"I'm rehearsing upstairs, add it to that"*.
This is a **change of state**, and it needs to be cheap, because it happens constantly.

Which of the three is happening depends only on how far the transaction has got:

| State | What's happened | Handling |
|---|---|---|
| **Basket, not yet saved** | Nothing anywhere | Change the route dropdown. That's it. |
| **Saved, not yet drained** (Window A, §8) | Row in Postgres only | **"Change route"** = cancel the original + clone its lines into a new sale on the new route. One button. |
| **Drained** (Window B, §8) | Line + deposit live in HH and Xero | Reverse (§8) and re-ring. |

**Almost everything lands in the first row.** The "oh, actually" conversation happens at the
counter, before anyone has tapped a card — so keeping the route editable right up to payment
is the whole fix, and it is a dropdown, not a feature.

**Never make the operator retype a five-item basket.** Row two is "clone with a different
route", not "abandon and start again" — retyping is slow in front of a customer and invites
a half-entered second attempt.

**The till must never offer "delete".** Only *cancel* (Window A) or *reverse* (Window B).
A sale deleted by hand in HireHop after it has drained is exactly the untracked drift this
module exists to eliminate — soft-cancel, don't delete (house rule).

**Not built in v1: moving a *drained* sale between jobs.** Note for later that the mechanism
already exists and is proven — `reverseDepositOnHH()` + `pushDepositToHH()` on the target job
with the same `bankId` is precisely the combine-bookings deposit move (out-leg / in-leg,
net cash zero, a clean Xero wash). So this is a known upgrade path, not a dead end. It is
excluded from v1 only because the basket-stage fix above should make it rare.

**One trap in this flow:** a route change that also flips the tender to **Invoice later** is
only legal once the sale is attached to a real job (§9). A walk-in cannot be moved to
"invoice later" while still routed at the shop job — the till must re-validate the tender
whenever the route changes, not just on first selection.

### 4.2 Finding the receipt address

Same pattern as remittance advice in Costs and the "things arrived" notifier — don't invent
a third way to pick a recipient:

- **Routed to a job** → offer that job's contacts via `services/job-contact-candidates.ts`
  (THE definition of "who could we contact on this job"), rendered through `displayName.ts`.
- **Walk-in, known person** → people search (`routes/search.ts`), pre-filling their email.
- **Walk-in, unknown** → free-text email, or no receipt at all.

**Do not auto-create a `people` row for a walk-in.** People are the platform's primary
entity; a row per Coke buyer pollutes the table that everything else hangs off, and creates
duplicate-merge work later. Link to a person only when they already exist. `shop_sales`
carries `sold_to_person_id` as **nullable on purpose**.

---

## 5. The sitter till (freelancer portal)

Anticipated in `REHEARSALS-SPEC.md` §16 and §1 ("Shop / ad-hoc sales by sitters — deferred").
This spec supersedes that deferral.

**Mobile-first, not mobile-tolerated.** ~99% of sitter use is one-handed on a phone, in a
corridor, mid-conversation with a band member — matching the rest of the freelancer portal
(see the `frontend.md` rule). Big tap targets, a single-column basket, a numeric keypad for
qty, and no horizontal scrolling. The staff till can be desk-shaped; this one cannot.

Same components, cut down:

- **Price lookup is the headline feature.** Right now a sitter genuinely cannot answer "how
  much is a jack lead?". Read-only, instant, works on a phone.
- **Route defaults to the band in the room.** One band in tonight → default to their job.
  **Two bands in → a picker (Band A / Band B)**, because two rooms can be let separately.
  Neither → walk-in on the shop job.
- Selling onto the band's job is the *preferred* path: it lands on an invoice they're already
  paying, needs no cash handling, and takes most of the volume out of the shop job entirely.
- Tender limited to Cash / card terminal / add-to-their-job. No price editing.
- Sitter sales push normally but set **`needs_review = true`**, surfacing in a morning list for
  a quick tick. Warnings, not hard gates (house rule) — the stock count is more important than
  perfection, and the sale carries the sitter's name.

**Lock-up report integration.** §10 of the rehearsals spec already asks "have clients paid? how
+ receipt in till" as free text. Replace that with the real figures: *"tonight: 3 sales, £18.50
— £6.00 cash, £12.50 card"*, and the sitter confirms the drawer matches. The reconciliation
surface is already built; this just gives it something true to reconcile against.

---

## 6. The HireHop write path

### 6.1 A sale routed to the weekly shop job

1. `getOrCreateShopPeriod(saleDate)` → `hh_job_number`, creating the HH job via
   `/api/save_job.php` if the week is new (`job_name` = "Shop Sales W/C 22 Sep 2026",
   dates = that week, generic Shop Sales client). Flag the OP-side job row
   `is_internal = true` so the pipeline, chasers, confirmation hooks and money emails all
   go quiet — `is_internal` is already honoured in `scheduler.ts`, `confirmation-hooks.ts`,
   `hire-form-auto-email.ts`, `money-emails.ts`, `carnet-auto-email.ts`.
2. Add the consumable lines. **The exact mechanism must be verified first — see §18.**
   The hire-stock patterns (`b<id>` in `cost-recharge-hh.ts`, `c<id>` in `quotes.ts`) are the
   shape, but sale stock lives in its own namespace and the prefix is NOT yet known.
3. Set unit price + note via `/php_functions/items_save.php`, `vat_rate: 0` so HH derives VAT
   from the item's own tax rules (same as the recharge and PCN pushes).
4. Push the money as a **deposit** via `pushDepositToHH()` with
   `bankId = getHHBankId(tender)`. Deposits accumulate through the week and get applied to
   the weekly invoice — exactly what happens manually today, but atomic with the line.
5. Store `hh_line_id` and `hh_deposit_id` back on the OP rows. Without these, reversal (§8)
   has nothing to grab.

### 6.2 A sale routed to a client's job

Same, minus the period lookup — `hh_job_number` is theirs. If the tender is **Invoice later**,
no deposit is pushed at all; it rides their normal invoice.

### 6.3 Consumption

Single call: `/modules/consumables/tally_save.php` with `cons`, `qty`, `details`. Store the
returned adjustment ID in `hh_tally_id` — it's the handle for an edit (`id != 0`), which is
how a mistyped consumption gets corrected rather than double-adjusted.

---

## 7. Queue and drain — why the push is deferred

The till writes to Postgres and returns. A low-priority worker drains to HireHop.

**Four things fall out of this, all of them wanted:**

1. **The counter never waits on HireHop.** A 327 storm doesn't stop you selling a Coke.
2. **Retries are free** — the broker's 327 handling and rate limiting apply, at `'low'`
   priority so shop traffic yields to real-time job work.
3. **Window A exists** (§8): a `push_after` hold of a couple of minutes (a `system_settings`
   value, staff-tunable without a deploy) means the most common error — wrong item, caught
   instantly — never reaches HireHop or Xero at all.
4. **Batching**: one push per *transaction*, not per line; a sitter's whole evening drains
   together.

Drain runs on the existing scheduler (`config/scheduler.ts`) every minute or two, plus an
opportunistic kick on save. Durable queue = `shop_sales.status`, so a restart loses nothing.

---

## 8. Reversals — three windows, three different truths

"Refund" is three things. Conflating them is how you end up with money that doesn't
reconcile.

| Window | State | What actually happened | Handling |
|---|---|---|---|
| **A** — before the drain | Nothing in HH or Xero | Nothing happened anywhere | **True undo.** Set `status='cancelled'`. Done. |
| **B** — pushed, week not yet invoiced | Line on job; **payment already in Xero** | Two real events | **Line** amended/removed in HH. **Money** is a real refund. |
| **C** — after the weekly invoice | Committed both sides | Two real events, one documented | Credit note + refund. **Manual, staff-only, v1.** |

**Window B is the important one and the one I initially got wrong.** Payments push
OP → HH → Xero near-instantaneously, so money is committed the moment it drains — a "return
ten minutes later" is *never* an erasure of the payment, even though the stock line is still
freely amendable. The OP record is soft-cancelled and a linked `kind='reversal'` row is
created. Both rows survive. The audit trail says "they bought it, then brought it back",
which is what happened.

**HireHop rejects negative deposits.** A refund must go via
`/php_functions/billing_payments_save.php` with `OWNER: 0, deposit: <original id>` — a refund
payment application against the specific deposit, Xero-synced as `post_payment` not
`post_deposit`. `reverseDepositOnHH()` in `hh-deposit.ts` already does exactly this and has
been trial-and-errored through Xero on the combine-bookings flow; it needs a generalised memo
rather than its hardcoded "deposit reallocated" wording.

**The money-back half is manual until Stripe.** A Worldpay terminal refund is done on the
terminal by hand, so v1 records the refund as **outstanding** and tells the operator to go do
it, clearing when someone ticks it. Once the Stripe-first migration lands (~Nov 2026), OP can
push the refund itself — `excess-refund.ts` is the model, including its `isDuplicateLeg()` rule
(one refund id = one leg, whoever reports it first). Design the reversal record now so that
bolt-on is a service swap, not a rewrite.

**Window C is deliberately not built.** A £4 jack lead coming back after the weekly invoice
is raised will happen approximately never, and the credit-note reconciliation is the most
delicate money code in the platform (see `RETURNS-AND-CANCELLATIONS.md` and the two
netlify-functions credit-note gotchas). Don't extend it for this.

---

## 9. Receipts vs invoices — and why credit sales can't pool

**The weekly shop job's HireHop invoice pools every customer's purchases for that week.**
It therefore can never be sent to a customer — it would show them what everyone else bought.
It is an **internal reconciliation document** and nothing else.

That resolves the duplication risk cleanly:

| Document | Audience | Meaning |
|---|---|---|
| OP shop receipt | the customer | proof of payment **already made** |
| HH weekly shop invoice | us / Xero | the week's takings, tallied |

They are not the same document and never collide.

**The consequence: "invoice later" cannot pool.** A credit sale needs a customer-specific
invoice, which the shared weekly job cannot produce. So:

> **Rule: credit sales must attach to a real job (the band's existing job, or a new one).
> Only paid-in-full cash/card sales pool onto the weekly shop job.**

This is not a limitation in practice — you don't extend credit to an anonymous walk-in, and a
band in a rehearsal room already has a job.

**And it buys a hard, checkable invariant:**

> **`sum(shop job lines inc VAT) == sum(shop job deposits)`, always.**

No line may exist without its payment; no payment without its line. A drift means something
broke. Alarm on it (§12) — this is the property the weekly dummy job has never had, and the
entire reason the current process goes wrong.

---

## 10. Stock catalogue mirror

`/modules/consumables/list.php` → `shop_stock_cache`, refreshed on the scheduler every 10–15
minutes. Paginated, max 200 rows/page, so a few calls per refresh.

- **The till never calls HireHop to search or price.** Search, price lookup and barcode
  resolution are Postgres queries. One person or five, on a good night or during a 327 storm,
  the till is instant. Critically, the sitter's price lookup works on a bad evening.
- Read **`PRICES`**, not `PRICE1`/`PRICE2`/`PRICE3` — the HH docs mark the numbered fields
  **DEPRECATED**. `backline-stock.ts` reads `PRICE_1` from the *hire* stock export; that's a
  different endpoint and is not a precedent to copy here.
- Carry `MAX_DISCOUNT` through so the till can enforce it rather than having HH reject a push
  after the customer has left.
- Filter `STATUS` (0=Active) and respect `EXCLUDE_FROM_WEBSHOP` only for the webshop, not here.
- Show shelf counts with an age stamp. Never gate a sale on the cached count — you are holding
  the item; the count is advisory (house rule: warnings, not hard gates).

Same shape as `backline-stock.ts`, but **persisted** rather than in-memory, so a restart
doesn't cost the first user a cold HireHop round-trip.

---

## 11. Rate limits — the honest numbers

~30 transactions/week ≈ **6 a day**. Even at the expensive 5-call-per-line dance the recharge
pushes use, that's ~30–60 HireHop calls a **day** against a limit of 60 a **minute**.

**Steady-state shop volume is noise.** The risk is not volume, it is *shape* — a burst landing
on top of the 30-minute sync during a 327 storm. §7 (low-priority deferred queue) and §10
(zero reads at point of sale) between them remove both.

Net effect: this module should **reduce** HireHop load, by replacing humans clicking around
HH's UI with a handful of batched API calls.

---

## 12. Reconciliation and alarms

A weekly Shop tab (under Money):

- This week's sales, grouped by tender, with a running total.
- **Balance check**: lines vs deposits (§9). Red if they disagree.
- **Unpushed / failed** queue, with the error and a retry.
- **Sitter sales needing review** (`needs_review`), for the morning tick.
- **Outstanding refunds** not yet done on the terminal.
- This week's consumption, grouped by item — the reordering view you've never had.

Add a sanity scanner (the existing every-15-min slot) for: a sale queued > 30 min, a shop job
that doesn't balance, a failed push. Gate any new scheduled task on the lost/cancelled +
`keep_after_close` rule and the `is_internal` rule per `jobs-pipeline-dashboard.md`.

### 12.1 Where alerts land — no new surfaces

Deliberately nothing new to go and look at. Everything routes to a place someone already
reads every morning:

| Signal | Home | Why there |
|---|---|---|
| Sitter sales needing review | Dashboard **secondary row**, beside "Recharges to Resolve" | Already THE zone for "money things needing a human" (`REHEARSALS-SPEC.md` §7) |
| Last night's takings in context | The **shift handover thread** (`interactions` anchored to the shift) | Staff read the handover in the morning anyway; the sale list belongs with the lock-up notes it reconciles against |
| Shop job doesn't balance / push failed | `notifications`, with escalation | The existing alarm path — this is a real fault, not a chore |
| The week's detail | Shop tab under **Money** | A tab on an existing page, not a new page |

The split matters: the *handover thread* is where the sitter's evening is narrated, and the
*dashboard row* is where staff pick up work. Putting the review queue only in the thread
would bury it; putting the narrative only on the dashboard would strip its context. Both,
each carrying what it's good at.

---

## 13. RBAC

Use the shared constants — never hardcode role lists (`authorize('admin','manager','staff')`
silently locks out `weekend_manager` and `general_assistant`; that has already shipped as a
live bug).

| Action | Who |
|---|---|
| Record a sale / consumption | `STAFF_ROLES` |
| Sitter till (price lookup, record sale on shift) | `freelancer` with an active studio-sitter shift |
| Edit a unit price | `MANAGER_ROLES` |
| Reverse / refund | `MANAGER_ROLES` |
| Raise the weekly invoice | `MANAGER_ROLES` |

Frontend: `hasManagerRole()` / `roleAllowed()` from `lib/roles.ts`, never bare
`role === 'manager'`.

---

## 14. Build order

1. **Verify the two unknowns in §18 against a scratch job.** Nothing else starts first.
2. Migration + `shop_stock_cache` + the catalogue refresher. Ship this alone — price lookup
   is independently useful and risk-free (read-only). **Note what this step is not:** the
   mirror is stock and prices only. The running tally that ends the "where's the missing £24"
   drift is the `shop_sales` ledger plus the balance invariant (§9) — steps 4, 6 and 9. And
   it only ever covers sales made *through OP*; it prevents future drift, it does not find
   historic drift in the existing weekly jobs.
3. Sitter price lookup in the freelancer portal. Smallest thing that removes a daily pain.
4. `shop_sales` model + staff till UI, saving to Postgres only. No HireHop writes yet.
5. The queue + drain: consumption via `tally_save` first (one call, no money, reversible).
6. Sale push: lines + `pushDepositToHH`. Shop-job routing.
7. Job routing (band's job / client's job) + the two-band picker.
8. Reversals — Windows A and B.
9. Weekly Shop tab, balance alarm, review list.
10. Lock-up report integration.
11. Receipts.
12. **Then** gate manual payment entry in HireHop (§15).

---

## 15. Reuse seams — do not reinvent

| Need | Use |
|---|---|
| Push money to HH + Xero | `services/hh-deposit.ts` `pushDepositToHH()` |
| Tender → HH bank account | `services/hh-deposit.ts` `getHHBankId()` / `HH_BANK_IDS` |
| Reverse a payment (HH rejects negative deposits) | `services/hh-deposit.ts` `reverseDepositOnHH()` |
| Refund idempotency (for the Stripe bolt-on) | `services/excess-refund.ts` `isDuplicateLeg()` |
| Talking to HireHop | `services/hirehop-broker.ts` — always, with `priority: 'low'` here |
| Catalogue-mirror shape | `services/backline-stock.ts` (but persist, and read `PRICES`) |
| Adding a priced line to a HH job | `services/cost-recharge-hh.ts` / `services/pcn-recharge.ts` |
| Sending a receipt | `services/email-service.ts` (`services/excess-receipt.ts` as the model) |
| Money formatting / settled state | `frontend/src/lib/money.ts` |
| Staff-editable config | `system_settings` — not env vars |
| Silencing the shop job | `jobs.is_internal` |

---

## 16. Out of scope / future

- **`thetour.store`.** Already reads HH sale stock over its own API integration
  (WebBoutiques). Shared with this module: a stock-and-price read and a "record a sale"
  writer. **Not** shared: carts, shipping, distance-selling VAT, gateway, returns, product
  copy, fulfilment — i.e. most of a webshop. There is also a hard mismatch: a 10-minute
  cached mirror with no reservation concept is fine for a till (you are holding the item)
  and would oversell online. Keep the two seams clean so a future integration *could*
  reuse them; do not let webshop requirements shape the till. **Parked by jon, Sep 2026.**
- **Stripe-native refunds** — bolt-on once the terminal migration lands (~Nov 2026).
- **Window C credit notes** (§8).
- **Cash handling.** Nothing here stops an unrecorded sale or a pocketed fiver. OP makes the
  *recorded* ones correct; it cannot make unrecorded ones appear. Once card is Stripe-first,
  card sales reconcile automatically and only cash remains exposed.

---

## 17. Open items / gotchas

- **Double-decrement (§2)** — job line XOR tally adjustment. Never both. Silent if wrong.
- **`MAX_DISCOUNT`** may already be silently blocking today's 100%-discount workaround on
  some items. Worth a quick audit of the current shop job when the mirror lands.
- **`PRICE1/2/3` are deprecated** in the consumables API — read `PRICES`.
- **HireHop rejects negative deposits** — refunds go via `billing_payments_save.php`.
- **Payments hit Xero near-instantly.** There is no "quiet period" on the money half; only
  the queue hold (Window A) is genuinely free.
- **The weekly shop invoice is internal-only** — it pools all customers. Never email it.
- **`period_start UNIQUE`** is what stops two tills creating two HH jobs for one week.
- **JSONB columns must be `JSON.stringify`d on write** — an empty array survives, so the bug
  only surfaces once the feature is genuinely used.
- **Gating manual HH payment entry means OP down = can't take money.** Document a manual
  fallback (take payment, note it, enter when OP is back) and make sure at least one person
  besides jon can re-open the HireHop permission in an emergency.

---

## 18. Verify before writing push code

**Method: watch HireHop do it.** Cheapest and most definitive — perform the action in
HireHop's own UI with the browser Network tab open and capture the request it sends. That is
ground truth for the payload shape, in a way that guessing from the API docs is not (it is
how the HH unknowns on previous modules were settled). Then one throwaway probe script under
`backend/src/scripts/` confirms our broker + credentials can reproduce the same call — the
UI capture proves the *shape*, the probe proves *our* auth path.

Do it against a scratch job, clearly named (e.g. "ZZZ TEST — OP shop sales, do not invoice")
and flagged `is_internal` in OP so it doesn't leak into the pipeline or trigger a chaser.

Two unknowns, both capable of changing the design, both cheap to settle against a scratch
job and a cheap item:

1. **`tally_save.php` sign convention** — does a positive `qty` add to or subtract from the
   shelf? And does it authenticate the same way as the other module endpoints, or does it
   need the export credentials like `list.php`? Fire one adjustment on a cheap item and read
   the shelf count back.
2. **How a *sale* item is added to a job.** The hire-stock prefixes are `b<id>`
   (`cost-recharge-hh.ts`) and `c<id>` (`quotes.ts`); sale stock is a separate namespace and
   its prefix is unknown. Getting this wrong either does nothing or puts the wrong item on a
   live job. Confirm on a scratch job before a line of push code is written — this is the
   carnet stock-namespace lesson (`REHEARSALS-SPEC.md` §2: never match on `LIST_ID` alone).

3. **How a sale line is REMOVED from a job.** Needed for Window B reversals (§8) and for the
   future drained-sale move (§4.1). Not documented anywhere we have; capture it by deleting
   the test line in the HH UI.
4. **Does adding a consumable to a job move the shelf count on its own?** Free to observe
   while doing (2) — note the count before and after. This is the direct empirical test of
   the double-decrement trap (§2). If the count *doesn't* move, the whole sale model changes
   and a tally adjustment becomes mandatory alongside every sale line, so this is not a
   formality.

A fifth, lower-risk: confirm whether a tally adjustment can carry a job reference. The
`tally_save.php` *response* exposes `JOB` and `REPAIR` on an adjustment, but the documented
*send* parameters don't include them. If it can't, the job reference goes in the `details`
string and that's fine.

**`MAX_DISCOUNT` audit (§17).** Believed to be 100 on everything, but confirm it rather than
assume — it costs one query once the mirror lands, and if any item is below 100 then today's
100%-discount workaround has been silently failing and those shelf counts are already wrong.
