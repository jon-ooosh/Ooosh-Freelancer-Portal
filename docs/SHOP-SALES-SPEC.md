# Shop Sales Module — Spec

**Status (24 Sep 2026): steps 1–6 SHIPPED and live.** The core loop works end to
end — record a sale or a stock use in OP, it lands in HireHop. Steps 7–12 (job
routing UI, reversals, the Shop tab, lock-up integration, receipts, gating
manual HH payment entry) are not built. **§19 is the current state and what to
pick up next — read it first.**

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

### 2.1 When stock ACTUALLY moves — verified against scratch job 16735, Sep 2026

**HireHop applies its hire-style reservation model to sale stock. The shelf count only
drops at DISPATCH.** Measured on a 1" green fluoro tape (consumables ID 25):

| Job status | `avail` | Shelf `STOCK` |
|---|---|---|
| Enquiry (0) | 14 | 15 |
| Confirmed (2) | 14 | 15 |
| **Dispatched (5)** | 14 | **14** |
| Line deleted post-dispatch | — | back to 15 |
| Line added to an **already-dispatched** job | — | **14 immediately** |
| Returned (7) | — | stays 14 |
| Completed (11) | — | stays 14 |
| **Reverted to Enquiry (0)** | — | **back to 15** |

Adding the line reserves it (`avail` drops immediately); only dispatch consumes it.

**Consumption holds at any status ≥ dispatched (5) and is RELEASED by a regression below
it.** Adding a line to a job that is already dispatched bites immediately, which is what
makes the whole design work:

> **The weekly shop job sits permanently at DISPATCHED (5) from creation.** Every sale
> decrements the shelf the moment it drains. Stock is accurate to the minute.

### ⚠️ The shop job's STATUS is load-bearing state

Two independent ways to silently un-sell an entire week, neither of which errors:

1. **A status regression below 5.** Everything on the job un-consumes and the stock
   reappears.
2. **Checking a sale item in.** Removes it from the consumption — the same way a VE103B
   certificate was accidentally un-consumed at the end of a hire (a real prior incident).

This is the direct argument for §3.5: because OP pushes `pipeline_status` to HireHop, a
shop job living in OP's `jobs` table is one stale-enquiry sweep or mis-click away from
releasing a week of stock. Keeping it out of OP's `jobs` table entirely makes that
impossible rather than merely unlikely.

**The integrity check that covers all of it** (§12): OP knows exactly which lines it
pushed. A scanner re-reads the shop job's supply list and confirms every line is still
present at the expected quantity. One call, and it catches deletion, accidental check-in
AND status regression — rather than three alarms for three symptoms of the same fault.

**Note on existing data.** Today's weekly job is booked out and completed by hand, so it
does pass through dispatched and historic sales have consumed. Older or abandoned shop
jobs that never reached dispatch will not have — not this module's problem to backfill.

### 2.2 Prices are ex-VAT, and `VAT_RATE` is an INDEX not a percentage

Everything HireHop returns is **ex-VAT**. The till must display and charge inc-VAT, the
deposit pushed must be the inc-VAT amount the customer actually paid, and the
lines-equal-deposits invariant (§9) must compare inc-VAT to inc-VAT.

**⚠️ The trap:** the verified item came back `"VAT_RATE": 0` while the HireHop UI showed
**"Tax rate Standard"**. `VAT_RATE` is an index into HireHop's tax types — **0 means the
standard rate, NOT zero-rated**. Code that reads it as a percentage charges no VAT on every
item and the weekly invoice quietly under-declares.

Map index → rate in `system_settings` (staff-editable, no deploy), defaulting index 0 to
20%. Confirm against a genuinely zero-rated line if one is ever stocked — in the UK most
cold food is zero-rated while canned drinks and confectionery are standard, so the
distinction is live rather than academic for a shop selling snacks.

### 2.3 Shelf count vs allocation — the "sold out from under a job" gap

The scenario: drum heads booked onto a confirmed, paid job going out Thursday; someone
walks in Tuesday and buys them off the shelf.

Partly solvable. `avail` drops the moment a line is added to ANY job, so **HireHop already
tracks reservation for sale stock** — it just isn't in the bulk `list.php` export we mirror.
`items_picklist_avail.php` returns it per item, and we already call that endpoint
(`routes/backline-matcher.ts`, with `b<id>`); the same call with `a<id>` covers sale stock.

**v1: one availability call per distinct item as it enters the basket** — roughly a dozen a
day at this volume. The till shows *"15 on the shelf · 3 reserved for jobs · 12 free"* and
**warns** when the sale eats into reserved stock. Warning, not a block (house rule) —
sometimes selling and reordering is right, and only a human knows which.

**Honest limits.** It only works if the heads were actually added to the job in HireHop; it
does not stop someone booking out stock already sold but not yet collected; and it cannot
conjure stock — a warning two days out is still a phone call.

**Physical segregation is the only real fix** for "a confirmed job's consumables must be
untouchable", and that is a warehouse process question, not a code one. What code can do is
stop it being a surprise: `list.php` returns `REORDER_LEVEL` and `REORDER_QTY`, and with the
consumption trail a reorder view turns "we ran out on Friday" into "we knew on Monday"
(§12). Nearly free once the mirror exists.

### 2.4 The sale catalogue is NOT the shop — scoping the till

Verified Sep 2026: HireHop holds **974 sale-stock items** across 17 categories —
Tape (338), Power (339), Batteries (340), Dirty Rigger (341), Guitar & Bass (342),
Percussion (344), Cables (345), Components (346), Accessories (348), Stands (349),
Drum Heads (350), Vocals (351), Strings (352), Drum Sticks (353), Guitar Pedals (354),
**Misc Sale Item (355)**, Drinks & snacks (356).

