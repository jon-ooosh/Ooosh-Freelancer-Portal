# Cost Lines — Implementation Spec

**Status:** Agreed 9 Sep 2026 (§11 records the answers). PR 1 built; PR 2 not started.
**Branch:** `claude/receipt-uploader-tweaks-81g0z8`
**Depends on:** cost capture ✓, `cost_allocations` ✓, Xero push ✓, receipt AI extraction ✓
**Extends:** `docs/COST-CAPTURE-RECHARGE-SPEC.md` (which mentions `cost_lines` twice as "a separate piece of work" — this is that work)

---

## 1. The problem

One payable often covers several different things.

> Josh Law invoices £250.30. It's £190 of driver fee, £40 of fuel he put in the van at
> Chelsea, and £20.30 of parking. One invoice, one payment, one Xero bill.

Today OP models that as a single cost with a single category. Pick `320 Freelance crew
invoices` and the whole £250.30 is crew cost. Pick `410 Fuel` and none of it is. There is
no right answer, so staff pick the biggest component and the rest is quietly wrong.

Three things break as a result:

1. **Expected-vs-actual on the Money tab is blunt.** The Actuals card (Sep 2026) groups by
   `xero_account_code`, so the whole £250.30 lands under Freelancer even though £60 of it
   should sit against the job's expected fuel. The variance is right in total and wrong in
   every bucket.
2. **Job attribution is all-or-nothing per cost.** `cost_allocations` splits a cost across
   *jobs*, but only by amount — it can't say "the fuel part belongs to job A and the fee
   part to job B", and it carries no category at all.
3. **The Xero bill is one line.** The bookkeeper sees £250.30 against 320 and has to
   re-split it by hand, which is exactly the manual step the cost-capture project set out
   to delete.

`cost_lines` breaks one payable into N lines, each with its own amount, category and
(optionally) job.

---

## 2. What this deliberately does NOT solve

Worth stating up front so we don't expect the wrong things of it.

- **It does not record who fronted the money.** "Fronted expenses" on a quote means *the
  crew laid this out and reclaims it* — a fact about who paid, not about what was bought.
  A category never carries that: a freelancer's £40 parking receipt is coded `411`
  exactly like parking on the company card, `supplier_name` is free text with no person
  link, and `cost_type = 'freelancer_invoice'` is derived from category 320 so it's a
  "this is a crew fee" flag, not a "this supplier is a freelancer" flag. **Lines close
  this only because we add a flag for it** — see `crew_fronted` in §3.
- **It does not make recharge line-level.** Recharge stays a property of the whole cost in
  v1 (§6).
- **It does not retro-fit anything.** No backfill, no migration of existing costs. A cost
  with no lines behaves exactly as it does today, forever.

---

## 3. The shape

```sql
CREATE TABLE cost_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_id           UUID NOT NULL REFERENCES costs(id) ON DELETE CASCADE,
  line_no           SMALLINT NOT NULL,              -- display order, 1-based
  description       TEXT,
  amount_gross      NUMERIC(12,2) NOT NULL,
  amount_vat        NUMERIC(12,2) NOT NULL DEFAULT 0,
  xero_account_code VARCHAR(20),                    -- NULL → inherit costs.xero_account_code
  job_id            UUID REFERENCES jobs(id),       -- NULL → inherit costs.job_id
  crew_fronted      BOOLEAN NOT NULL DEFAULT FALSE, -- crew laid this out and reclaims it
  source            VARCHAR(10) NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('manual', 'ai')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cost_id, line_no)
);
CREATE INDEX idx_cost_lines_cost ON cost_lines (cost_id);
CREATE INDEX idx_cost_lines_job  ON cost_lines (job_id) WHERE job_id IS NOT NULL;
```

Notes on the columns that aren't obvious:

- **`amount_gross` + `amount_vat` per line; no separate net** (net is gross − VAT). Per-line
  VAT is what makes a mixed-rate invoice push correctly — see §5, it is the whole point.
- **NULL means inherit, not "unknown".** A line with no code or no job takes the cost's.
  This keeps the common shape short: two lines on a freelancer invoice need only an amount
  and a code each.
