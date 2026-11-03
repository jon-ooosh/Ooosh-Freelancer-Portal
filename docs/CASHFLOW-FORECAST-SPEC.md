# Cash forecast — spec

**Status: DRAFT, 3 Nov 2026.** Agreed in principle with jon; nothing built. Mockup:
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
6. **Xero is the source of truth for "things to be paid"** (bills), with two exceptions owned by
   OP: van HP (§5.3) and anything Xero cannot know (§5.5). Never read both for the same thing.
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

---

## 2. The accounts

From jon's Xero bank list (3 Nov 2026). Configured once in Settings (`cashflow_accounts`).

| Account | Treat as | Balance from |
|---|---|---|
| Lloyds current | **Main account** — the £22k overdraft | Monday check-in (Xero statement balance if the API gives it — §3) |
| Wise | Cash (client-facing bank) | Wise API if a live read token is set (`config/wise.ts` exists, sandbox only today), else check-in |
| Stripe GBP | Cash in transit | **Stripe API, live** (`balance` available + pending). Xero's £52,867 is an unreconciled clearing figure — ignore it |
| Virgin, Aldermore 2, Capital on Tap savings, Moneybox | **One "Savings" lump**, counted as cash | Check-in (one figure) |
| Petty cash + Till | One "Cash on site" figure | Check-in (optional — small) |
| Capital on Tap card | Card — **interest-bearing** | Check-in; APR + repayment plan in settings (§5.6) |
| Amex Gold charge card | Card — paid in full monthly, no interest | Check-in; statement due day in settings |
| Lloyds credit card, PayPal | Card / small | Check-in (optional) |
| Worldpay, Amex merchant, Funding Circle, Director's loan, New Stripe GBP | **Ignored** (retired / zero) | — |

---

## 3. The Monday check-in (the opening balance)

A small modal: one row per counted account, pre-filled with the best figure OP has (live Stripe;
live Wise if configured; Xero's statement balance if readable; else last week's) and its age.
jon confirms or types; 30 seconds. Stored in `cashflow_balance_snapshots` (account, amount,
as_of, source, entered_by).

- The page always shows when the opening balance was last confirmed. **Older than 7 days → amber
  banner** "The forecast starts from a balance confirmed on …".
- Between check-ins, the opening balance is the last confirmed figure plus what OP knows has
  moved since (payments recorded in OP, Stripe live). Good enough for mid-week; Monday resets it.
- **To verify in Phase 2:** whether Xero's API exposes the bank-feed *statement* balance (the
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
| Deposit owed on a confirmed job with none paid | Committed | the deposit rule (§10 Q1) | Window today → first day; placed at the first day |
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

### 5.2 Money out (Xero)

- **Unpaid bills** (ACCPAY, AUTHORISED) by due date — the bills token already has
  `accounting.invoices`. Committed.
- **Overdue bills are their own pile.** Xero shows £88,708 of £99,002 overdue (64 of 104 bills,
  3 Nov 2026). Either that is real or many are paid but not marked yet; either way, dumping £88k
  into week 1 would make the chart useless. Overdue bills appear as an amber "Overdue in Xero —
  check" total, outside the line, with a one-click "count these from next week". Once the bookkeeper
  has cleaned them up this pile should be small.
- **Repeating bills** (Xero RepeatingInvoices) projected forward. Committed.
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

### 5.4 Planned items (manual, in settings)

`cashflow_planned_items`: label, amount, category, frequency (once / weekly / monthly / quarterly /
yearly), day, start, end, tier. For everything that is not a Xero bill:

- rent, rates, water, insurance, software and other direct debits;
- **payroll** (net pay date) and **PAYE/NI** (22nd);
- **VAT** — one item per quarter, amount typed in (the bookkeeper's figure). An OP estimate is
  Phase 4;
- **corporation tax**;
- one-offs jon is planning (a van deposit, a big purchase).

Phase 2 adds *suggestions*: payments that recur in the last 12 months of Xero bank transactions
but are not a bill or a planned item ("£1,450 to X on the 1st, 11 of 12 months — add?"). A
suggestion is never counted until jon accepts it.

### 5.5 Money out that only OP knows (Phase 3)

- **Excess refunds** on returned and upcoming jobs: return date + `cashflow_excess_refund_days`
  (default 7). Held-on-account excess (`held_on_account`) is standing — never refunded by the
  forecast. Excess kept for damage is assumed refunded (caution).
- **Refunds owed to clients** (pending): next week.
- **Freelancer work done but not yet invoiced** (`freelancer-earnings.ts` "To invoice") and
  **freelancers booked on confirmed jobs** (`freelancer-fees.ts` `personalFee()`): due by
  `supplier-terms.ts` `resolveDueDate()`. Xero cannot see these until the invoice arrives.

### 5.6 Cards and YouLend

- **Cards:** settings per card — APR, statement due day, repayment plan (full / fixed £ / minimum).
  Monthly interest = balance × APR ÷ 12, shown as its own line ("Capital on Tap interest
  ≈ £520/month"). The Amex statement is an outflow in full on its due day. The balance comes from the
  check-in; Xero's lags.
- **YouLend** (taken out of Stripe receipts until paid off — expected by summer 2027): its own
  **outflow line**, not a hidden cut to income, so it is visible and disappears when done.
  ```
  YouLend this week = withhold rate × (expected receipts this week × Stripe share)
                      capped at the remaining balance
  ```
  *Stripe share* = the share of hire + excess money that came in by Stripe over the last 90 days
  (OP records every payment's method) — nobody knows how one client will pay, but the mix across
  a week is steady. Inputs: remaining balance and withhold rate, typed in from the YouLend
  statement monthly (settings). When the remaining balance reaches £0 the line stops.

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
- **First step of Phase 3:** count how many open jobs actually have a likelihood set. If it's
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
4. **What would fix it** (shown when any week goes below target): rules-based, ranked by £, each a
   link — see §8.
5. **Weekly table:** 13 columns. Rows: opening · in (hire balances, deposits, excess, pipeline
   weighted) · out (Xero bills, planned, van HP, payroll & PAYE, VAT & tax, excess refunds,
   freelancers, YouLend, card interest) · closing committed · closing with likely. **Click any cell →
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
5. **Card headroom** — how much is free on Capital on Tap (information, not advice).

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

## 10. Questions still open

1. **Which deposit rule is right?** jon (3 Nov): "25% or £400, or the full hire fee if less —
   whichever is greatest". The code (`routes/money.ts` ~2128, `wise-incoming.ts` ~307, the Money
   doc "min 25%, floor £100, full if under £400") says **25% with a £100 floor, full under £400**.
   They differ for jobs between £400 and £1,600 (jon's rule asks £400; the code asks 25%). The
   forecast uses ONE helper either way; if the rule changes, the portal and Money tab change with it
   — a separate decision, not this module's.
2. **The £88,708 overdue in Xero** — real, or paid but not marked? Decides how big the "check"
   pile is on day one.
3. **Capital on Tap APR and how it is repaid**; Amex statement day.
4. **YouLend:** current remaining balance and withhold rate.
5. **Does Wise allow a live read-only token for balances** on the business account? (If not, Wise
   is a check-in figure.)

---

## 11. Phases

| Phase | Builds | Gives jon |
|---|---|---|
| **1 — Committed forecast** | Settings (accounts, target, limit, cards, YouLend, planned items incl. payroll/VAT/tax); Monday check-in; Stripe live balance; OP money in (§5.1 committed rows); Xero unpaid + overdue bills (§5.2, existing scope); van HP from fleet finance; chart, tiles, table, drill-down | A trustworthy 13-week committed line from day one |
| **2 — Xero and balances** | Reports scope on the Custom Connection (re-authorise); statement balance if available; Wise balance; Xero repeating bills; recurring-payment suggestions; stale warnings | Fewer figures to type, nothing missed |
| **3 — What's coming that Xero can't see** | Weightings (§6); pipeline Likely/Possible band; excess refunds, refunds owed, freelancer work and bookings (§5.5); "What would fix it" | The forward view and the actions |
| **4 — Talking to you** | Monday email + Claude paragraph; forecast vs actual line; OP VAT estimate | The Monday ritual |

Migrations take the next free number at build time and go in `run.ts`'s list. Settings live in
`system_settings` where they are single values; tables for accounts, snapshots, planned items and
forecast snapshots.

## 12. Deliberately not built

- History / P&L / aged debtors — Xero has them.
- Scenarios ("what if summer is 20% down", "buy a van in March") — a natural Phase 5 if the
  forecast earns trust; planned one-off items cover the simple case now.
- Client £ performance — address book (`BACKLOG.md`).
- Any automatic action (chasing, moving bills). The page suggests; people act.
