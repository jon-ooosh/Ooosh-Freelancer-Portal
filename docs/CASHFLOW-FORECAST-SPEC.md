# Cash forecast — spec

**Status: PHASE 1 BUILT, 4 Nov 2026** — Money › Cash forecast (`/money/cashflow`). §13 is what shipped and where it differs from the plan below; read it first. Mockup:
`docs/design/cashflow-forecast/` (open `mockup.html`, or the PNG in `screenshots/`).

An admin-only, forward-looking **13-week rolling cash forecast** in OP. Xero can tell you
which invoices are paid; it cannot tell you what is *coming* — confirmed hire balances,
deposits on enquiries that are close to booking, excess going back out after the summer, the
van HP that stops in March. OP knows those. This page puts them on one line, week by week,
next to the outgoings Xero knows about, and says what to do when a week dips.

---

## 1. Settled decisions (jon, 3 Nov 2026)

1. **Admin only** (`authorize('admin')`; jon is the only admin). Lives under Money.
2. **13 weeks, rolling, Monday–Sunday UK weeks** (`uk-date.ts`). Forward planning is the
   point; history is Xero's job. The only look-back is one line: last week's forecast vs what
   happened (§9).
3. **Two figures, always side by side: "Cash in the bank" and "Cash that's yours".** Excess
   held is cash flow (it comes in and goes out and must be planned for) but it is client money.
   See §4.
4. **Every pound is in one of three tiers, never blended:** *Committed* (confirmed jobs, bills
   with due dates, HP, payroll, tax), *Likely* and *Possible* (the pipeline, weighted by how
   often similar jobs have actually booked — §6). The chart's solid line is Committed only.