Not all of that is shop product. "Misc Sale Item" holds things like the **VE103B
certificate** (£25) — a compliance charge raised onto a hire, not something anyone buys
over the counter. A till listing all 974 would let someone sell a VE103B certificate to a
walk-in.

#### Why NOT HireHop's "exclude from webshop" tick

Tempting — it is a HireHop-native marker, it needs no second system, and it lines up with
`thetour.store`. **It is still the wrong flag**, because it answers a different question:

> *"Should the public be able to buy this and have it **shipped**?"*

which is not

> *"Can a member of staff sell this **over the counter**?"*

The two answers diverge on the till's single most common category. **Drinks & snacks
should absolutely be excluded from a webshop** — nobody posts a can of Coke — and are
absolutely core till stock. Wire the till to that flag and the day the webshop gets
configured properly, the till loses its bread and butter, silently, with no error.

There is a maintenance argument too: the webshop flag is per-item across 974 rows, so
every new internal-charge item needs remembering. Category scope is 17 decisions.

**`exclude_from_webshop` IS mirrored** (migration 236) because it is the right flag for
its own purpose and the webshop will want it. It is just not this purpose.

#### The mechanism: a category EXCLUSION list, and it fails open

`system_settings.shop_excluded_category_ids`, a JSON array of HireHop category IDs,
staff-editable, seeded `[355]`.

**Exclusion, not allowlist** — the direction is the whole point. An unclassified category
still shows at the counter, so new stock is sellable the day it lands. With an allowlist a
new category is invisible until someone edits a setting, and *"I can't find it to sell
it"* is a worse failure in front of a customer than *"this probably shouldn't be listed"*.
The `heads` list HireHop returns also looks top-level-only (IDs 343 and 347 are absent),
so an allowlist risks hiding sub-categories we cannot currently enumerate. Every failure
path in `getExcludedCategoryIds()` — missing setting, malformed JSON, unreadable table —
hides nothing.

**⚠️ The exclusion does NOT cascade to sub-categories.** Confirmed live Sep 2026: sale
stock genuinely is hierarchical — `Guitar & Bass › Guitar Picks` (42 items) and
`Components › Valves` (8) are real sub-categories with their own `category_id`. Today
`Misc Sale Item` has no children and only 7 items, so `[355]` is complete. But if it ever
gains one (`Misc Sale Item › Certificates`, say) that child's ID is **not** excluded and
its items appear at the till, silently.

Deliberately not solved in the query — matching on `category_path` strings would break on
a rename, which is a worse failure than the one it prevents. **Solve it in the settings UI
instead**: render the category tree rather than a flat list, so ticking a parent visibly
has children under it. Until that exists, adding a sub-category to a hidden category means
adding its ID too.

**The scope applies at the READ, not the refresh**, because the two consumers want
different sets:

| Consumer | Scope |
|---|---|
| Till search / price lookup | excluded categories hidden |
| **Barcode scan** | **no exclusion** — they are physically holding it; refusing to price a thing in the customer's hand is a gate that strands staff |
| Reorder view (§12) | **all** sale stock — VE103B certs carry `REORDER_LEVEL: 15`, `REORDER_QTY: 50`, and running out of those matters too |

#### Not a finding: the `▶` on "▶ VE103B certificate"

Seen in the live catalogue and initially read as HireHop's prompt-parent marker. **It was
typed into the item's name by hand** — confirmed by jon, Sep 2026. Sale stock is believed
not to support the prompt/AUTOPULL cascade that hire stock does, though that is a belief
rather than a verified fact. Don't design around either assumption; if a genuine prompt
ever appears on a sale item, verify before building for it.

### 2.5 ⚠️ `success: true` does NOT mean HireHop did it

The single most important thing the write probe turned up (23 Sep 2026).

`POST /api/save_job.php` with `delete: ["b9154"]` returned **`success: true`** with a full
job payload — and **the line was still on the job**. HireHop had accepted the request and
silently ignored the instruction. The only tell was that the response carried no `items`
key at all, where the successful *add* had returned the created line inside
`data.items.itms`.

> **Every write in this module must verify by reading back. Never treat `success: true`
> as proof the change happened.**

This is exactly the shape of failure this module exists to eliminate — a stock movement
that nobody is told went wrong. It also validates the line-integrity scan in §12: that
scan is not belt-and-braces, it is the only thing that would catch a push HireHop claimed
to have made and didn't.

### 2.6 Adding a sale line costs ONE call, not four

`save_job.php` returns the **created line in its own response**, under
`data.items.itms[0]` — `ID`, `kind`, `LIST_ID`, `UNIT_PRICE`, `ACC_NOMINAL`, `avail`, the
lot. Verified 23 Sep 2026: adding `a25` came back with line `9154` fully populated and
priced at 7.50.

So the §6.1 sequence collapses. The proven recharge pattern
(`cost-recharge-hh.ts`, `pcn-recharge.ts`) does **snapshot → add → sleep 1s → re-read →
`items_save`** because it needs the new line's ID and a custom price. A list-price shop
sale needs neither:

| | Calls per line |
|---|---|
| Recharge pattern (what §6.1 originally assumed) | 4 + a 1s wait |
| **Shop sale at list price** | **1** |
| Shop sale at an overridden price | 2 (add, then `items_save`) |

Read `hh_line_id` straight from the add response. Don't re-read to find it.

(The recharge and PCN pushes could be simplified the same way — but they are proven money
code and the win there is small. Not worth touching.)

### 2.7 HireHop publishes its own tax table

The job payload carries `standard_tax_rates`, which is the index→rate map §2.2 needed:

