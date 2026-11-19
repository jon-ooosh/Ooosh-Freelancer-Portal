# Credit on account — a client's overpayment kept for their next hire

**Status:** PRs 1–2 built (18 Nov 2026). PRs 3–4 not built — §6.

Born from job 16489 (Gently Tender): the hire finished £68.40 overpaid and the client asked
us to keep it for a hire they were about to confirm. "Apply to another job" only works
against an approved invoice with something owing, and the next job has no invoice until
its close-out — so for the whole life of that hire nothing in OP, the payment portal or
HireHop knew about the money, and only jon could be asked.

## 1. Settled (jon, 18 Nov 2026)

1. **It is the client's money, not a voucher.** A voucher (`GOODWILL-CREDIT-SPEC.md`) is a
   promise that becomes a DISCOUNT: less revenue, less VAT, a use-by date, a remainder that
   lapses. This is cash already paid: the next invoice stays full value and this pays part of
   it; no VAT of its own, no expiry, and what one job doesn't need stays on account. Using a
   voucher for it would under-declare VAT and strand the real deposit. The two only LOOK
   alike on screen (the Client History note, "Use on this job").
2. **The money never moves until the next job is invoiced.** It stays unallocated on the
   hire payments (HireHop deposits) of the job it was paid on, and as an overpayment in
   Xero. Nothing is written to HireHop or Xero when it is held or put aside. Not moved by
   refund-and-redeposit either: that makes two phantom bank lines in Xero and breaks the
   card-refund link.
3. **A hold is per JOB, not per payment.** The overpaid amount is whatever is left
   unallocated across the job's payments once its invoices are paid — it can sit on two of
   them (16489: part on the October card payment, part on the £30 transfer), and no single
   payment can give more than it has left. "Hold on account" is always the job's whole
   unallocated amount, whichever row it is opened from.
4. **The amount is HireHop's, never a stored promise.** `account_credits.amount` is what
   HireHop last said is unallocated on the source job; the close-out plan refreshes it on
   every live read. A refund or an application made anywhere brings it down by itself, so
   OP can never promise more than is really there, and nothing double-counts once the
   money is applied for real.
5. **It follows the paying client** (`jobs.client_id`, the Xero contact) — never the band,
   unlike vouchers. Same client only, no override.
6. **Who:** any staff role holds it and puts it aside for a job (neither moves money).
   Taking a hold or a reservation back off is a manager's, as is the close-out button that
   will apply it (already manager-only).
7. **Only once the job's own invoices are raised and paid.** Before that every payment
   looks "spare" to the plan. A cancelled job's spare money is a refund, not a hold (v1).
8. **Held money is a decision made**: the job stops reading "Money to sort", moves on to
   sent / paid, and can be completed.
9. **Confirming a job on the strength of it is a person's call** (PR 2): never automatic.
10. **The portal's call to OP is best-effort** (PR 4): if OP doesn't answer, the portal
    shows the full balance rather than refusing payment.

## 2. Data — `account_credits` (migration 352)

One row per hold: `source_job_id`, `organisation_id` (the client), `amount`,
`amount_checked_at`, `note`, who/when, `status` (`held` · `released` · `spent`),
`reserved_job_id` (+ who/when), release reason. One LIVE hold per source job (partial
unique index). Never deleted.

The status a person sees is derived on read (`ACCOUNT_CREDIT_STATUS_SQL`):

| Shown | Means |
|---|---|
| held | on account, free for any of the client's jobs |
| reserved | put aside for a job that is still alive |
| spent | nothing left on the source job's payments (applied or refunded) |
| released | a manager stopped holding it — back to "money to sort" on its job |

A reservation on a job since lost / cancelled reads as held again (no sweep, like
vouchers). `spent` is only STORED when the same job is held again later.

## 3. Code

- `services/account-credit.ts` — every read and write. `holdBlockReason()` (pure: why a
  job can't be held), `holdOnAccount()`, `holdForPlan()` (the plan's view; refreshes the
  amount; never throws), `reserveOnJob()` (guarded update), `unreserve()`,
  `releaseHold()`, `listForContext()`, `listForOrganisation()`.
- `services/hire-close-out.ts` — `CloseOutPlan.onAccount`. The amount is refreshed only
  from a live read with no blockers. With a hold, the surplus no longer stops
  `readyToComplete` / `completeHireJob`.
- `routes/account-credit.ts` (`/api/account-credit`): `GET /context`, `GET /`,
  `POST /hold`, `POST /:id/reserve`, and manager-only `POST /:id/release`,
  `POST /:id/unreserve`. `POST /hold` forces a live plan, so the figure held is HireHop's.