- **`crew_fronted`** is the one genuinely new fact, and the reason the Money tab can grow a
  real "Fronted expenses" actuals bucket. Default `false`. The capture modal should default
  it to `true` for any non-320 line on a `freelancer_invoice` cost — the common case, and
  correctable in one click.
- **`source`** says whether a line was typed or proposed by the AI. Optional, but it's one
  column and it's the only way we'll ever know whether the AI splitting is worth keeping.
  Drop it if you'd rather not.

---

## 4. Invariants

These are the load-bearing rules. Everything else is UI.

**1. The header stays authoritative.** `costs.amount_gross` / `amount_net` / `amount_vat`
are what we owe and what we pay. Lines describe how that total breaks down; they never
determine it. Nothing — not the AI, not a line edit — may write the header total.

**2. Lines must sum to the header, within 1p — on gross AND on VAT.** On save,
`SUM(lines.amount_gross)` must equal `costs.amount_gross` and `SUM(lines.amount_vat)` must
equal `costs.amount_vat`, each to within £0.01. Outside that, the save is **rejected** with
the difference named. **Agreed: reject the lot.** Saving an unbalanced cost just defers the
problem onto whoever finds it later, unflagged, with no owner. Corollary the UI owes the
user: closing the modal on an unbalanced split must warn plainly that **nothing will be
saved and the receipt will not be uploaded** — the one way this rule could quietly cost
someone their work.

**3. The 1p residue is absorbed at push time, on the largest line, and is never stored.**
Three-way splits of an odd total don't divide cleanly. The stored lines stay exactly as
typed; `buildCostLineItems` adds the residue to the largest line as it builds the Xero
payload, so the bill always foots to the header.

**4. Allocations are DERIVED from lines, never entered alongside them.** See §7.

**5. No lines = today's behaviour, byte for byte.** Every existing query, push and screen
must be untouched for a cost with zero lines. This is what makes the feature safe to ship
without a backfill.

**6. `vat_treatment = 'reclaim_split'` may not have lines in v1.** That path builds its own
3-line Exclusive structure in `buildCostLineItems` (net @ No VAT, vat/0.2 @ 20%, −vat/0.2 @
No VAT), all on one account code. Mixing user lines into it is a genuine design problem, not
a coding one, and insurance-claim invoices are not the case we're solving. The UI hides the
add-line control; the API rejects lines on such a cost.

**7. Lines are locked once the Xero object is reconciled.** `xero_sync_state = 'reconciled'`
→ read-only, no additions, no edits. A reconciled Xero object cannot be mutated, so an OP
edit would silently diverge from the books.

**8. Editing lines on an already-pushed cost sets `xero_stale = TRUE`.** Same mechanism as
migration 147 — flag it, warn in the UI, offer the manual "Re-sync to Xero". Never re-push
silently.

---

## 5. VAT — per line, and this is the strongest argument for the feature

**Per-line VAT is not a v2 nicety. It is the case `docs/COST-CAPTURE-RECHARGE-SPEC.md`
already filed under this work**, twice ("splitting a payable into differently-coded /
differently-VAT-rated lines is a separate piece of work (`cost_lines`)", and the worked
£325 example: labour £250 no-VAT, fuel £50 + £10 VAT, train £15 zero-rated).

**Today that example books the VAT badly wrong, and it's worth seeing why.**
`resolveLineTaxType` derives a rate from the header: `round(vat / net × 100)`. On the £325
invoice that is `round(10 / 315 × 100)` = **3%** — a blended figure that is not a real VAT
rate at all. `getPurchaseTaxType(3)` finds nothing, returns undefined, and Xero falls back
to the account's own default of 20% on the whole £325 inclusive line. We book **£54.17** of
VAT where the true figure is **£10**.

Header-level VAT can only ever produce that blend. Line-level VAT produces real rates,
because each line is homogeneous:

| Line | Gross | VAT | Derived rate | Xero TaxType |
|---|---|---|---|---|
| Driver fee | £250.00 | £0.00 | — | `NONE` |
| Fuel | £60.00 | £10.00 | 20% | 20% purchase |
| Train | £15.00 | £0.00 | — | `NONE` |
| **Total** | **£325.00** | **£10.00** | | |