| INDEX | Rate | Description |
|---|---|---|
| 0 | 20% | 20% (VAT on Income) |
| 1 | **0%** | Zero Rated Income |
| 2 | 5% | 5% (VAT on Income) |

This confirms index 0 is the standard rate — and shows migration 236's seed of `{"0":20}`
was **incomplete**. A genuinely zero-rated item would have missed the map, hit the
fall-back-to-standard rule and been charged 20% it shouldn't carry. The fallback direction
was still right; being right by accident is not the same as being right. Migration 237
completes the map (guarded, so a hand-edit wins).

**Worth wiring properly when the push code lands:** read `standard_tax_rates` off the job
payload we are already fetching and warn when it disagrees with the configured map, rather
than maintaining the map by hand. Drift between HireHop's tax setup and ours is exactly
the sort of thing nobody notices until a VAT return.

### 2.8 Discounts

Two different asks, and they are not the same problem:

| | Shape |
|---|---|
| **Per-line** | "10% off these drum heads" — reduce one line |
| **Basket rounding** | "£52.11, call it £50" — reduce the total by £2.11 |

**v1 supports per-line only.** A line's unit price is overridable via `items_save.php`
(the 2-call path in §2.6), `MAX_DISCOUNT` is 100 on every item so HireHop imposes no
ceiling of its own, and the invariant in §9 holds automatically because the line itself
moves.

**Basket rounding is deliberately NOT built**, and the reason is VAT apportionment rather
than effort. Spreading £2.11 across a basket that mixes rates (971 items are standard,
3 are zero-rated — §2.7) means deciding which rate the discount comes off, and HMRC has
rules about that. Getting it wrong misstates VAT on the weekly invoice, which is the one
category of bug this module must not introduce. For a shop whose typical basket is a jack
lead and a can of Coke, that is a lot of risk for a rare convenience.

**The escape hatch covers most of it:** the till shows a live running total, so an
operator who wants the total to land on £50 discounts one line until it does. Same
outcome, no apportionment question, and the discount is visible on the line it came off.

**Who may discount — a ceiling per role, not a yes/no** (agreed with jon, Sep 2026):

| Role | Max discount |
|---|---|
| `admin` | 100% |
| `manager` / `weekend_manager` | 50% |
| `staff` / `general_assistant` | 10% |
| `freelancer` (studio sitter) | 0% — may not discount |

Stored in `system_settings` rather than hardcoded, per the house rule for anything staff
may want to change without a deploy. `weekend_manager` is never listed separately in code
— `authorize()` already treats it as `manager`.

**⚠️ The ceiling applies to the TRANSACTION total, not the individual line.** A per-line
cap would break the rounding escape hatch above: knocking £2 off a £52 basket of £1 cans
means discounting one can by 100%, which a 10%-per-line cap blocks even though the
customer is getting 4% off. What matters commercially is how much margin is being given
away overall, so the cap is `(total discount ÷ undiscounted total)`.

Every discount records who applied it and how much, since the weekly reconciliation must
be able to answer "why did this week take less than it listed".

**Never a hidden discount.** A basket that doesn't reconcile must show as a discount on a
line, never as a payment that happens to be less than the total — that would break §9's
lines-equal-deposits invariant, which is the module's whole integrity story.

### 2.9 ⚠️ HireHop's API docs do not match its endpoints — CAPTURE, never trust

Twice now the documented parameter names have been wrong, and both times it cost
a live round-trip:

| Endpoint | Docs say | Actually wants |
|---|---|---|
| `items_delete.php` | (undocumented) | `ids` as a **bare string**, `job`, `arch`, `no_availability` |
| `tally_save.php` | `cons`, `id`, `qty`, `details` | **`CONSUMABLE_ID`**, **`ID`**, **`QTY`**, **`DETAILS`** (uppercase), plus `local`, `tz`, `CUSTOM_FIELDS` |
| `picklist_get_availability.php` | (guessed from `staging.ts`) | `job` (**required**), `global_depot`, `rows` of `{ID,TYPE,AVAILABLE:1,GLOBAL:0}`, `local`, `tz` |

**`save_job.php` (create) was NOT one of these — that one was my mistake.** It
returned the same error 3, but because the payload sent `CLIENT_ID`, lifted from
the RESPONSE field list. HireHop's send parameters are lowercase (`client_id`)
and the uppercase names are what it returns. `name` is also documented as
required when creating, and was missing. A useful corollary: three wrong
endpoints in a row made a fourth look like the same problem, and it wasn't.
Check your own reading before concluding the vendor is wrong again.

The availability one is the subtlest of the three: `TYPE: 1` for sale stock was
right all along, and the call still returned nothing because of the company it
kept — staging's extra `ITEM_ID`/`STOCK` keys, `GLOBAL: 1` instead of `0`, and
above all a missing `job`. Copying a *neighbouring* caller is not the same as
capturing the one you need.

The documented shape for `tally_save.php` returns **error 3**. Worse, it is the
quiet kind of wrong — a plausible-looking payload that HireHop rejects with a
bare number, which then lands in `push_error` as `"blue fluoro tape: 3"` and
tells nobody anything.

> **Rule: before writing any HireHop write, perform it in HireHop's own UI with
> the Network tab open and copy the PAYLOAD tab verbatim.** Not the Response —
> that has twice looked informative and settled nothing. The docs are a hint
> about what an endpoint does, never about how to call it.

`local` is the user's **local wall-clock time**, not UTC: captured as
`2026-09-23 16:42:40` while the stored `DATE` came back `15:42:40`. The server
runs in UTC, so it must format Europe/London explicitly.

