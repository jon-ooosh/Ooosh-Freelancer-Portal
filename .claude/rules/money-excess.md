---
paths:
  - "backend/src/routes/{money,excess,costs,cancellations,warehouse}.ts"
  - "backend/src/services/{excess-*,hh-deposit,hh-billing-deposits,money-emails,vat-adjustment,stripe-*,cost-*,supplier-terms,job-financials-backfill,job-value-sync,cancellation-calculator,remittance}.ts"
  - "backend/src/config/{stripe,xero}.ts"
  - "frontend/src/components/{MoneyTab,ExcessPaymentModal,ExcessGateBanner,ExcessHistorySection,CostCaptureModal,CostAllocationModal,CancellationModal,CombineBookingsModal}.tsx"
  - "frontend/src/pages/{ExcessLedgerPage,MoneyOverviewPage,CostsPage}.tsx"
  - "frontend/src/lib/{money,preauth}.ts"
---

# Money & excess — load-bearing rules

Full history, incident forensics and design rationale: `docs/reference/MONEY-AND-EXCESS.md`
(+ costs/Xero and Stripe detail in `docs/reference/SHARED-UTILITIES.md`).

## Single definitions — never re-derive these inline

| Question | THE definition |
|---|---|
| How much excess do we hold right now? | `v_excess_held` (SQL view) |
| Who is charged, and how much? | `services/excess-topn.ts` `reconcileJobExcessTopN` |
| Is this figure settled / outstanding? | `frontend/src/lib/money.ts` `isSettled`/`hasOutstanding`/`isNonZero` |
| What does this excess status say + what colour? | `statusLabel`/`statusColor` in `ExcessPaymentModal.tsx` |
| How do we describe a pre-auth? | `frontend/src/lib/preauth.ts` `describePreauth()` |
| Resolve a stuck pre-auth hold | `services/excess-preauth.ts` `reconcileExcessPreauth` |
| Push a deposit to HireHop | `services/hh-deposit.ts` `pushDepositToHH` |
| When is this bill due? | `services/supplier-terms.ts` `resolveDueDate()` |
| A job's costs (allocation-aware) | `GET /costs/by-job/:jobId` |

- **Never re-sum `excess_amount_taken` to answer "how much do we hold"** — read `v_excess_held`. Every surface that re-derived it drifted (phantom balances from double-counting `rolled_over` money that had moved forward).
- **Never compare a money figure against 0.** HireHop gives ex-VAT accrued; we derive VAT, so a sub-penny residue survives `toFixed(2)` and renders a red "£0.00 outstanding". Use the `money.ts` half-penny helpers.
- **Any new surface rendering an excess status pill MUST pass `auto_covered`** through `statusLabel`/`statusColor`, and any new excess select feeding a pill must expose that computed column.

## Excess status invariants

- **`pre_auth` holds its value in `amount_held`, NOT `excess_amount_taken`** (0 until capture). Coverage = `excess_amount_taken + amount_held`.
- **`released` is terminal.** Exclude it from every "find an existing non-terminal record to reuse / absorb / re-arm" lookup, alongside `reimbursed` / `fully_claimed` / `rolled_over` / `not_required` / `waived`. Missing it lets a late duplicate event resurrect a released hold and re-surface stale money in Total Held.
- **`waived` must be excluded from EVERY absorb lookup too** — one query that missed it silently un-waived a stub back to £1,200 when the driver's hire form landed.
- **"Held on account" is an ATTRIBUTE (`held_on_account`), not a status.** The record stays `taken`. `rolled_over` is set ONLY by a genuine apply-forward to a child hire — it is excluded from `v_excess_held` on the assumption the cash moved.
- **A rolled-over record's `payment_date` is when the rollover was applied, not when cash arrived.** Render "Carried over" and name the origin hire.

## Top-N reconciliation

- **THE MONEY GUARD:** a record holding `hh_deposit_id`, `stripe_payment_intent_id`, `refund_legs`, `bank_details_encrypted`, or membership of a rollover chain is FROZEN — never demoted, never re-priced. Report it in `blocked` instead.
- **NEVER LOWER A DELIBERATELY-SET AMOUNT.** Rank and price on `effective = max(drivers.calculated_excess_amount, job_excess.excess_amount_required)`. An insurer surcharge or staff edit lives on the job record and must not be re-priced back to the £1,200 floor.
- **Terminal records still OCCUPY slots** and count against `vanCount`. Filtering them out of the candidate query makes their slot look empty and promotes a covered sibling onto a settled hire (produced 71 false positives when it was got wrong).
- `dryRun: true` is read-only by construction, not by BEGIN/ROLLBACK — the pool has been saturated before.