The push stays `lineAmountTypes: 'Inclusive'`; each line simply resolves its own tax type
through the *same* `resolveLineTaxType` logic, fed the line's figures instead of the
header's. That is a two-line generalisation of an existing function, not new machinery.

So the cost of getting VAT right here is: one column (`amount_vat` on the line), one extra
balance check (§4.2), one extra input in the UI, and a function that takes `{amount_vat,
amount_net}` instead of a whole `CostRow`. Cheap, and it closes a live accounting error
rather than deferring one.

---

## 6. Recharge

**v1: recharge stays a property of the cost, not the line.** `recharge_mode` /
`recharge_amount` / `recharge_status` are unchanged and continue to apply to the whole cost.

The temptation is to make recharge per-line ("recharge the fuel, absorb the fee"), and that
is probably right eventually. It is not v1, because the recharge lifecycle (pending →
resolved, the HH push, the post-hire card, `recharge_running_costs` auto-inherit) is a whole
second machine and coupling it to lines in the same change doubles the surface area of the
first release. `recharge_amount` on a `partial` recharge already gives staff the escape
hatch: split the invoice into lines for accounting, and set the recharge amount to the
fuel portion.

---

## 7. Derived allocations

`cost_allocations` stays THE job-attribution table. `/costs/by-job/:jobId` keeps its two
arms and gains no third. Instead, saving lines **writes real allocation rows**, so every
existing reader works untouched.

Derivation, run in the same transaction as a line save:

1. Resolve each line's job as `COALESCE(line.job_id, costs.job_id)`. A line with no job on a
   job-linked cost belongs to that cost's job — never to nothing. *(Without this, an
   unassigned line would silently vanish from every job view.)*
2. Group by resolved job, sum `amount_gross`.
3. **If the lines resolve to exactly one distinct job (or none), write NO allocations.** The
   cost stays on arm A of `/by-job` and behaves precisely as it does today. Writing a single
   self-referential allocation would flip it to arm B and render it as "· split from #N"
   pointing at its own job — same money, nonsense label.
4. If they resolve to two or more, replace the cost's allocations with one row per job.
   `recharge` on each row follows the cost's `recharge_mode` as it does now; `notes` records
   that it was derived.

**Precedence.** Once a cost has lines, the lines own the split: the existing split modal
goes read-only for that cost and points at the lines editor. A cost that already has
hand-made allocations and then gains lines must have the lines reconciled against them —
the safe move is to refuse to add lines to a cost with manual allocations until they're
cleared, and say so. *(Open question — see §11.)*

Under-allocation stays legal, as it is today: allocations summing to less than the header is
"the rest is ours", not an error.

---

## 8. Xero push

One change, in `buildCostLineItems` (`services/cost-xero-push.ts`), standard branch only:

```
if (lines.length === 0)  → today's single inclusive line (unchanged)
else                     → one XeroLineItem per cost line:
                             Description = line.description || cost description
                             UnitAmount  = line.amount_gross (+ residue on the largest)
                             AccountCode = line.xero_account_code || cost.xero_account_code
                             TaxType     = resolveLineTaxType(line)   // per line — §5
```

`resolveLineTaxType` currently takes a whole `CostRow` but only reads `amount_vat` and
`amount_net`. Narrow its parameter to `{ amount_vat, amount_net }` and it serves both the
header (unchanged behaviour) and a line, with no duplicated rate logic.

`lineAmountTypes` stays `'Inclusive'`. Both flows (Bill and Spend Money) call this one
builder, so both inherit lines for free. Attachments, references, the advisory lock and the
`post_payment` step are all untouched.

---

## 9. The AI's role — and its limits

The extractor (`services/cost-receipt-extract.ts`, Claude Haiku 4.5 with a cached system
prompt) already returns a header plus one `category_code`. Extending it: add an optional
`lines` array to `SCHEMA` — `{ description, amount_gross, amount_vat, category_code }` per line.

**What it can genuinely do:** read a document that *prints* line items — a garage bill, an
equipment order, an itemised sub-hire — and propose the split.