### 2.10 The customer's document is a VAT RECEIPT, not a second invoice

The risk jon raised: if OP issues an invoice for a shop sale AND the weekly
HireHop job invoices the same sale, the same revenue is invoiced twice.

**It isn't, because the customer's document is not an invoice.** An invoice
creates a debtor — it says "you owe us this". A shop sale is already paid, so
the document that belongs to it is a **receipt**, evidencing a payment that has
happened. The weekly HireHop invoice stays the single accounting document, and
§9's rule keeps it internal because it pools every customer.

**That also solves what the old fudge was for.** Staff edited the shop client's
address to raise ad-hoc invoices because a customer wanted something for their
records. Under UK rules a *simplified VAT invoice* covers supplies under £250
and needs only: our name, address and VAT number; the time of supply; a
description; the total including VAT; and the VAT rate per line. Notably it
needs neither the customer's details nor a sequential invoice number — the
things that make a full invoice an accounting artefact. A VAT receipt carrying
those fields IS the document a business customer needs to reclaim, so nobody
has to fabricate an invoice.

**⚠️ Confirm the threshold and the required fields with the accountant before
building this.** It is the one piece of the module that rests on tax rules
rather than on something we have verified ourselves, and it is the piece whose
absence caused the original mess.

**Numbering: `OT-SHOP-00100`** — starting at 100 rather than 1, jon's preference. Deliberately outside both existing sequences —
HireHop raises `OT-INV-#####` (around 12243 today) and Xero-direct raises
`OT-#####`, so a third prefix cannot collide with either as they advance. It is
a traceability reference, **not** an accounting invoice number, which is exactly
why it can have its own sequence without anyone reconciling it.

### 2.11 OP had never created a HireHop job before this

Worth stating because it explains why there was no pattern to copy. Every other
`save_job.php` call in the codebase targets an **existing** `job: <number>` —
`hirehop-writeback.ts` renames one, the recharge and PCN pushes add items to
one. Enquiries become HireHop jobs in HireHop, not from OP.

The weekly shop job is the first job OP creates, which is why its payload came
from documentation rather than from a working neighbour — and why it is
read back and verified rather than trusted (§2.5).

Also confirmed by the same docs, and matching what the picklist showed: the
`items` prefixes are **`a` = sales, `b` = hire, `c` = labour**.

### Confirmed HireHop facts (scratch job 16735, Sep 2026)

| | Finding |
|---|---|
| **Sale-stock prefix** | **`a<id>`** — picklist `a25` ↔ consumables `list.php` `ID: 25`. Hire stock is `b<id>` (`b1967`, `TYPE: 2`), matching existing usage in `cost-recharge-hh.ts`. |
| **Sale line `kind`** | **`kind: 1`.** NOT in the `PLATFORM-CONVENTIONS.md` table (0=header, 2=item, 3=prompt, 4=service). Any filter written as `kind === 2` silently misses every sale line. |
| **Tally sign** | Negative `qty` consumes, positive restores. Each adjustment returns an `ID`, so it is editable via `id != 0`. |
| **Removal restores stock** | Deleting a line from a *dispatched* job returns the shelf count. Window B reversals work. |
| **Prices** | `PRICES._1.PRICE` is Price A. Sale items carry no `TYPE` key inside `PRICES`; hire items carry `TYPE: 2`. `PRICE1/2/3` remain deprecated. |
| **Unit price auto-fills** | A line added from stock arrives already priced (7.50), so a **list-price sale needs no `items_save` step at all** — only a discounted or overridden price does. Roughly halves the per-sale call budget in §6.1. |
| **`VAT_RATE: 0` on the line** | Means "derive from the stock's own tax rules", consistent with the existing recharge and PCN pushes. |
| **Consumables endpoint auth** | The **normal broker token works** — no separate export credentials needed, unlike `backline-stock.ts`. Verified live: 974 records, 5 pages at 200 rows. |
| **Availability for sale stock** | `items_picklist_avail.php` returns `{"a25":{"available":14,"global":14,"late":0}}` — so the till CAN show free-vs-reserved (§2.3). Verified against a shelf count of 15 with one unit reserved on a job. |
| **`MAX_DISCOUNT` audit** | **Clean.** Zero active items below 100 across all 974, so the current 100%-discount workaround has not been silently failing. |

**⚠️ `b` is overloaded.** In the picklist it prefixes a *hire stock* ID. In the delete
response (`{"success":["b9146"],"ids":["b9146"]}`) it prefixes a *supply-list line* ID.
Same letter, different namespace, decided by context. Do not write one helper that assumes
either meaning.

**Shelf count vs availability.** `list.php` returns shelf count only; availability is
per-job and comes from the picklist. So the mirror can show "15 on the shelf" while three
are reserved for a job leaving tomorrow. v1 shows shelf count, **labelled as such** — fine
for a can of Coke, a real risk for gaffa earmarked for a tour. A live availability lookup
on the item detail view is the upgrade if that bites.

---

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

### 3.0 The shop job is NEVER synced into OP's `jobs` table

Not a display filter — an **exclusion at the sync boundary**. `hirehop-job-sync.ts` already
filters there (the `kind === 1` jobs-vs-projects filter, ~line 330); the inbound webhook
handler in `routes/webhooks.ts` needs the same guard.

Why this rather than flagging the row and filtering the lists:

- **One guard instead of a sweep.** A row that was never inserted cannot appear in the
  pipeline, Jobs, On Today, dashboard, search, Returns, Problems or anywhere else. Filtering
  N lists means N chances to miss one, and the one missed is where the confusing row shows.