## HireHop money mechanics

- **Link HH Deposit takes a TOTAL, not a delta**, and derives status via `deriveExcessStatus`. A HireHop deposit showing as "unlinked" is very often money OP already counted (a portal payment overwrites `hh_deposit_id` and orphans the original), so adding it doubles the collected figure — and recomputing status from raw amounts wiped a `partially_reimbursed` record back to `taken` (job 15187).
- **A refund pushed to HH is a kind=3 payment application, so the kind=6 deposit still reads as live money to OP.** Never unlink a record whose deposit has been reversed that way — the Money-tab reconciler re-links and re-adds it on the next page load. Re-point with Link HH Deposit at the new deposit instead, leaving the total unchanged.
- **Never call `billing_deposit_save.php` inline** — go through `hh-deposit.ts` so the failure-surfacing contract holds. Bubble `hh_push_error` to the client; the frontend shows "Saved in OP — HireHop push failed".
- **HireHop REJECTS negative deposits.** To reduce/remove a deposit anywhere, post a refund **payment application** (`reverseDepositOnHH` → `billing_payments_save.php` with `OWNER=0`), never a negative deposit.
- **⚠️ The broker RESOLVES `{success:false}` on a 327 rate-limit — it does NOT throw.** A bare `try { await hhBroker.post(...); UPDATE jobs SET status=2 } catch {}` never enters the catch and mirrors a FAILED push locally. Gate every local status mirror on `pushResult.success`.
- **`kind=3` applications publish TWICE** (once under the deposit, once under the invoice, same `data.ID`) — dedup by id or you double-count. Distinguish source-vs-target by **invoice ownership**, never by description text (deposit-side twins are blank).
- Money is pushed to Xero in **two steps** — the write, then `accounting/tasks.php` `post_payment`. Every money-out path does both.

## Refunds

- **One refund id = one leg.** `refund_legs` dedup is by `ref` ALONE (`isDuplicateLeg()` in `excess-refund.ts`) — the same refund arrives as `manual` (our reimburse endpoint), `stripe_webhook` and `hh_reconcile`. Keying on `(source, ref)` meant they never matched each other and the same £900 was applied twice (job 15187).
- **Claim the leg the moment the money moves, not after the response.** Stripe's `charge.refunded` lands ~300ms after `refunds.create`; the HH push + Xero sync take seconds. Any new refund path must write its leg BEFORE that work, or the webhook re-applies the amount.
- **Never unwind `charge.amount_refunded`** — it's the CUMULATIVE refunded total on the charge. Use the individual refund's amount, or a second partial refund re-applies the first.

## Stripe

- **Only `getStripeClient()`** — never `new Stripe()` elsewhere.
- **`stripe_events` has two disjoint keyspaces.** Portal/business-effect paths go through `services/stripe-event-claim.ts` (which applies the `pe:` prefix); OP's own webhook receiver uses raw `evt_` ids. Reading or writing a raw `evt_` id from a business-effect path re-creates the collision that silently dropped a live £1,200 hold.
- **"I ignored it" ≠ "processed".** The receiver only stamps `processed_at` when it actually handled the event.

## Costs & Xero