5. **Placement rule: money in at the LATEST date it is due, money out at the EARLIEST.** A
   forecast that errs should err towards caution. Every inflow also carries its window ("between
   10 Nov and 1 Dec") — jon: knowing *that* £1,000 lands between two dates is as useful as a
   guess at the day. The drill-down shows the window; the line uses the latest date.
6. **Xero is the source of truth for "things to be paid"** (bills), with three exceptions owned by
   OP: van HP (§5.3), a Xero bill being paid off in instalments (§5.4) and anything Xero cannot
   know (§5.5). Never read both for the same thing.
7. **Xero is never the source for money coming IN.** Its receivables are not usable here: HireHop
   pushes deposits as overpayments, so Xero shows "Invoices owed to you: −£163,683" (3 Nov 2026).
   Incoming money is OP's (`job_financials`, `job_excess`, the pipeline).
8. **Target: never below £0; hard limit −£22,000** (the Lloyds overdraft). Both are settings
   (`cashflow_target_floor`, `cashflow_overdraft_limit`). Below the target is amber, below the
   limit is red. The line is **all counted cash pooled** (Lloyds + Wise + Stripe + savings + on
   site) — money moves freely between them and clients pay into Wise and Stripe, so a Lloyds-only
   line would dip on paper while the money sat in Wise. The page also shows Lloyds on its own in
   the opening-balance breakdown, so a transfer that is due is visible.
9. **The opening balance is confirmed by a person once a week** (§3). Xero lags reality — the
   bookkeeper reconciles about weekly; on 3 Nov the Lloyds statement said +£30,391 and Xero said
   −£21,657. A forecast built on the Xero figure would be £52k out before it started.
10. **Code computes every number; Claude only narrates** (the weekly summary, §8). The "what would
    fix it" list is rules, not AI — same principle as `AI-KNOWLEDGE-SPEC.md` ("code rails beat
    written guidance").
11. **Never suggest holding back a client's money.** The fix-it list may suggest moving a supplier
    bill a week; it never suggests delaying an excess refund or a refund owed.
12. **Client £ performance** (who pays late, who books what) is wanted but belongs in the address
    book — not this module. `BACKLOG.md`.
13. **Stripe money is cash on the day Stripe says it becomes available** (4 Nov). Weekly, that is
    nearly the same as "cash when paid"; but jon's tight spots are inside a week ("paid Monday,
    spendable Wednesday, payroll Tuesday"), so the page also shows **the next 14 days day by day**
    (§7) — the same items, bucketed by day. Stripe's fee and YouLend's cut are their own lines.
14. **Planned items are the ONE place** to say "this amount, on this day, every month, until then"
    (§5.4) — rent, DDs, payroll, tax, and a Xero bill being paid off in instalments. OP does not
    read Xero's repeating bills. An item is either a **rule** (monthly on the 1st, until …) or a
    **schedule** (an editable list of dated payments, for instalments of any shape — jon, 4 Nov:
    one of the two big bills is over 10 months, not 12).
15. **The deposit rule is the one already in OP** (jon, 4 Nov): 25% with a £100 floor, the full
    amount under £400. It is written out twice today (`routes/money.ts` ~2128, `wise-incoming.ts`
    ~307); the forecast must not make it three. Phase 2 (moved from Phase 1, §13) moves it into one
    shared helper that all three call.

---

## 2. The accounts

From jon's Xero bank list (3 Nov 2026). Configured once in Settings (`cashflow_accounts`).

| Account | Treat as | Balance from |
|---|---|---|
| Lloyds current | **Main account** — the £22k overdraft | Monday check-in (Xero statement balance if the API gives it — §3) |
| Wise | Cash (client-facing bank) | Check-in. No Wise API needed: money in is already recorded in OP, and money out of Wise shows up in the next Monday balance and the forecast-vs-actual line (§9) |
| Stripe GBP | Cash — available now, plus pending money on the date it becomes available | **Stripe API, live** (`balance` available + pending, with each pending amount's available date). Xero's £52,867 is an unreconciled clearing figure — ignore it |
| Virgin, Aldermore 2, Capital on Tap savings, Moneybox | **One "Savings" lump**, counted as cash | Check-in (one figure) |
| Petty cash + Till | One "Cash on site" figure | Check-in (optional — small) |
| Capital on Tap card | Card — interest-bearing (1.83% a month) | Check-in; terms and repayment plan in the card's settings (§5.6) |
| Amex Gold charge card | Card — paid in full monthly today, but that is a setting, not an assumption | Check-in; card settings (§5.6) |
| Lloyds credit card, PayPal | Card / small | Check-in (optional); any card can be added |
| Worldpay, Amex merchant, Funding Circle, Director's loan, New Stripe GBP | **Ignored** (retired / zero) | — |

---

## 3. The Monday check-in (the opening balance)

A small modal: one row per counted account, pre-filled with the best figure OP has (live Stripe;
Xero's statement balance if readable; else last week's) and its age.
jon confirms or types; 30 seconds. Stored in `cashflow_balance_snapshots` (account, amount,
as_of, source, entered_by).

- The page always shows when the opening balance was last confirmed. **Older than 7 days → amber
  banner** "The forecast starts from a balance confirmed on …".
- Between check-ins, the opening balance is the last confirmed figure plus what OP knows has
  moved since (payments recorded in OP, Stripe live). Good enough for mid-week; Monday resets it.
- **To verify in Phase 3:** whether Xero's API exposes the bank-feed *statement* balance (the
  figure on Xero's bank cards). The Bank Summary report gives the *reconciled* balance, which is
  the lagging one. If the statement balance isn't available, the check-in stays manual for
  Lloyds and the cards — three figures.

---

## 4. "Cash that's yours"

```
Cash yours = cash in the bank (main + Wise + Stripe + savings + on site)
           − excess held in cash             (v_excess_held — not pre-auths, they are not cash)
           − refunds owed to clients          (the Money Overview "Owed to Clients" figure)
           − VAT owed for the current quarter (the VAT item, §5.4)
```

**Hire deposits on future jobs are NOT subtracted.** Recommendation, open to jon: a deposit secures
the booking and is normally kept on cancellation (the cancellation fee), so it is ours in a way
excess is not. Subtracting it would make "yours" deeply negative every spring and teach the eye
to ignore it. The tile shows "£X of deposits on future jobs" as a note underneath instead.

---

## 5. What goes into the forecast

Each source produces items: `{ date, window_from, window_to, amount (signed), tier, category,
source, ref, client_money }`. `services/cashflow-forecast.ts` gathers them, places each in its
week by §1.5, and sums. One builder, one place.

### 5.1 Money in (OP)

| Item | Tier | Amount | Date (window) |
|---|---|---|---|
| Balance on a confirmed+ job | Committed | `job_financials.balance_outstanding` | Due by the first day of the hire. Client on credit (`working_terms_credit_days` on the client org/person — the live field; the old `organisations.payment_terms` column is unused): job end + N days. Window: today → due date |
| Deposit owed on a confirmed job with none paid | Committed | the deposit rule (§1.15) | Window today → first day; placed at the first day |
| Balance **overdue** (hire started, still owing) | Committed, flagged | balance | Not placed in week 1 by default — listed as "Overdue: chase" and counted in the fix-it list. A toggle puts them in "next week" |
| Excess due on jobs starting (needed / pending records) | Committed, client money | £ per record | First day of the hire |
| Pipeline jobs (provisional, quoting, new enquiry) | Likely / Possible | job value × weighting (§6), split into deposit and balance | Deposit: earlier of (next chase date + 7 days, first day − 7); balance: first day. Starting rules — tune after a month |

Rules that bite:
- **Quote options count once.** A group of alternative quotes is one possible job — use
  `job-groups.ts` `nonLeadMemberIds()` to drop non-lead members.
- **Internal jobs (`is_internal`) and lost/cancelled jobs are out.** The weekly shop job is never
  in `jobs` and must stay out.
- **Cancelled jobs:** only the fee invoice owing counts (`cancellation-close.ts`), never the hire.
- Any "is it settled" test goes through `lib/money.ts` / the backend equivalent — never `> 0`.

**How a client pays changes when the money is spendable.** About 90% of money in comes through
Stripe (jon, 4 Nov; Phase 1 measures it from the methods OP records, last 90 days, as
`cashflow_stripe_share`). For the Stripe share of any expected payment:
- it becomes spendable on its date **plus Stripe's payout delay**, read from the account's payout
  schedule (Stripe API), so a balance due on a Friday is spendable the following Tuesday or so;
- **Stripe's fee** is its own outgoing line, at the effective rate of the last 90 days of Stripe
  balance transactions (fee ÷ amount), not a guessed percentage;
- **YouLend's cut** is its own outgoing line (§5.6).

Money already in Stripe is exact: the API gives each pending amount and the day it becomes available.

### 5.2 Money out (Xero)

- **Unpaid bills** (ACCPAY, AUTHORISED) by due date — the bills token already has
  `accounting.invoices`. Committed.
- **Overdue bills are their own pile.** Xero shows £88,708 of £99,002 overdue (64 of 104 bills,
  3 Nov 2026). Either that is real or many are paid but not marked yet; either way, dumping £88k
  into week 1 would make the chart useless. Overdue bills appear as an amber "Overdue in Xero —
  check" total, outside the line, with a one-click "count these from next week". Once the bookkeeper
  has cleaned them up this pile should be small.
  On 4 Nov jon split it: ~£15k is paid but not reconciled yet, ~£60k is two large bills being paid
  off monthly, and the rest is genuinely due. So:
  - **"Paid — Xero is behind"**: a tick on a bill in the check pile hides it until Xero marks it
    paid, then the tick clears itself. Never written to Xero.
  - **Instalments**: a bill being paid monthly is turned into an instalment plan (§5.4) and leaves
    the pile.
  - What's left is real and goes in from next week.
- **Xero repeating bills are NOT read** (§1.14). If the bookkeeper uses them, each month's bill
  appears in Xero as an ordinary bill and is matched against the planned item (§5.4).
- **Excluded contacts:** a Xero contact marked "handled by fleet finance" (the HP lenders) is skipped,
  so HP is never counted twice (§5.3).

### 5.3 Van HP — from OP fleet finance (steer)

OP's `fleet_vehicles` finance fields (`monthly_payment`, `finance_start`, `finance_ends`,
`finance_with`), not Xero. Reasons: OP knows when each agreement **ends** (the forecast shows the
month a payment stops), and selling a van closes it. Xero only knows past payments. Payment day:
a per-agreement day-of-month (new column, defaults to the 1st). Committed.

**Before Phase 1 goes live:** check the Fleet › Finance board — every financed van needs
`monthly_payment` and `finance_ends`, or that van is missing from the forecast. The page lists
"financed vans with no monthly payment" as a warning.

### 5.4 Planned items — the one place for anything Xero doesn't schedule

**Where:** Money › Cash forecast › **Planned items** (the button in the header): a list with
**+ Add**, each row editable, and a preview of the next three dates so a mistyped day shows at once.

`cashflow_planned_items`: label, category, tier, and **either** a rule — amount, frequency (once /
weekly / monthly / quarterly / yearly), day, start, end — **or** a schedule:
`cashflow_planned_item_dates` (item, date, amount), one row per payment.

**The schedule editor** (jon asked for "as flexible as possible", 4 Nov): pick weekly or monthly,
the first date, how many payments and the amount, and OP writes out every payment as a row. Each
row can then be changed (a different amount, a moved date), removed (a skipped month), or added to (an
odd final payment). Underneath, always: **"10 payments · £24,000 · the bill says £24,000 ✓"** —
the total against the linked bill's amount due in Xero (or a typed total when there is no bill). A
difference shows in amber with the amount; it never stops a save (warnings, not gates). A tickbox per
week or month was considered: it does the same job for equal monthly payments, but 52 boxes for a
weekly plan is clumsy and it can't hold an odd first or last payment.

Two optional links:
- **`xero_contact_id` — "matches bills from"**. When a Xero bill from that contact lands within
  ±7 days of a planned date, for a similar amount (±10%), that occurrence counts as arrived and the
  bill is used instead. So a payment is never counted twice whether or not the bookkeeper raises a
  bill for it.
- **`xero_bill_id` — "instalments of this bill"**. The bill leaves the bills line and the
  schedule takes over. Past rows drop off (that money is already out of the bank); future rows count.
  Each time the page loads, the future rows are checked against the bill's amount due in Xero, and a
  difference shows on the item in amber. While the bookkeeper is behind, the difference is
  usually one payment that has gone but isn't recorded yet, so the note says which. The two big bills
  from §5.2 are the first two; jon enters them once the module is built.

What goes here:
- rent, rates, water, insurance, software and other direct debits;
- **payroll** (net pay date) and **PAYE/NI** (22nd);
- **VAT** — one item per quarter, amount typed in (the bookkeeper's figure). An OP estimate is
  Phase 4;
- **corporation tax**;
- instalment plans on Xero bills (above);
- one-offs jon is planning (a van deposit, a big purchase).

**Not here:** card repayments (they are the card's own settings, §5.6), van HP (§5.3) and YouLend
(§5.6) — each has one home so it can't be entered twice.

Phase 3 adds *suggestions*: payments that recur in the last 12 months of Xero bank transactions
but are not a bill or a planned item ("£1,450 to X on the 1st, 11 of 12 months — add?"). A
suggestion is never counted until jon accepts it.

### 5.5 Money out that only OP knows (Phase 2)

jon (4 Nov): "being able to see what's going to be owed, as part of a job cost, before we've
done it — flights, freelancers, fuel" — the part Xero can never do. Phase 2, ahead of the Xero
extras.

- **Excess refunds** on returned and upcoming jobs: return date + `cashflow_excess_refund_days`
  (default 7). Held-on-account excess (`held_on_account`) is standing — never refunded by the
  forecast. Excess kept for damage is assumed refunded (caution).
- **Refunds owed to clients** (pending): next week.
- **Freelancer work done but not yet invoiced** (`freelancer-earnings.ts` "To invoice") and
  **freelancers booked on confirmed jobs** (`freelancer-fees.ts` `personalFee()`): due by
  `supplier-terms.ts` `resolveDueDate()`. Xero cannot see these until the invoice arrives.
- **Expected job expenses on confirmed jobs' quotes** — `quotes.expenses` (the transport
  calculator's lines: fuel, parking, tolls, outbound / return travel — flights, trains, ferries —
  hotel, per diems) and `quote_assignments.expected_expenses`. Placed on the job's date, labelled
  "estimate from the quote". Lines the client is recharged for still count as money out (the
  recharge comes back later as part of the balance). **Gap to know about:** fuel for self-drive
  hires and costs never put on a quote are not in OP before they happen; they appear when the
  receipt or bill arrives.
- **Once a cost is captured in Costs it is OP's actual, and it's pushed to Xero** — the
  quote estimate for that line stops counting when a cost is linked to the job for the same
  category, so it is never counted twice.

### 5.6 Cards and YouLend

**Cards** — `cashflow_cards`, any number (Capital on Tap, Amex, Lloyds card, one added later):
name, monthly interest rate (0 for a charge card), statement day, payment due day, credit limit,
and a **repayment plan**: *in full* (the statement balance on the due day) / *minimum* (a % of the
statement balance) / *fixed* (£X a week or a month, never below the minimum). Amex is "in full"
today; switching it is one setting, so a month where it isn't paid in full can be planned for.

- Cash out = the plan's payments. **A purchase on a card is not cash out** — it is cash out when
  the card is paid. So a Xero bill paid by card would be counted twice (as a bill, then in the card
  balance); a bill can be marked "paid by card" and leaves the bills line.
- Interest = the card's balance × its monthly rate, on the statement day, as its own line.
- **A balance line per card** (small, under the table): balance + typical spend − payments +
  interest, week by week. Typical spend = the average weekly rise between Monday check-ins over the
  last 8 weeks, once there are 8. This is what shows the "cash drag" jon described.

**The two cards as set up (jon, 4 Nov):**
- **Capital on Tap:** limit £45,000; 1.83% a month (≈ 24% a year compounded); statement on the
  27th; minimum 10%, due around the 2nd–3rd; plan: fixed £1,000 a week.
- **Amex Gold (charge card):** no interest; statement on the 3rd; paid in full by direct debit on the
  23rd.

**Capital on Tap in practice:** the balance has sat at £30–40k for six months, because spending
roughly matches the £1,000 a week, so it stands still and costs **~£550–730 a month in interest**.
At the 3 Nov balance (£38,899) only about **£6,100 of the £45,000 limit is free** — the headroom the
fix-it list shows is small. The card line makes all of this visible; what to do about it is jon's call.

**YouLend** — its own outgoing line, so it is visible and stops by itself when paid off.
```
YouLend this week = 28% × (Stripe receipts expected this week)
                    capped at the remaining balance
```
- Inputs (settings, from the YouLend statement — update monthly): withholding **28%**, remaining
  **£152,671** (4 Nov 2026). The page shows the **forecast payoff date** from these figures.
- **It is big.** 28% of 90% is about **a quarter of everything coming in**. Clearing £152,671 at 28%
  takes about **£545,000** of Stripe receipts. If that is more than will come through Stripe by the
  summer, the payoff date will say so.
- **Excess paid by card loses 28% on the way in and goes back out at 100%.** A £1,200 card excess
  leaves £864 to spend, then £1,200 is refunded. A **pre-auth** is never captured, so YouLend never
  sees it. While the loan runs, pre-auths are better for cash than card excess payments. The
  pre-auth rule (`excess-preauth.ts` `preauthEligibility()`) is unchanged — this is information, not a
  new gate.
- **Bank transfer instead of card** keeps the 28% (and Stripe's fee) in hand *now*. It does not reduce
  what is owed — it only puts the repayment later. jon checked (4 Nov): the YouLend agreement
  doesn't restrict it, so the fix-it list may suggest it (`cashflow_suggest_bank_transfer`, on).
- Pre-auths for short hires (1–3 days) already avoid both the 28% and Stripe's fee on excess — one
  of the reasons that work was done (jon, 4 Nov).

---

## 6. Weightings — how likely is this enquiry to book?

Learned from what has actually happened, not guessed.

- **Rate = booked ÷ (booked + lost)** over the last 24 months, using `job-outcomes.ts`
  `JOB_OUTCOME_SQL`, bucketed by **likelihood** (hot / warm / cold / unset) × **status**
  (provisional vs earlier) × **lead time** (starts within 4 weeks / 4–12 / later).
- **Excluded:** alternative-quote losses (`notAltQuoteLossSql` — they are "we booked the other
  option", not a loss), non-lead quote options, internal jobs.
- **Small buckets:** under 20 jobs, fall back to the parent bucket, then to the defaults in settings
  (provisional 85%, hot 70%, warm 40%, cold 15%, unset 25%).
- Every weighted figure says what it was learned from ("hot, starts within 4 weeks — 71%, from 38
  jobs").
- **Tiers:** weighted ≥ 60% is Likely, otherwise Possible.
- **First step of Phase 2:** count how many open jobs actually have a likelihood set. If it's
  rarely used, lead time and status carry the weight, and the fix-it list asks for likelihoods on
  the biggest jobs.

Caveat: OP keeps a job's *last* likelihood, not its history, so a lost job reads as whatever it was
when it died. Good enough to start; a likelihood-change log would sharpen it later.

---

## 7. The page — `/money/cashflow`

(See the mockup.) Top to bottom:

1. **Header:** "Cash forecast", opening balance confirmed date, **Monday check-in** button, settings.
2. **Four tiles:** Cash in the bank today · Cash that's yours · **Lowest point in 13 weeks** (amount,
   week, colour against target/limit) · Next 13 weeks: committed in / out.
3. **Chart:** weekly closing balance, solid line = Committed, shaded band above = + Likely
   (+ Possible lighter). Dashed lines at the £0 target and the −£22k limit.
   **"Next 14 days" switch:** the same chart and table by day for the next fortnight — Stripe money on
   the day it becomes available, DDs and HP on their day, payroll on its day. This is where a
   Wednesday dip inside a fine-looking week shows up. The lowest-point tile also names the lowest
   *day* in the next 14 when it is lower than any week's close.
4. **What would fix it** (shown when any week goes below target): rules-based, ranked by £, each a
   link — see §8.
5. **Weekly table:** 13 columns. Rows: opening · in (hire balances, deposits, excess, pipeline
   weighted) · out (Xero bills, planned, van HP, payroll & PAYE, VAT & tax, excess refunds,
   freelancers, job expenses, Stripe fees, YouLend, card payments, card interest) · closing committed · closing with likely. **Click any cell →
   side panel listing the items behind it**, each with its window and a link (job, bill, setting).
6. **Warnings strip:** overdue Xero bills to check, financed vans with no payment set, balance
   not confirmed this week, likelihoods missing on big jobs.

**Reading it — the far weeks always look worse.** The committed line only holds jobs already
booked, and in November almost nothing for late January is booked yet, while January's rent, HP
and payroll are already known. So the line sags towards the right every week, and the dip moves
along with it. The near weeks (1–4) are the ones to act on; further out, read the shaded band.
The page says this in one line under the chart, so a scary week 12 isn't mistaken for a real one.

---

## 8. "What would fix it" and the Monday email

For the first week that goes below target, list the actions that would lift it, biggest first:

1. **Chase overdue balances** — hires that have started and still owe (link: job Money tab, portal
   link).
2. **Ask for balances early** — confirmed jobs whose balance is due in or just after the dip.
3. **Nudge enquiries** — provisional / hot jobs starting soon, ranked by deposit × weighting
   (link: job; uses the existing chase flow).
4. **Bills that could move** — Xero bills due in the dip, not overdue, from suppliers on terms
   ("could go a week later").
5. **Card headroom** — how much is free on each card against its limit (information, not advice).
6. **Ask for bank transfer instead of card** — balances due in or just before the dip × (28% +
   Stripe's fee) kept in hand now, while YouLend runs (§5.6; switch `cashflow_suggest_bank_transfer`).

Never: delay an excess refund or a refund owed (§1.11).

**Monday email** (Phase 4) to jon: the four tiles, the low point, the fix-it list, and a short
Claude-written paragraph ("Week of 12 Jan is the tight one: VAT plus three HP payments land while
only two hires start. Two overdue balances would cover it."). The numbers are passed in; Claude
writes words only (`config/anthropic.ts`, house voice). Sent through `email-service.ts`. Scheduled
Monday 08:15 UK (free slot), gated on `cashflow_email_enabled`.

---

## 9. Forecast vs actual (one line)

Every Monday check-in stores the forecast as it stood (`cashflow_forecast_snapshots`: week, JSON).
The next check-in compares last week's predicted closing balance with the confirmed one: "Last week
we said £18,200; it was £16,950 (−£1,250)". One line under the header — to tune the rules in the
first months, not a history module.

---

## 10. Questions

All answered (4 Nov 2026): deposit rule (OP's is right, §1.15); the overdue bills (§5.2); both cards
(§5.6); YouLend's rate, balance, ~£545k through Stripe by summer is about right, bank transfer allowed
(§5.6); Wise (check-in, no API, §2); Stripe (§1.13). The two instalment bills are entered by jon once
the module is built (§5.4).

Nothing blocks Phase 1.

---

## 11. Phases

| Phase | Builds | Gives jon |
|---|---|---|
| **1 — Committed forecast** (BUILT, §13) | Settings (accounts, target, limit); cards (§5.6); YouLend + payoff date; planned items — rules and the schedule editor — incl. instalments, payroll, VAT, tax (§5.4); Monday check-in; Stripe live balance, available dates and fee; OP money in (§5.1 committed rows); Xero unpaid bills + the check pile with "Paid — Xero is behind" (§5.2, existing scope); van HP from fleet finance; chart, tiles, table, drill-down, **next 14 days by day** | A trustworthy committed line from day one, down to the day for the next fortnight |
| **2 — What's coming that Xero can't see** | One shared deposit-rule helper (§1.15); expected job expenses from quotes, freelancers booked and work to invoice, excess refunds, refunds owed (§5.5); weightings (§6); pipeline Likely/Possible band; "What would fix it" (§8) | The forward view and the actions |
| **3 — Fewer figures to type** | Reports scope on the Custom Connection (re-authorise); statement balance if available; recurring-payment suggestions from Xero bank history; stale warnings | Less of the Monday check-in by hand |
| **4 — Talking to you** | Monday email + Claude paragraph; forecast vs actual line; OP VAT estimate | The Monday ritual |

Migrations take the next free number at build time and go in `run.ts`'s list. Settings live in
their own admin-only table, `cashflow_settings` — NOT `system_settings`, which every staff login can
read (§13).

## 12. Deliberately not built

- History / P&L / aged debtors — Xero has them.
- Scenarios ("what if summer is 20% down", "buy a van in March") — a natural Phase 5 if the
  forecast earns trust; planned one-off items cover the simple case now.
- Client £ performance — address book (`BACKLOG.md`).
- Any automatic action (chasing, moving bills). The page suggests; people act.

---

## 13. Phase 1 — what shipped (4 Nov 2026)

**Where:** Money › Cash forecast (`/money/cashflow`), admin only — the nav entry, the page and every
route (`routes/cashflow.ts`, `authorize('admin')`). Migration 327.

**Code:**
- `services/cashflow-schedule.ts` — the pure part: UK-day date maths, working days (bank holidays from
  `bank-holidays.ts`), repeating rules, the card simulation, the YouLend cap. Unit-tested
  (`__tests__/cashflow-schedule.test.ts`).
- `services/cashflow-sources.ts` — every reader (settings, balances, job balances, excess, refunds,
  van finance, planned items, Xero bills, Stripe). Xero and Stripe readers never throw; they answer
  `ok: false` and the page says what is missing.
- `services/cashflow-forecast.ts` — `buildForecast()`: places every item, sums weeks and days, builds
  the piles and warnings. `ROWS` is THE list of table rows.
- `xero-broker.ts` `getUnpaidBills()` — paged ACCPAY AUTHORISED read, on the existing bills token.
- Frontend: `pages/CashflowForecastPage.tsx`, `components/cashflow/*` (chart, table, check-in,
  planned items with the schedule editor, Xero bills, settings), `lib/cashflow.ts`.

**Tables:** `cashflow_settings`, `cashflow_accounts`, `cashflow_cards`, `cashflow_balance_snapshots`,
`cashflow_planned_items` + `cashflow_planned_item_dates`, `cashflow_bill_flags`,
`cashflow_excluded_contacts`. Seeded: the five accounts (§2), Capital on Tap and Amex with jon's
terms, YouLend 28% / £152,671, target £0, overdraft £22,000.

**Where it differs from the plan above:**
1. **Settings are their own table**, not `system_settings` (readable by every staff login).
2. **The shared deposit helper moved to Phase 2.** Phase 1 only counts what booked jobs still owe
   (`job_financials.balance_outstanding`), so it never needs the deposit rule; the pipeline does.
   Touching the live Money tab for no Phase 1 gain wasn't worth the risk.
3. **A booked job is one item, not "deposit + balance".** Both were due by the first day, so they
   landed on the same date anyway; the item says "no deposit yet" when none is paid.
4. **Excess refunds and refunds owed came into Phase 1** (they were §5.5, Phase 2). Excess coming
   IN without the matching refunds going OUT would have made every week look better than it is.
   Excess still held on a hire that finished over 30 days ago is a "check" pile, not next week's
   refund. Held-on-account excess is never refunded by the forecast.
5. **Excess on hires of 4 days or fewer is left out** — they take a pre-auth (`preauthEligibility()`),
   which is a hold, not cash.
6. **Card interest is a memo row, never in the totals.** Interest is added to the card; the cash that
   leaves is the repayment plan. Counting both would double it.
7. **A fixed card plan's minimum top-up** looks at everything paid since the last due day (not since
   the statement), and only once a statement has been simulated — payments before the check-in are
   invisible. Otherwise Capital on Tap showed a made-up £3,890 top-up on day one.
8. **Van HP pays on `finance_start`'s day of the month** (the 1st when unset) — no new column, no
   change to the vehicle module. If a van's day is wrong, its finance start date is the thing to fix.
9. **Scheduled payments since the check-in** (planned items, HP, card payments dated after the last
   check-in but before today) are counted today — they've left the bank since the balance was typed.
   Owed things (bills, client balances) are "still owed" and placed by their own dates.
10. **Stripe, live:** the opening balance uses Stripe's *available*; pending money lands on Stripe's
    own available date (net of fees already); a payout that reached the bank after the main
    account's check-in is added today. Stripe's balance is assumed already net of YouLend (Stripe
    Capital deducts as each payment settles) — if YouLend turns out to be taken at payout instead,
    the "Already in Stripe" row is over by 28%.
11. **The Stripe restricted key needs "Balance: Read" and "Payouts: Read"** for the live figures
    (deploy step). Without them the page says so and Stripe is typed in on the check-in.
12. **Xero repeating bills are not read** (§1.14) and the overdue bills are a pile with per-bill
    "Paid — Xero is behind" / "Paid by card" / "Instalments…" / "Not real" / "Leave out supplier" —
    the Xero bills button on the page.

**Known limits (by design, Phase 1):**
- `job_financials` is refreshed nightly and whenever a Money tab opens. A balance paid by Stripe
  today can sit in both "Already in Stripe" and "Hire balances" until that refresh.
- The fix-it list, enquiries, freelancers, quote expenses: Phase 2. The Monday email: Phase 4.
- Typical card spend is typed per card in Settings; until it is, the card's balance line assumes no
  new spending and says so.

### 13.1 After going live (5 Nov 2026)

**Cards follow the receipts logged in Costs** (jon: "immediate updates on cards put through OP, manual
adjustments on a Monday morning"). Migration 328 links each card to its Costs payment method
(`cashflow_cards.cost_payment_method`: Capital on Tap = `cot_card`, Amex = `amex`; one card per method).
- A card's balance = its Monday check-in + card receipts dated after it (credits net off). The page says how
  much of the balance came from receipts since Monday.
- Typical monthly spend = the typed figure, else the last 90 days of receipts on that card
  (`cardReceiptSpend()` in `cashflow-sources.ts`). It only knows what was logged, so it runs low, and the
  page says so.
- Spend accrues only from today (`simulateCard` `spendFrom`): the days before are already in the check-in or
  the logged receipts.
- **Next:** once there are ~4 Monday check-ins, compare each card's real movement (balance change + payments −
  interest) with what the receipts explain, and say how much spend isn't being logged.

**The "excess still held on old hires" pile surfaced a real excess-module gap** — excess applied to an
invoice directly in HireHop never reached OP's excess record (job 16325). Fixed in the Money tab, not here:
`services/excess-hh-claims.ts`, documented in `docs/reference/MONEY-AND-EXCESS.md` (last section). The pile
shrinks as those jobs are refreshed.

### 13.2 Phase 2 — what shipped (5 Nov 2026)

**The deposit rule is one helper** — `services/deposit-rule.ts` `requiredDeposit()` (Money tab summary, Wise
matcher, forecast) with the frontend mirror `lib/depositRule.ts` (Money tab quick amounts). The payment portal
keeps its own copy (netlify-functions) — change all three together. Behaviour unchanged.

**Freelancers** (`loadFreelancerCosts()` in `cashflow-sources.ts`, row "Freelancers (fees + expenses)"):
- deliveries, collections and crew on booked jobs (quote confirmed or completed, or someone assigned), studio
  evenings and yard days; fee by `personalFee()`, expenses by `bookingEstimate()` — the portal's and Costs'
  own figures. A multi-drop run is one piece of work at the run's fee. Payroll crew ("Ooosh Staff") cost their
  expenses only.
- a confirmed quote with fewer people booked than it needs is costed at the quote's fee per empty place,
  "not yet booked";
- not yet on an invoice (`cost_work_items`) — once invoiced, it is a Costs bill and Xero's. Work before the
  portal's "invoices linked from" date (`freelancer_earnings_labels_from`, `labelsFrom()`) never counts;
- paid on `freelancerDueDateFromApproval()` from the day of the work (today for work already done) — the
  earliest case.
- **Differs from §5.5:** quote expenses are the freelancer's estimate (they front them and claim them), not
  every quote line, so a cost line on the quote that Ooosh pays directly by card isn't here — it arrives as a
  card receipt.

**Enquiries** (`cashflow-pipeline.ts`, `loadPipelineJobs()`, `loadOutcomeHistory()`):
- open enquiries for hires that haven't started (new enquiry, quoting, chasing, paused, provisional), one per
  group of options (`nonLeadMemberIds()`); value = the Money tab's inc-VAT figure, else `job_value` + 20%.
- chance = provisional → Settings (85%); else what happened to enquiries with the same likelihood in the last
  24 months once there are 20 decided (booked or booked-then-cancelled ÷ booked + lost, alternative-quote
  losses excluded), else Settings (hot 70 / warm 40 / cold 15 / unset 25). Editable in Settings with the
  history beside them (migration 330).
- **Differs from §6:** no status or lead-time buckets — OP doesn't record what a past job looked like weeks
  before it started (status or likelihood history), so only likelihood is learned and provisional is a setting.
- deposit (the rule, less anything paid) on the earlier of a week after the next chase and a week before the
  start, never before tomorrow; the rest on the first day; both + Stripe's payout days; weighted; net of
  Stripe's fee and YouLend on the Stripe share. Money in only — their costs aren't weighted in yet.
- ≥ 60% (Settings) is Likely, the rest Possible: the shaded band on the chart, two rows and "Closing with
  likely" under the table — never in the committed line or its totals.
- a warning lists enquiries over £3k with no likelihood set.

**What would fix it** (`buildFixList()`): for the first week whose committed close is below the target —
chase overdue balances; ask early for balances due in the fortnight after; nudge enquiries starting up to four
weeks after (ranked by deposit × chance); Xero bills due that week ("only with the supplier's say-so"); bank
transfer instead of card (switch in Settings); card headroom as information. Biggest first. Never delays a
client's money.

**Not built (next):** the comparison of each card's real movement with logged receipts (needs ~4 check-ins);
Phase 3 (Xero reports scope, statement balances, recurring-payment suggestions); Phase 4 (Monday email,
forecast-vs-actual).

**Also in this PR:** `scripts/record-hh-excess-refund.ts` — a one-off to record an excess refund made directly
in HireHop as a payment application (jobs 12150, 15145; run after the claim sweep).

### 13.3 Phase 3 — what shipped (5 Nov 2026), and what changed from the plan

**Xero can't give the statement balance, so the Monday check-in stays** (jon, 5 Nov: typing the figures is
"ownership" of them, not a chore). Xero does not expose unreconciled bank data through its API (Xero, again
in May 2026); the Bank Summary report (`accounting.reports.banksummary.read`) only has the reconciled "balance
in Xero" — the lagging figure (−£21,657 against a +£30,391 statement on 3 Nov). Not read; no re-authorisation.

**Regular payments Xero has seen** (`cashflow-recurring.ts` `findRecurring()`, `xero-broker.ts`
`getSpendTransactionsSince()`, `loadRecurringSuggestions()`): a year of SPEND bank transactions (the existing
`accounting.banktransactions` scope — no new permission), grouped by Xero contact. Monthly = 6+ months, about
once a month, ±5 days on the usual day for 70%, paid in the last 45 days; quarterly = 3+ payments 75–105 days
apart, paid in the last 120. Amount within ±15% for 70% = steady; ±40% = "varies"; looser (fuel, parts) is
never suggested. Shown at the top of Planned items; "Add…" opens the editor filled in (linked to the Xero
contact, so a bill from them later replaces the occurrence — §5.4); "Not this one" is remembered
(`cashflow_recurring_dismissed`). Suppliers already linked to a planned item or left out of the forecast
aren't offered; card repayments and van HP lenders are flagged as counted elsewhere. Cached six hours
(a few dozen Xero calls).

**The card check** (`cashflow-schedule.ts` `cardSpendCheck()`): from the first to the last Monday check-in in
the last 35 days (at least a week apart): spent = balance change + the PLAN's payments − interest; against
the receipts logged in Costs on that card. Under 80% explained is amber. It assumes the planned payments were
made — a week paid differently shows up here too.

**Wise read live** (`config/wise.ts` `getWiseBalances()`, `readWise()`): with a read-only Wise API token
(`WISE_API_TOKEN`, `WISE_ENV=live`, optional `WISE_PROFILE_ID`) the Wise account (now kind `wise`, migration
332) is read from Wise's balances endpoint (GBP; other currencies shown, not counted) and drops off the
check-in, like Stripe. Balances are allowed on a read-only token; balance STATEMENTS are not (PSD2 extra
authentication for UK/EU), and nothing here uses them. No token or an error → typed on the check-in, with a
warning when a token is set but failing.

**Also:** Money › Excess "Clients with Balance" counted every client ever on the Client Ledger tab (521) —
now only those holding money.

### 13.4 After Phase 3 went live — tidy-ups and VAT (5 Nov 2026)

jon's first look at live figures, and what changed:

**The warnings name what they're about.** "1 financed van has no monthly payment" and "3 enquiries over £3k
have no likelihood" now list the vans (reg + lender, to the van's page) and the enquiries (to the job)
(`Warning.links`).

**Refunds owed were mostly old reminders, not a forecast bug.** The line reads OP's pending refund reminders
(`job_payments` refund, `pending` — made by a cancellation). Most had been refunded outside OP or were
duplicates; jon clears them on Money › Overview › Pending refunds (an OP note, no money moves). The drill-down
now shows when each was agreed and points there. **The cancelled job's banner now follows those reminders**
(`cancellation-close.ts` `readRefundOutcome()`, `CancellationPlan.refundOutcome`): with no fee invoice it said
"Refund due" from the figure saved at cancellation for ever; now it shows what's pending, else "Refund paid
£X on D", else "Refund cleared on D — <reason>". With a fee invoice the figure is still HireHop's, and a
cleared reminder beside a HireHop credit gets an amber "HireHop still shows this money on the job".

**Overpaid invoices: "Dealt with outside OP"** (Money › Overview, admin; migration 336
`job_overpaid_dismissals`; `POST`/`DELETE /money/:jobId/dismiss-overpaid`). For an overpayment sorted out by
hand (job 15250: a credit note tidied in Xero). OP note only — never record a refund in HireHop to clear one
of these, which would send it to Xero a second time. Kept with the figure: if HireHop's changes, the row is
back. The job's Money tab shows it grey with Undo; the Overview strip stops saying "owed to client". Not read
by the forecast (it never was).

**VAT is typed, by quarter, on the Monday check-in** (`cashflow-vat.ts`, `cashflow_vat_snapshots`). jon's call
over working it out from Xero's invoices and bills: Xero's VAT return is the number HMRC is paid
(adjustments included), and typing it weekly is a reminder of what's building up. Standard accounting;
quarters end Mar/Jun/Sep/Dec, direct debit on the 10th of the second month after, the next working day at a
weekend (settings `vat_quarter_end_month`, `vat_due_day`, in Settings › VAT).
- The check-in asks for the quarter **just ended** until its return is filed and paid, else the quarter **in
  progress**. Never pre-filled — re-saving last week's figure as today's would drag the estimate down.
- A quarter in progress gets the rest of it added at the rate so far (`projectQuarterVat()`), on its payment
  date, row "VAT & tax", if that date is in the 13 weeks. An ended quarter is counted as typed.
- **Negative is allowed and means HMRC owes us** (the six vans in April 2027). It is money in on the payment
  date, at what was typed — never multiplied out, so a one-off purchase can't turn into a fantasy refund.
- **A filed return is still a planned item** (category VAT, one-off). One within 10 days of a quarter's due
  date is that quarter's, and the typed estimate steps aside.
- "Cash that's yours" takes off the next filed return plus the VAT collected so far on quarters not yet filed
  (a refund is not added). A quarter whose payment is in the 13 weeks with nothing typed or filed is a warning.

**Planned items say "including VAT".** The forecast is cash: what leaves the bank, VAT and all. The VAT back
comes through the VAT bill.

**Captured for later** (`BACKLOG.md`): a business-figures tab — monthly utilisation by service, enquiry-to-
booking conversion, repeat-client rate.

**Next:** Phase 4 — the Monday email and the "last week we said X, it was Y" line.