- **It structurally removes the status hazard (§2.1).** With no OP job row, OP can never
  push a `pipeline_status` to the shop job, so the "one stale-enquiry sweep releases a week
  of stock" failure mode becomes impossible rather than unlikely.
- Chasers, confirmation hooks, money emails, carnet sweeps and the rest need no individual
  guarding — none of them can see it.

`is_internal` is the wrong tool here: it means "our own job, not a client's", and such jobs
legitimately appear in lists. This is a different concept — **machinery, not a booking**.

**Identify it by both belts:**

1. HH job number present in `shop_sale_periods` (OP created it, so OP knows), **or**
2. the HireHop client is the dedicated **"Shop Sales" organisation** — which catches one
   created by hand in HireHop.

Belt 2 is a marker, deliberately **not** the filter used by the display layer. An org is a
mutable value a human can rename, and the duplicates/merge tool can rewrite exactly that
field; it is fine as a secondary signal at one guarded boundary, and would be fragile as
the primary test scattered across every job list.

**Cost:** OP's normal Money tab won't show the shop job. Acceptable — the Shop tab (§12) is
its home.

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

### 6.0 The weekly job — settings, and why the client is a FRESH one

**Name:** `Shop Sales W/C {date}` where `{date}` is the Monday, e.g.
`Shop Sales W/C 28th Sep 2026`. Dated **Monday 00:01 → Sunday 23:59**, held at
DISPATCHED (§2.1). Settings: `shop_job_name_pattern`, `shop_job_client_id`
(migration 243).

**A NEW HireHop client, created by hand.** The existing shop-sales contact is not
reusable, and the reason is itself an argument for this module: staff have been
editing its *address* to raise ad-hoc invoices for one-off purchasers, which has
made a mess in Xero. Two consequences:

1. jon creates "OP Shop Sales" in HireHop once, by hand, and its `CLIENT_ID`
   goes in the setting. **OP never creates the contact** — passing a company
   name to `save_job.php` risks a near-duplicate contact every week, which is
   the same class of mess with a different cause.
2. **Nothing may ever edit that contact again.** The behaviour it replaces
   exists because staff had no other way to invoice a one-off purchaser; §9's
   rule (a credit sale attaches to a real job) is what removes the need. Worth a
   sanity check that alarms if the contact's name or address changes — a known
   incident is exactly what a scanner is for.

**`CLIENT_ID` on a job is the COMPANY id, not the person id.** HireHop's contact
feed distinguishes them — `hirehop-sync.ts` maps `ID` as the person and `cID` as
the company — and a job's `CLIENT_ID` pairs with `CLIENT_ASSIGN`, the company
name. For a one-person company contact the two are equal (OP Shop Sales is
`ID: 3067, cID: 3067`), so the distinction is invisible here and would bite on
the first contact where it isn't.

OP has never created a HireHop contact and does not start now: `pipeline.ts`
only ever *reads* an auto-assigned client id back, and enquiry intake creates OP
organisations rather than HireHop ones. Handcrafting is the established shape,
not a workaround.

**Empty client id = the weekly job is not created and sales stay queued.**
Deliberate: a sale waiting in OP is recoverable, a week of takings on the wrong
HireHop client is a Xero cleanup.

`shop_availability_job` (migration 242) should point at this job once it exists.

**Never link to the shop job from the till.** The till shows only that the week
is ready — no job number, no link. The shop job is machinery: OP is the only
thing that should write to it, and anyone who opens it in HireHop is one status
change away from releasing a week of sale stock (§2.1). A clickable number is an
invitation to do exactly that, and the staff most likely to click it are the
ones who least expect the consequence.

**The exclusion only protects jobs it already knows about.** §3.0 filters on
`shop_sale_periods`, so there is a narrow window between HireHop creating the
job and that row existing in which the 30-minute sync could pull it in.
`getOrCreateShopPeriod()` checks for a leaked `jobs` row immediately after
insert and logs loudly if it finds one — it would otherwise look like the guard
had failed rather than raced.

**The exclusion does NOT cover jobs created by hand in HireHop.** A scratch job
made directly there is an ordinary job and syncs into OP correctly; only jobs in
`shop_sale_periods` are shop jobs.

**The job is for the CURRENT week, created on demand.** `weekStart(today)` is
this Monday, not next — nothing waits for a Monday to roll around. Normally the
first sale of a week brings the job into being, but "the first sale" is a poor
moment to discover the client id is wrong, so `POST /shop/period/ensure` and a
button on the till create it directly.

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
freely amendable. A linked `kind='reversal'` row is created. Both rows survive. The audit
trail says "they bought it, then brought it back", which is what happened.

**As built (step 8, Sep 2026):** the original sale is **NOT** soft-cancelled — it keeps
`status='pushed'`, because its line and deposit really did reach HireHop, and `cancelled`
means "never happened" (Window A). The reversal row carries **negative** money figures, so
summing a week's rows gives what the week actually took. Whole sale only: taking one item
back from a basket is "refund the sale, ring the rest again", because a partial reversal
means editing a line's qty in HireHop and that endpoint has not been captured. Refund is
`MANAGER_ROLES` (money out); cancel stays open to all staff.

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
  ✅ **SHIPPED Sep 2026** as `GET /shop/consumption` + a panel on the till.
  HireHop keeps a per-item adjustment trail, so "what happened to THIS item" is
  already answerable there; what it cannot do is "what did we burn through last
  month", which would mean opening every item in turn. Counts only usage that
  actually reached HireHop — a queued or failed row has moved no stock, and
  including it would overstate consumption.

**Reorder view** (§2.3): items at or below `REORDER_LEVEL`, with `REORDER_QTY` and the
recent consumption + sales trail. Turns running out into a week's notice, and it is nearly
free once the mirror exists.