**What it cannot do, and must not be asked to do:** invent a split that isn't written down.
The case we most want solved — a freelancer invoice reading *"Driver services, Chelsea,
3 days — £250"* — has no lines on it. There is nothing to extract. The AI must return one
line (or none) and the human splits it by hand. **The manual split UI is the load-bearing
part of this feature; the AI pre-fill is sugar on top.** If we build it the other way round
we'll ship something that guesses.

Guards, all of which belong in the prompt AND in server-side validation:

- **Never touch the header total.** Lines are a proposal against a total the human confirms.
- **Only emit more than one line when the document itemises.** Ambiguous → one line.
- **Bundle printed items that share BOTH an account code and a VAT rate into one line.** An
  invoice listing a train, a taxi and a flight is one `325 Travel` line, not three: nothing
  downstream distinguishes them (Xero gets one code and one rate; the Money-tab buckets group
  by code), so three lines is noise. The test is mechanical — same code AND same VAT — never
  "these feel like the same sort of thing". Two travel items at different VAT rates stay
  apart, because bundling them is exactly the blended-rate error in §5. The bundled line's
  description names its parts ("Travel: train, taxi, flight") so a human can split it back
  out without re-reading the invoice.
- **The lines must sum to `amount_gross` AND to `amount_vat`.** If they don't, discard the lines and return the
  header alone rather than adjusting either side to fit. A silently-adjusted total is worse
  than no split.
- Lines arrive as `source = 'ai'` and are visibly marked as unreviewed until touched.

---

## 10. UI

Minimum viable, inside the existing capture/edit modal:

- Costs open with **no lines** and look exactly as they do now. A single "Split this cost
  into lines" control adds line 1 pre-filled with the full amount + the cost's category.
- Each line: description, amount, VAT (defaults to 0 — most lines have none), category
  picker (the existing `COST_CATEGORIES` list), optional job picker, a "crew fronted this"
  checkbox.
- A running **"lines total £X of £Y · VAT £A of £B"** with either difference called out in
  red when it doesn't balance. The save button is disabled while it doesn't (per invariant 2).
- On the Costs hub table, a cost with lines gets a small count badge — no new column
  (the costs table must fit the viewport; adding a column means folding another one in).
- On the Money tab, lines feed the Actuals buckets directly instead of the header code, and
  `crew_fronted` lines populate the **Fronted expenses** bucket — closing the gap left open
  in Sep 2026.

---

## 11. Decisions (answered 9 Sep 2026)

1. **Unbalanced lines → reject the save.** "Otherwise it's just an unflagged stale problem
   sitting there." Plus the close-the-modal warning, now written into §4.2.
2. **A cost with a hand-made split refuses lines** until the split is cleared. As specced.
3. **The AI reads only what's printed** — no narrative inference. It *may* bundle printed
   items that share a code and a VAT rate into one line (§9).
4. **Recharge stays cost-level in v1** (§6) — no strong preference either way, so the
   smaller change wins.


---

## 12. Build order

**PR 1 — the vertical slice** (BUILT, migration 205), so it can actually be tested rather than trusted:

1. Migration + `cost_lines` table.
2. Read/write endpoints, with the balance rules of §4.
3. Xero push: lines → multi-line bill with per-line tax types (§5, §8).
4. Capture-modal lines UI (§10).

One thing PR 1 changed from this spec as written: the standalone `PUT /:id/lines`
was built and then removed. Lines have to be written in the SAME request as the
header, because the create route fires `pushCostToXeroBackground` immediately
after the INSERT — a second round-trip races it onto a one-line bill. One write
path also means the guards (reclaim, existing manual split, reconciled lock)
can't drift between two callers.

**PR 2 — the consumers**, once real invoices have been split by hand:

5. Derived allocations (§7).
6. Money-tab buckets from lines, incl. the `crew_fronted` Fronted bucket.
7. AI `lines` extraction (§9) — deliberately last, once the manual path is proven.

**Reminder:** the migration runner has a hardcoded file list in
`backend/src/migrations/run.ts`. Take the next free number at build time.
