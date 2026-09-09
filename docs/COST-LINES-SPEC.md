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

**1. `amount_gross` is authoritative; VAT is derived.** *(Amended 10 Sep 2026 — the
original said the whole header was authoritative.)* The gross is what we owe and what we
pay; it is typed by a human off the invoice, and nothing — not the AI, not a line edit —
may write it. **VAT is not part of what we owe, it is an analysis of it.** Requiring it to
be typed on the header AND on every line created two figures that could disagree, and a
save that failed with "the gross balances but the VAT doesn't" — a confusing state with no
good fix. So a cost WITH lines takes its `amount_vat` (and hence `amount_net`) from them,
via `headerVatFromLines()`, applied server-side on write so the header can never disagree
with its own lines whatever a caller sends. With no lines nothing changes: the header's
own VAT mode decides, exactly as before.

**2. ONE balance rule: lines must sum to the invoice total, within 1p.**
`SUM(lines.amount_gross)` must equal `costs.amount_gross` to within £0.01, or the save is
**rejected** with the difference named. There is deliberately no second VAT check — under
invariant 1 there is nothing for the VAT to disagree with. **Agreed: reject the lot.** Saving an unbalanced cost just defers the
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

So the cost of getting VAT right here is: one column (`amount_vat` on the line), a function
that takes `{amount_vat, amount_net}` instead of a whole `CostRow`, and a rate picker in
the UI. Cheap, and it closes a live accounting error rather than deferring one.

**How it's entered (10 Sep 2026).** A line states an amount **inclusive of VAT** plus a
**rate** — No VAT / 20% / 5% / Manual £ — not two money boxes. Two boxes said nothing about
whether the total included the VAT, and sat next to a header that used a mode *toggle* for
the same idea: two mental models on one screen. A rate is how Xero and every other
accounting package does it, it's one fewer figure to type, and it makes the header's own
VAT toggle legible as what it always was — the default rate for the whole invoice, which a
line may override. The rate itself is NOT stored: `amount_vat` is what gets written and
pushed, and reopening a cost infers the rate back from `(gross, vat)` — the same trick
`inferVatMode` already uses for the header, and it avoids a column that would only ever
restore a dropdown.

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

Built inside the existing capture/edit modal, which was regrouped at the same time into
four labelled sections — **The invoice** (supplier · invoice date · invoice number + due
date · amounts) · **What it was for** (category, lines, description) · **Where it goes**
(job, quote intent, recharge, vehicle) · **How it's paid** (method, status, notes). It was
thirteen unlabelled blocks in a flat column; the problem was grouping, not space, which is
why this is sections rather than a wizard — the receipt sits in the left pane throughout,
and paging the form would hide fields behind clicks without reducing what has to be read.

- Costs open with **no lines** and look exactly as they did. "Split into lines" seeds line 1
  holding the whole invoice plus an empty second row, so splitting is "take some off this,
  put it on that" rather than typing everything twice. A blank trailing row is dropped on
  save rather than being an error.
- **Lines sit directly under the category picker, which sits directly under Amounts.** They
  can't go above the category: a line's category dropdown reads "Same category as above",
  and "above" is that picker.
- Each line is **two rows**, not one — description across the top, then amount / rate /
  category / fronted / delete. The form pane is only ~500px beside the receipt and six
  controls in one row there is unreadable.
- The header's Amounts box shows **"VAT comes from the lines below"** in place of its mode
  toggle when lines exist, with VAT and net read-only. The total stays editable — it's the
  one figure lines may not touch.
- A running **"£X of £Y"** goes red when it doesn't balance and names what's missing; save
  is blocked and closing the modal warns that nothing will be saved, receipt included.
- Still to come (PR 2): a count badge on the Costs hub table — no new column, the table must
  fit the viewport; and Money-tab Actuals buckets fed from lines, with `crew_fronted`
  populating the **Fronted expenses** bucket left open in Sep 2026.

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