**Line-integrity scan** (§2.1): re-read the current shop job's supply list and confirm every
line OP pushed is still present at the expected quantity, and that the job is still at
status ≥ 5. One call, and it catches accidental deletion, an accidental check-in and a
status regression together — all three being symptoms of "something released our stock".

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

1. **Verify the unknowns in §18 against a scratch job.** Nothing else starts first.
   *Mostly done Sep 2026 — see §2.1. `backend/src/scripts/shop-stock-probe.ts` settles what
   remains; delete it once the push code lands.*
2. ✅ **SHIPPED Sep 2026.** Migration `235_shop_stock_cache.sql` +
   `services/shop-stock.ts` + a 15-minute scheduler refresh (and one at startup).
   Read-only, so it could ship ahead of the open questions. **Note what this step is not:** the
   mirror is stock and prices only. The running tally that ends the "where's the missing £24"
   drift is the `shop_sales` ledger plus the balance invariant (§9) — steps 4, 6 and 9. And
   it only ever covers sales made *through OP*; it prevents future drift, it does not find
   historic drift in the existing weekly jobs.
3. Sitter price lookup in the freelancer portal. Smallest thing that removes a daily pain.
4. ✅ **SHIPPED Sep 2026.** `shop_sales` / `shop_sale_lines` / `shop_sale_periods`
   (migration 240) + `services/shop-sales.ts` + `routes/shop.ts` + `ShopTillPage`.
   Saves to Postgres only — no HireHop writes yet.
   **⚠️ Rows land `status = 'queued'`. When the drain ships (step 5) it picks up
   anything still queued, so TEST ROWS MUST BE CANCELLED before that deploy** or
   they will push real lines and real money.
5. ✅ **SHIPPED Sep 2026 (consumption only).** `services/shop-drain.ts` + a
   2-minute scheduler pass + `POST /shop/drain` to force one. Idempotent at LINE
   level: `hh_tally_id` is written the moment an adjustment exists and a line
   that has one is skipped, so a crash between HireHop accepting and the row
   being marked cannot double-decrement. Bounded retries (migration 241) — a row
   HireHop will never accept goes `failed` rather than retrying forever.
6. ✅ **SHIPPED Sep 2026.** `services/shop-period.ts` creates the weekly HireHop
   job (Mon 00:01 → Sun 23:59, DISPATCHED, verified by read-back); §3.0's sync
   exclusion guards both `hirehop-job-sync.ts` and the inbound webhook; and
   `drainShopSales()` pushes lines (`a<id>`, one call, line id read from the
   response) then the deposit via `pushDepositToHH`.
   **Lines first, money last, deliberately:** if the payment fails the lines are
   already recorded against `hh_line_id` and the retry skips them, so a second
   attempt cannot double-sell. The reverse order could take payment for stock
   that never left the shelf. ⚠️ **Not yet exercised with a real sale — see §19.**
7. ✅ **SHIPPED Sep 2026 (staff till).** Job routing — see §19. The sitter till's
   phone picker (§5) is deferred with the rest of the sitter till.
8. ✅ **SHIPPED Sep 2026.** Reversals — Windows A and B, verified live.
9. ✅ **SHIPPED Sep 2026.** Weekly view, balance check + alarms, needs-attention list,
   reorder list — see §19. The sitter review list waits for the sitter till.
10. ✅ **SHIPPED Sep 2026** with the sitter till — see §19.
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

**The probe:** `backend/src/scripts/shop-stock-probe.ts` answers what a UI capture cannot —
whether OUR token and OUR codepath reproduce what the HireHop UI does. Reads run
unconditionally; the two writes need `--write`. One-shot, like
`hh-deposit-release-probe.ts`; delete it once the push code lands.

```
cd backend
npx tsx src/scripts/shop-stock-probe.ts --job=16735 --stock=25            # reads only
npx tsx src/scripts/shop-stock-probe.ts --job=16735 --stock=25 --write    # full
```

**SETTLED** (scratch job 16735, Sep 2026 — see §2.1 for the full table): the sale-stock
prefix is `a<id>`, sale lines are `kind: 1`, tally `qty` is negative-to-consume, removing a
line restores the shelf count, and a line arrives already priced from stock.

**SETTLED by the write probe, 23 Sep 2026:**

1. ✅ **`save_job.php` accepts `items: {"a25": 1}`.** The `a` prefix works on our token
   and our proven codepath. §6.1 stands; no need for `items_batch_save.php`. Better than
   hoped — the response carries the created line, so it is one call, not four (§2.6).
2. ✅ The line comes back `kind: 1`, `LIST_ID: 25`, `UNIT_PRICE: 7.50`, `ACC_NOMINAL: 6`,
   `CATEGORY_ID: 338`, and `avail` drops cumulatively (14 → 13 on the second line).

**STILL OPEN:**

3. ✅ **SETTLED — how to remove a sale line.** Captured verbatim from the HireHop UI,
   23 Sep 2026:

   ```
   POST /php_functions/items_delete.php
     ids             = b9154     ← a BARE string, NOT a JSON array
     job             = 16735
     arch            =           ← archive flag; empty means delete rather than archive
     no_availability = 0
   ```

   **Two traps in one payload.** It is not a `delete:` key on `save_job.php` (that
   returned `success: true` and did nothing — §2.5), and `ids` is a plain string, so
   `JSON.stringify([...])` would have been ignored the same silent way. `b` prefixes a
   supply-list LINE id here, a different namespace from the `a`/`b` picklist scheme used
   to add.

   **Nothing now blocks the push code.**