- Frontend: `lib/accountCredit.ts`; `components/account-credit/` —
  `HoldOnAccountModal`, `AccountCreditNote` (Client History, above Vouchers, on Job Detail
  and New Enquiry), `AccountCreditOrgList` (the client's Vouchers tab).
  `lib/closeOutPlan.ts` `closeOutView()`: `credit` is 0 once held, `onAccount` carries it.

## 4. Screens (PR 1)

- **Money tab, Payment History:** each payment row has one ⋯ menu — Refund · Apply to
  another job (managers) · Hold on account (only while there is overpaid money nobody has
  decided on). It replaced the two links, which crowded a phone.
- **Close-out panel:** "£68.40 overpaid — refund it, move it to another job, or hold it
  on account" with a **Hold on account** button. Once held: a blue line "£68.40 held on
  account for Gently Tender · free to use on their next job / put aside for job N", the
  pill moves on, and the panel's ⋯ has **Stop holding on account…** (manager, reason).
- **Financial Summary:** "In credit: £68.40 · held on account for …".
- **Refund / Apply to another job while held:** allowed, after a confirm naming the job
  the money is put aside for.
- **The client's other jobs and New Enquiry:** "Money on account — £68.40 already paid,
  overpaid on job 16489" with **Use on this job**; then "Put aside for this job".
- **The client's page:** Vouchers tab, "Money on account" above the vouchers.
- Each step writes a line on the timelines of the jobs it touches.

## 5. PR 2 — the next job knows (built 18 Nov 2026)

**The rule: money put aside for a job is NOT in HireHop's balance until that job is
invoiced, so no stored or HireHop-facing figure is changed.** `balance_outstanding`,
`job_financials` and everything sent to HireHop stay as they were; each read that works out
what the client still has to PAY subtracts it through one definition:

- `account-credit.ts` `listReservedForJob()` + `withCreditOnAccount(balance, reserved)`
  (covers at most what is owed; the rest stays on account), `creditOnAccountPhrase()`, and
  `reservedForJobSql(jobIdExpr)` for SQL reads. Never a second sum.
- **Money tab** (`GET /money/:jobId/summary` → `financial.on_account`): a blue line under
  the balance, "£68.40 on account from job 16489 comes off at invoicing. To pay now:
  £1,131.60". It counts towards the deposit (`deposit_paid`, "Minimum deposit … less
  what's on account").
- **Confirming:** the status modals (Job Detail and the pipeline board) offer **Credit on
  account** as a confirmation method only when money is put aside for the job
  (`useReservedCreditNote()`), and pre-fill the note "£68.40 held on account from job
  16489". `jobs.confirmed_method = 'credit_on_account'`. Nothing confirms by itself.
- **Pre-hire briefing** (`pre-hire-briefing.ts` `BriefingMoney.on_account / to_pay /
  on_account_label`): the staff email and discussion point say what to ask the client for;
  the client draft says "we're holding £68.40 from your last hire towards this one".
- **Wise matcher** (`wise-incoming.ts` `expected.remainingLessCredit`): a transfer for the
  balance less the credit is recognised as the balance.
- **Cash forecast** (`cashflow-sources.ts` `loadJobBalances()`): the job's expected
  receipt is the balance less the credit — that money is already in the bank.
- **Keeping the figure true:** after a Refund or Apply to another job on a job whose money
  is held, the route re-reads HireHop at once (`refreshHoldAfterMoneyMoved()`), so the job
  it was put aside for never counts money that has gone.

Still not known: the payment portal and HireHop's own documents (PR 4 / never). The Money
tab line and the staff briefing both say so. On a phone the Client History panel is hidden
(as it is for vouchers), so "Use on this job" is a laptop action; the Money tab line shows
on a phone.

## 6. Still to build

- **PR 3 — close-out applies it.** The plan gains "This will also apply £68.40 from job
  16489 to this invoice"; the one button applies it in HireHop and Xero on the existing
  cross-job mechanism (`/money/:jobId/apply-credit`, `sourceJobRows()`), each write read
  back; what the invoice doesn't need stays on account.
- **PR 4 — the payment portal** (`netlify-functions`): OP's `job-lookup` carries the
  credit, the portal subtracts it and lists it as "Credit from a previous booking".
- Not planned: a cancelled job's refund held on account; a hold for a client with no
  organisation; moving a hold between clients.