- **`GET /costs/by-job/:jobId` is THE allocation-aware read.** Never `SELECT … FROM costs WHERE job_id = $1` alone — that ignores splits, so a split invoice shows its full value on the capture job and nothing on the others.
- **Never push a cost to Xero outside `pushCostToXero`** — it holds the per-cost advisory lock that stops five trigger sites creating duplicate AUTHORISED bills.
- **Xero keys an attachment by FILENAME** — a same-named second file silently overwrites the first with a 200. Rename duplicates in the payload only (`collectDocuments`).
- **JSONB columns must be `JSON.stringify`d on write** (node-postgres sends a JS array as a Postgres ARRAY literal, which JSONB rejects — and an EMPTY array survives, so the bug only appears once someone uses the feature).
- On a Bill, the invoice number users SEE is Xero `InvoiceNumber`, not the API `Reference`. Set both.
- `resolveDueDate()` precedence: staff override → freelancer Friday rule → supplier terms. Don't branch on `cost_type` at a call site.
- **Cost lines: `amount_gross` is authoritative, VAT is DERIVED.** The gross is what we owe — staff-typed, never written from lines, and the lines must sum back to it within 1p (`validateCostLines`). VAT is only an analysis of that total, so a cost WITH lines takes `amount_vat`/`amount_net` from them (`headerVatFromLines`, applied server-side on write). Typing VAT in both places gave two figures that could disagree and a save that failed "gross balances, VAT doesn't". There is deliberately no VAT balance check.
- **Send `lines` in the SAME create/update request as the header, never a separate call.** The create route fires `pushCostToXeroBackground` immediately after the INSERT, so a follow-up write races it onto a one-line bill.
- **Compare money in whole pence, never floats.** `33.33 * 3` is `99.99000000000001`, so `Math.abs(sum - total) > 0.01` rejects an exactly-1p residue — the case the tolerance exists to allow. (Caught by a test, not by review.)
- **`resolveLineTaxType` takes `{amount_vat, amount_net}`, not a whole cost** — the rate is DERIVED, so a header spanning mixed rates yields a blend that is not a real rate (£250 no-VAT + £60 fuel w/ £10 VAT + £15 zero-rated implies 3%, matches nothing, and falls through to the account default). Only a homogeneous LINE gives a true rate.
- **AI-proposed cost lines are discarded, never adjusted, when they don't reconcile** (`reconcileLines`). The totals are what we pay; a split is a convenience. Bending one to fit the other puts a plausible wrong number in the accounts.
- **Bucket a job's actuals per LINE where a cost has them**, and only on whole-cost rows — a split-in row is a share of another job's payable, so its lines describe a total this job doesn't carry. `crew_fronted` beats the line's category (that's what "fronted" means on a quote).
- **A cost row returned to the UI must go through `withJobLabels()`** (`routes/costs.ts`) — `RETURNING *` omits `hh_job_number`/`job_name`/`vehicle_reg`, so the capture + split modals had nothing to print and fell back to a bracketed "(linked job)" where staff needed the number.

## Card-machine receipts

- **Every path that moves excess money through the physical card machine raises `receipt_required`** — payment, record-preauth, capture, and the excess branch of Money-tab record-payment. `worldpay`/`amex` only, excess only. A new excess-money surface that skips this makes the prompt a lottery.
- **The flag and `receipt_uploaded_at` move together** — raising the flag on a record with an earlier scan yields flag-set-but-to-do-invisible.

## Postgres

- **Never reuse a pg parameter in contexts that deduce different types** (varchar column assignment vs a text operator) — Postgres rejects the whole statement with `42P08`. Do the conditional in JS, or cast explicitly on every usage.

## UI

- **Don't call `onUpdated()` mid-flow** in `ExcessPaymentModal` — the parent's reload unmounts the modal. Set `madeChange` and refresh at close.
- **Merge action responses into the modal's record, never replace** — `RETURNING *` omits the joined display fields and blanks the header.
- Excess is charged per HIRE but stored per DRIVER: the Money tab collapses to chargeable rows (naming covered drivers); the Drivers & Vehicles tab deliberately shows per-driver personal liability. **Collapse, never hide.**
- **The costs table must fit the viewport — adding a column means folding another one in, not widening.** At 10 columns the Actions cell sat off-screen; "Uploaded by" now rides in the Supplier cell and the Xero pill in the Status cell. Multi-value cells (split allocations) stack vertically — one wide inline row sets the whole column.
- **A repeatable file picker is a labelled button, never a bare `<input type="file">`.** We clear `e.target.value` after each pick so the same file can be re-chosen, which leaves a raw input reading "No file chosen" forever — staff couldn't tell a second supporting document was possible.

## Policy

- Excess is a **warning, not a hard gate** — dispatch is non-blocking, and the dispatch gate is lifecycle-bound (suppressed once the hire is finished).
- **Never silently move money.** Surface a recomputed figure and let staff decide.
- Balance overrides, "mark externally resolved" and refund-dismissal are **pure OP annotations** — they touch neither HireHop nor Xero.
- `MIN_CANCELLATION_FEE` is the **ex-VAT** figure `25` (£30 inc-VAT). The whole calculator works ex-VAT; callers add 20%. Setting it to `30` double-counts VAT.