Lower-risk: whether a tally adjustment can carry a job reference. The response exposes
`JOB` and `REPAIR`, but the documented send parameters don't include them — and both
verified calls came back `JOB: 0`. If it can't, the job reference goes in the `details`
string and that's fine.

**`MAX_DISCOUNT` audit (§17).** Confirmed 100 on the item tested. Still worth a full sweep
once the mirror lands — it costs one query, and any item below 100 means today's
100%-discount workaround has been silently failing on it.

---

## 19. Current state — START HERE

### Live and working

| | |
|---|---|
| **Catalogue mirror** | `shop_stock_cache`, refreshed every 15 min + at boot. 974 items. Till search makes ZERO HireHop calls. |
| **Till** | `/money/shop`. Search, basket, per-line discount with role ceilings, VAT, tender. Two columns on a laptop (basket left, checkout right); stacks on a phone. |
| **Internal consumption** | "Used for Ooosh" → HireHop stock adjustment via `tally_save.php`. Verified moving real stock. |
| **Sale push** | Lines onto the weekly job via `save_job.php` + deposit via `pushDepositToHH`. **Verified live 24 Sep** — list price AND discounted (the `items_save.php` override), shelf count dropped, cash reached HireHop and Xero. |
| **Sale numbers** | `OT-SHOP-00100` onwards (`services/shop-sale-ref.ts`). On the deposit: description `16750 - shop sale`, memo `Shop sale 24/09/2026 via cash (Ref: OT-SHOP-00101) — note (recorded via Ooosh OP)`. Migration 247 numbered the pre-existing test sales 100 and 101. |
| **Cancel (Window A)** | Recent Sales → Cancel, any staff. Runs inside the drain lock; refused once any line or deposit has reached HireHop (judged on the HH ids, not the status). |
| **Refund (Window B)** | Recent Sales → Refund, `MANAGER_ROLES`. Whole sale. Creates a `kind='reversal'` row; the drain (kicked immediately) first stops if the job has ANY invoice (`billing_list` `kind = 1`) — Window C, a credit note by hand — then checks the deposit is still unallocated, removes each line via `items_delete.php` (read back), then refunds against the deposit via `refundDepositOnHH` (re-read that the money moved). A "their bill" sale has no deposit: its refund only removes the line and settles itself. **Verified live 24 Sep** on the test sales (line removed, stock back, refund in HireHop and Xero). |
| **Refund outstanding** | The physical money back is manual until Stripe. **Cash and card** (`COUNTER_REFUND_TENDERS`) are handed back there and then, so the Refund button — *"Done — £x given back"* — is the confirmation and the refund is settled on creation. **Bank transfer, PayPal, Stripe** happen later from another screen, so those show "Refund outstanding" until someone presses *Done — they have it*. |
| **Job routing (step 7)** | Checkout → *Who's it for?*: **Walk-in** (the week's shop job), the bands **In today** (`GET /shop/jobs/today` — rehearsal jobs whose session dates cover today, from the same `rehearsal_detail` the sitter roster uses; two bands in = two buttons), or **Other job…** (search by HH number / band / client). Payment on a job: paid now (a deposit on THEIR job) or **Put it on their bill** (`invoice_later`, no deposit — only offered once a job is chosen, and reset if the route goes back to walk-in). Cancelled / lost / completed / internal jobs are refused at the counter (`shop-routing.ts assertSellableJob`); a job LOCKED or closed in HireHop is caught by the drain before any line is pushed, and the sale goes `failed` with "cancel and ring it as a walk-in". **Stock:** a line added to a dispatched OR returned job consumes immediately (jon verified the returned case on job 16749); rehearsal jobs are dispatched like any other, so there is no "not yet dispatched" warning. Checking a sale line in at return puts the stock back — a human-error gap code can't close. |
| **Till page layout (step 9)** | The till on top; everything else folded into one tab row at the bottom — *Recent sales · Needs attention (n) · This week · What we've used · Reorder* (jon, Sep 2026: 9 in 10 visits need none of it). Last tab used is remembered per browser; clicking the open tab folds it. Payment-method labels live in `frontend/src/lib/shopTenders.ts`. |
| **Balance check (step 9)** | `services/shop-reconcile.ts`. Compares each un-invoiced week's shop job with OP's OWN record, three ways: **goods** (OP's ex-VAT line total vs billing `kind = 0` `accrued`), **money** (OP's takings less refunds vs the deposits' unallocated balances; skipped once invoiced), **lines** (every pushed, un-removed line still on the job) — plus job status ≥ 5 and not 9/10. Exact to the penny (no VAT rounding) and it names which side broke. Runs inside the drain lock. First sight of an invoice on the job sets `invoiced_at` — **closing the old "OP never knows the week was invoiced" gap**. Result stored on the period (migration 248); *This week* shows it with *Check now*. **Cannot see a sale line checked in by mistake** — the line stays, only the shelf moves. |
| **Alarms (step 9)** | Scanner every 15 min → email **jon only** (jon, Sep 2026): a week that doesn't match (once per distinct problem — `alert_signature`; cleared when it balances), and failed / stuck-30-min transactions (once each — `stuck_alerted_at`, reset by Retry). |
| **Sitter till (§5)** | Freelancer portal (the Next.js app in `src/`, Netlify): `/shift/[date]/till`, linked from the shift page. Price lookup any time the sitter can see the shift; selling only while the night is OPEN (its date, or until 06:00 next morning). Walk-in or tonight's bands (from the shift itself); tenders mirror the staff till (`services/shop-tenders.ts` — ⚠️ update it AND `frontend/src/lib/shopTenders.ts` when the Stripe terminal replaces Worldpay); list price only (freelancer cap 0%, and the route never takes a price from the phone). A sitter can cancel their own sale inside the hold; refunds are the office's. OP side: `/api/portal/studio-sitter/shifts/:date/till/*` behind the same rostered-to-this-evening gate as the lock-up; portal side: one whitelisted catch-all proxy. Sitters are `people`, so a sale records `recorded_by_person_id` + `shift_id` (migration 251; `recorded_by` → users is now optional, a CHECK keeps one set). |
| **Sitter review** | Every sitter sale is `needs_review`. Staff tick them off on the till's **Sitter sales** tab (`/money/shop?tab=review` — `?tab=` opens any tab). Linked from the staff lock-up report ("N to review →") and the handover-thread summary. Reminder email after `shop_review_reminder_hours` (12) to `shop_review_reminder_to` (info@), once per sale. |
| **Lock-up report (step 10)** | Sitter's lock-up page shows "Shop till tonight: N sales · £x taken" by tender; the submitted summary in the handover thread gets a 🛒 line; the staff report view shows it with the review link. Template item "Have the clients paid?" became **"Any money outstanding?"** (new id `money_outstanding`, expected "no" — migration 251 swaps it only if the seeded item was untouched). |
| **Drain lock** | `withShopDrainLock` — the scheduler and `POST /shop/drain` used to be able to push the same sale twice at once. Now serialised. |
| **Weekly job** | Created on demand, Mon 00:01→Sun 23:59, DISPATCHED. Live one is **16750**. |
| **Sync exclusion** | Shop jobs never enter OP's `jobs` table — bulk sync and webhook both guarded. |
| **Availability** | Free-vs-reserved on basket items, via `picklist_get_availability.php`. |
| **Stock usage** | `GET /shop/consumption` + a panel on the till. |

### Settings (all in `system_settings`, category `shop`)

| Key | Live value |
|---|---|
| `shop_job_client_id` | `3067` (OP Shop Sales) |
| `shop_job_contact_name` | `OP Shop Sales` |
| `shop_job_name_pattern` | `Shop Sales W/C {date}` |
| `shop_availability_job` | `16750` |
| `shop_excluded_category_ids` | `[355]` (Misc Sale Item) |
| `shop_vat_rate_map` | `{"0":20,"1":0,"2":5}` |
| `shop_discount_caps` | admin 100 / manager 50 / staff + GA 10 / freelancer 0 |
| `shop_push_hold_seconds` | `120` (Window A) |
| `shop_push_max_attempts` | `5` |

### THE FIRST THING TO DO NEXT

**Exercise the sitter till live.** jon: create yourself as a sitter, roster yourself on a
scratch rehearsal job for tonight, then on your phone:

1. shift page → *Shop till* → look up an item (price lookup);
2. sell one **walk-in, cash** → lands on the weekly shop job, drains like any sale;
3. sell one **on the band's bill** → lands on the band's job, no deposit;
4. cancel a third inside its 2 minutes;
5. lock-up page shows the takings; submit → the handover thread has the 🛒 line;
6. OP: the till's *Sitter sales* tab lists 2, the lock-up report links to it; tick them;
7. check the lock-up checklist now asks "Any money outstanding?" (if it still says
   "Have the clients paid?", the template had been edited — change it in Settings).

### Then, in order

10. Lock-up report integration (§5).
11. Receipts (§2.10) — **accountant confirmed Sep 2026** that a VAT receipt is fine:
    it is a record of sale and is not pushed to Xero. Number = the sale's `OT-SHOP-#####`.
12. Gate manual payment entry in HireHop (§0) — last, and only once staff trust the till.
13. Line-by-line refunds (see gaps below) — jon, Sep 2026: last.
    Also still to come: the sitter till in the freelancer portal (§5), with the same
    "in today" picker on a phone.

### Known gaps and decisions still open

- **Raising the weekly invoice is still manual in HireHop.** OP now notices
  (the 15-min check sets `invoiced_at` when an invoice appears) and refunds stop
  on an invoiced job, but OP does not raise it.
- **Partial refunds** (one item out of a basket) are "refund all, ring the rest
  again". Whole-line returns are cheap (the proven `items_delete.php` + a partial
  refund). Part-of-a-line (bought 3, return 1) needs `items_save.php` with a lower
  qty, and whether that releases one unit on a DISPATCHED job must be tested on a
  scratch job first. **jon, Sep 2026: last on the to-do list.**
