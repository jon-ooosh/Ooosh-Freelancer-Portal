# Post-Hire Expense Recharge — Spec

**Status:** Scoped with jon (Jun 2026) → ready to build. No code yet.
**Builds on:** the recharge resolution lifecycle (`COST-CAPTURE-RECHARGE-SPEC.md` §"Phase D" — `recharge_status`, markup engine, `cost_resolve` close-out card). This is the *declared, forward-looking* half of that work.
**Touches:** the Crew & Transport calculator (`services/crew-transport-calculator.ts`, `frontend/.../TransportCalculator.tsx`, `routes/quotes.ts`), the cost-capture flow (`routes/costs.ts`), the V&D / soft book-out (`docs/VAN-SWAP-AND-SOFT-CHECKIN-SPEC.md`, `routes/vehicles.ts`), and the freelancer portal (Next.js, in-repo at `src/app/...`).

---

## The problem

Some jobs are "we supply a van + driver, and bill all the running costs back afterwards" — the classic being an **open-ended runner job**: the client doesn't know where the runner will be sent, so the clean deal is *pay for the van & driver, we recharge all fuel / parking / tolls post-hire*. We know **at quote time** that there will be recharges; we just don't know the amounts yet.

Today recharge is **reactive**: a cost lands → someone flags it → it surfaces (the Phase D lifecycle). There's no way to **declare up front** "this job recharges its running costs", so:
- staff checking the van back in (half a tank of fuel) have no signal that the gap is billable;
- the freelancer's fuel/parking invoice two days later isn't obviously "recharge this";
- there's no standing prompt that costs are *expected but not yet arrived* (the long-standing "chase freelancers for unsubmitted invoices" gripe);
- **who's paying the Per Diem** — a constant source of confusion — is never explicitly captured.

## The mechanism: three-state expense lines

The Crew & Transport calculator already has an **Expenses ticklist** (Fuel / Parking / Tolls / Transport out / Transport back / Hotel / Per Diem / + custom) with a binary `included` checkbox ("Check to include in quote. Unchecked = client pays separately."). Replace that binary with a **three-state selector per line**:

| State | `charge_mode` | Client billing | In quote total? |
|---|---|---|---|
| **Included in our quote** | `included` | Fixed, billed now at the quoted figure | Yes |
| **Not included** | `not_included` | Client sorts it separately — not our money | No |
| **Recharge post-hire** | `recharge` | We (or the freelancer on our behalf) incur it; client billed the **actual + markup** after the hire | **No** — itemised separately as "plus running costs at actual" |

**Move** the "Check to include / unchecked = client pays separately" helper text down into the Expenses section and reword it for the three states (it currently sits above an unrelated block).

**The amount on a `recharge` line is an *estimate*, not a charge.** Staff can still type the calculator's auto-figure (or a better guess) — it's shown to the client as indicative ("fuel ~£60, recharged at actual + 20%") and seeds the expected-vs-actual tracking. The client is billed the **real** figure after, never the estimate. Recharge lines stay **out of the headline quote total** so the fixed price stays honest.

> **Out of scope (jon, Jun 2026):** the "we only charged £20 for fuel but it came back £60" case is a *mis-quote* concern (decide to eat it or recharge the difference), NOT this module. Parked.

### Data model

- `QuoteExpenseItem.charge_mode: 'included' | 'not_included' | 'recharge'` — replaces `included: boolean`. `expenses` is a JSONB array on `quotes`, so **no migration for the expense shape**; just the shared type, the calculator's expense maths (`crew-transport-calculator.ts` — `recharge` lines excluded from `client_charge_expenses` / total, surfaced in a new `recharge_expenses` breakdown), and the UI. Keep reading legacy `included` as `charge_mode = included ? 'included' : 'not_included'` for back-compat.
- **Migration 151** — `jobs.recharge_running_costs BOOLEAN NOT NULL DEFAULT FALSE` (+ `recharge_running_costs_note TEXT`). The canonical "this job recharges running costs" flag. Set TRUE automatically whenever a quote on the job declares any `charge_mode='recharge'` line, OR manually via the lightweight toggle (below). The standing card + the cost auto-default key off this boolean, so both entry points converge.

## The expected-vs-actual loop (this implements the deferred Component 5)

The declared `recharge` lines are the **expected**; the freelancer/supplier invoice that lands via cost capture is the **actual**. This closes the loop the cost spec deferred as *Component 5 (freelancer expected-vs-actual)*:

- **Auto-inherit:** when a cost is logged against a job with `recharge_running_costs = true` AND its category is in the running-cost set (fuel / parking / tolls / travel — the calculator's expense categories), it **defaults** to `cost_intent='extra'` + `recharge_mode='full'` + `recharge_status='pending'`. Staff can still override. (Implemented in `routes/costs.ts` create — check the job flag + category.) This is what makes the freelancer's later fuel invoice land as "recharge this" without anyone re-deciding.
- **Variance:** the card shows expected (£60 est.) vs actual (£58 invoiced) per category, billed at actual + markup.
- **The chase** = the "expected but not arrived" state: a declared `recharge` line with no matching actual cost yet → "fuel invoice still expected from \<freelancer\>", chaseable. This is the refined version of the freelancer-invoice-chase idea.

## The standing "Recharge running costs" card

A **forward-looking** card — the sibling of `cost_resolve`, but it exists from the moment recharge is declared (not only once a cost lands), and it spans pre- and post-hire. Recommended mechanism: a new `job_requirements` type `recharge_running_costs` so it flows into the Job Requirements checklist, the Returns close-out progress bar, and the dashboard for free (same machinery as `excess_resolve` / `cost_resolve`).

- **Pre-hire:** "Running costs recharged at actual + 20% — fuel, parking, PD. Expect invoices." Lists the declared categories.
- **At check-in (active prompt):** surfaces the **fuel baseline** — "out: Full → in: ½ → expect a refuel recharge". The book-out fuel level is *already captured* in the V&D/soft book-out condition event (R2 `vehicle-events/<reg>/<id>.json`, `fuelLevel`); this just pulls it forward into the check-in view + the card. No new capture.
- **Post-hire:** per declared category → *awaiting invoice* / *logged (pending resolve)* / *resolved*. Amber until every expected line is either resolved or explicitly retired.
- **"No further costs expected — close it"** action retires the card so a runner job doesn't sit open forever waiting on an invoice that's never coming.

`cost_resolve` (Phase D) stays as-is for the reactive "a recharge cost exists, resolve it" case; on a declared job the two co-operate (the standing card tracks *expected*, `cost_resolve` tracks *logged*). Decision to confirm at build: one combined card vs two — lean is the dedicated forward-looking card above, with `cost_resolve` continuing to handle ad-hoc recharges on non-declared jobs.

## Two entry points

1. **Rich (per quote):** the three-state expense selector in the calculator. The natural place — you're already pricing the van+driver.
2. **Lightweight (switch into it after the fact):** a **"Recharge running costs" toggle in the Job Detail Tools menu** (and mirrored on the Money tab) for the "no calculator quote / realised mid-hire" case. Sets `jobs.recharge_running_costs = true` + lights the card + flips the cost auto-default, without itemised expected lines. STAFF_ROLES, logs a timeline interaction (same pattern as the Internal toggle).

## Markup

Default **20% (percent)**, overridable per-cost, or a fixed £ — reuses the Phase D markup engine (`cost-recharge-markup.ts`, which already does percent / fixed / greater-of). These declared running-cost lines default to **plain 20%** rather than the greater-of-£10 rule (that floor was for tiny ad-hoc refuels; on real running costs 20% always wins). The `cost_recharge` system_settings already hold the default; this just means the auto-inherited costs start at `markup_type='percent', value=20`.

## V&D / soft book-out scale-back (bundled into this work)

Today the V&D / soft book-out reuses the **full** Vehicle Condition Report (photos + signature). When **our own freelancer** is driving (not the customer), the damage-dispute rationale is weaker and the full walkaround is friction that stops staff bothering — which would starve this module of its fuel baseline. Scale it back:

- **Minimal V&D book-out:** **fuel level + mileage mandatory**, photos + signature **optional**.
- **Conditional nudge to do the full walkaround** when risk is higher: the freelancer's **first** V&D hire with us (new/unproven driver) OR a **long hire** (> N days, configurable). Prompt, don't hard-gate.
- Fuel + mileage are exactly what the recharge baseline needs, so the lighter flow still feeds the check-in prompt. The fuel capture itself is unchanged — only the photo/signature requirement relaxes.

This makes the soft book-out more likely to actually get used, which is what makes the check-in fuel prompt reliable.

## Freelancer portal surfacing (in-repo Next.js)

The per-line declaration serves **two audiences** — design the data so it can drive both, even if the portal surfacing lands in a later phase:

- **Client (billing):** the `charge_mode` per line (above).
- **Freelancer (clarity):** what *they* pay vs get reimbursed. "Recharge post-hire: fuel" implies "front the fuel, submit the receipt, reimbursed" (or "use the fuel card"); "PD £X — **paid by Ooosh**" settles the constant who-pays-the-PD question. The portal (in `src/app/job/[id]/...`) should show the freelancer their view, derived from the quote's expense states.

This is the genuinely valuable side-gain jon flagged. Phase it after the core, but keep the expense model expressive enough (the `charge_mode` + category per line is enough to derive the freelancer view).

## Build order

1. **Three-state expenses** — `QuoteExpenseItem.charge_mode` (shared type + back-compat read), calculator maths (`recharge` excluded from total, new `recharge_expenses` breakdown), TransportCalculator UI (the three-state selector + relocated/reworded helper text), `routes/quotes.ts` persist.
2. **Migration 151** — `jobs.recharge_running_costs` (+ note); set TRUE on quote save when any `recharge` line exists.
3. **Cost auto-inherit** — `routes/costs.ts` create defaults running-cost costs to `extra` + recharge-pending on flagged jobs.
4. **Standing card** — `recharge_running_costs` requirement type (migration row), forward-looking, with the check-in fuel prompt + "close, no further costs" action + expected/actual tracking + chase.
5. **Lightweight toggle** — Tools-menu + Money-tab switch.
6. **V&D book-out scale-back** — fuel+mileage mandatory, photos optional with the new-driver / long-hire nudge.
7. **Freelancer portal surfacing** *(later phase)* — the freelancer's pay/reimburse view from the expense states.

## Open decisions (confirm at build)

- One combined "recharge" card vs the dedicated forward-looking card + the existing reactive `cost_resolve` (lean: keep both, distinct roles).
- The long-hire threshold (N days) + "new driver = first V&D hire" definition for the photo nudge.
- Whether `not_included` PD should still tell the freelancer "client pays you directly" in the portal, or is simply silent (lean: surface it — it's the PD-clarity win).