- **Swaps** are a return plus a new sale at the matched price (jon, Sep 2026) — no
  dedicated feature.
- **Reversing a consumption** ("used for Ooosh" logged against the wrong item) is not
  built — it would be a positive `tally_save` adjustment. Cancel inside the hold covers
  the common mistake.
- **A sanity check on the OP Shop Sales contact** — alarm if its name or
  address changes. The old contact's address was edited to raise ad-hoc
  invoices, and that is a known incident rather than a hypothetical (§6.0).
- **Negative shelf counts** exist in HireHop (cold drinks read −469) because
  consumables were never booked in. Not this module's doing; it will display
  them, which looks broken. A stock-take is jon's.
- **Category exclusions do not cascade** to sub-categories (§2.4).
- **Recent Sales needs filters and search** as volume grows — deferred (jon, Sep 2026).
- **`thetour.store`** remains parked (§16).

### The three rules a newcomer must not break

1. **A stock movement is EITHER a job line OR a tally adjustment, never both**
   (§2). Silent if wrong.
2. **`success: true` does not mean HireHop did it** (§2.5). Verify by reading
   back. This has bitten twice.
3. **Capture a HireHop payload from its own UI before writing to a new
   endpoint** (§2.9). Four endpoints so far have not matched their docs — and
   once, the docs were right and I had misread them.
