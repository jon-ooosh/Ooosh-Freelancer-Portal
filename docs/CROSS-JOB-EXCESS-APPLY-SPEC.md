# Cross-Job Excess → Invoice Apply — Spec

**Status:** proven, ready to build (Jun 2026)
**Proof:** live application id **11962** — £137.62 of Skindred's excess held on job 15865 (deposit 8163, physically rolled from 15577) applied to OT-INV-11574 on the unrelated rehearsal job 15278. HireHop accepted, Xero synced, 15278 read £0 owing. Driven by `backend/src/scripts/cross-job-excess-apply.ts`.

## Problem

A client's held excess sits as a HireHop deposit on Job A. The same client owes a balance on Job B (a different, unrelated job — e.g. a rehearsal with no van/excess of its own). The accountant wants to settle B's balance out of A's excess and refund the remainder.

HireHop **cannot relocate a deposit** between jobs (that's why OP's layer tracks "which job the money is really on" through rollovers). But HireHop's API **can apply** a deposit on Job A to an **invoice** on Job B — a payment application with `OWNER = <invoice on B>` + `deposit = <deposit on A>`. Our existing `/api/excess/:id/claim` endpoint already does exactly this (it's how a rollover damage-claim pays the current job's invoice from the original hire's deposit), and it never checks the invoice belongs to the excess's own job. **The mechanism is done; the only missing piece is a picker that can surface another job's invoice.** The proof confirmed it works even when Job B is entirely unrelated to the excess chain.

## Scope boundary: same client only

The picker must never list invoices globally (thousands) — and it doesn't need to. You can only ever legitimately apply a client's excess to **that same client's** invoices. So the correctness boundary *is* the size boundary:

- Match on `jobs.client_id` (the Xero contact FK), **not** `client_name` (a denormalised display string that legitimately differs — 15865 showed "Simon Hutchby", 15278 "Skindred", same `client_id`).
- A given client has a handful of jobs, very few with an open balance → a short list.

## Settlement model (confirmed: real settlement)

For an HH-linked excess with a known `hh_deposit_id`:

1. **Apply** `amount` via `POST /php_functions/billing_payments_save.php`:
   `{ id:0, date, desc, paid:amount, memo, bank:<source bank — see below>, OWNER:<target invoice HH id>, deposit:<excess hh_deposit_id>, correction:0, no_webhook:1 }`
2. **Xero sync** via `accounting/tasks.php` `hh_task:'post_payment'` on the returned application id (same as a normal claim/reimburse — NOT `post_deposit`).
3. **OP**: accumulate `claim_amount += amount` on the source excess record, append a `claim_notes` line (`[date] £X cross-job claim → job <B> invoice <number>`), recompute status (`fully_claimed` only if claims fully consume the deposit with no reimbursement).

HH push happens **first**; OP is updated only on HH success (502-equivalent abort leaves OP untouched — same loud-fail contract as `/claim`/reimburse).

### ⚠ Bank metadata fix (surfaced by the proof)

The existing `/claim` endpoint hardcodes `bank: 169` (Worldpay) with a "metadata only" comment. In the live test the £137.62 therefore showed as **Worldpay** in HireHop even though the excess was collected by **Wise/BACS** — wrong, and a reconciliation annoyance. **The apply must derive the bank from the source deposit**, not hardcode it:

1. Preferred: read the source deposit's actual `ACC_ACCOUNT_ID` from HH billing for the deposit, reuse it.
2. Fallback: map the excess record's `payment_method` → bank id via the existing map in `services/hh-deposit.ts` (`wise_bacs → 265`, etc.). For `payment_method='rolled_over'`, walk the chain (`hh_deposit_id`) back to the originating record's method.
3. Last-resort default only if neither is determinable, and log a warning.

**This fix should also be applied to the existing single-job `/claim` path** — same latent wart. (Manual correction was needed on the proof's application 11962: bank Worldpay → Wise.)

## Backend changes

1. **Invoice lookup, extended.** New `GET /api/excess/:id/outstanding-invoices?cross_job=1` (or a sibling endpoint) returns, in addition to this job's open invoices:
   - **Same-client open invoices**: find `jobs WHERE client_id = <excess job's client_id> AND hh_job_number <> <this job>`; for each, fetch `billing_list.php` (low priority, short cache), collect kind:1 rows with `owing > 0`. Cap the job fan-out (e.g. most-recent 25 same-client jobs) and lazy-load only when staff expand the cross-job section.
   - Each entry carries `{ hh_job_number, op_job_id, invoice_id, number, description, owing }` so the UI can group by job.
2. **Targeted job lookup.** `GET /api/excess/:id/job-invoices/:hhJobNumber` — fetch open invoices for a specific same-client job (the "or enter a job number" fallback). Validates same `client_id`; 409 with a clear message if different (overridable only by an explicit `allow_cross_client` flag, manager-gated).
3. **Claim endpoint.** `POST /api/excess/:id/claim` already accepts an arbitrary `invoice_id` — minimal change:
   - Derive `bank` from the source deposit (above) instead of `169`.
   - Accept an optional `target_hh_job` for clearer audit + the cross-job memo/description.
   - Add a **same-client guard** (the invoice's job must share `client_id` unless `allow_cross_client` + manager role) — the picker enforces it, but the endpoint is the real boundary.
   - Description/memo note the cross-job target when it differs from the excess's own job.

## Frontend changes

`ExcessPaymentModal` → Apply to Invoice flow:
- Keep this-job invoices as the default list.
- Add a collapsible **"Apply to another job (same client)"** section: lazy-loads the same-client open-invoice list, grouped by job (`#15278 — OT-INV-11574 — £137.62`), plus an **"or enter a job number"** input that calls the targeted lookup.
- On select, the existing claim form (amount + notes) runs unchanged; the confirm posts `invoice_id` (+ `target_hh_job`).

## Target-job visibility

When excess is applied to Job B, B's Money tab should make the cross-job settlement **visible**, not just silently read £0:
- The application already appears in B's HH billing (so payment history shows it).
- Add a line on B's Money tab: *"£137.62 settled from {client} excess held on job #{A}"* — derived from the HH application's memo or a small OP linkage record. Otherwise the link is invisible from B's side and a future staff member can't see where the money came from.

## RBAC & audit

- Apply-to-invoice (incl. cross-job) stays in the existing excess tier (**STAFF_ROLES** — it's day-to-day excess work).
- `allow_cross_client` override (different `client_id`) is **MANAGER_ROLES** + requires a reason — applying one client's money to another's invoice is the dangerous case.
- Every apply logs the existing claim audit + the cross-job target in `claim_notes`. Consider a `job_excess` ↔ target-job link row if we want the B-side marker to be first-class rather than memo-derived.

## Build order

1. **Bank fix** on `/claim` (small, standalone, fixes the existing flow too). Ship first.
2. **Cross-job invoice lookup** endpoints (same-client list + targeted job lookup, with the same-client guard).
3. **Claim endpoint** cross-job audit + same-client guard + `target_hh_job`.
4. **Frontend** "Apply to another job" section in the Apply-to-Invoice flow.
5. **B-side marker** on the target job's Money tab.
6. Retire / keep `scripts/cross-job-excess-apply.ts` as the reference implementation + emergency manual tool.

## Out of scope (deliberately)

- Relocating a deposit between jobs (HH can't; not needed — apply-to-invoice covers the real need).
- Cross-**client** apply as a normal flow (manager override only, by design).
- Splitting one apply across multiple invoices in one click (one invoice per apply, as today's claim flow).

## Reference: the proven payload

```
billing_payments_save.php
{ id:0, date:'2026-06-29',
  desc:'15865 - Excess applied to invoice (cross-job → 15278)',
  paid:137.62, memo:'Excess claim — cross-job apply to job 15278 invoice OT-INV-11574',
  bank:169 /* ← must become the source deposit's bank, Wise/265 here */,
  OWNER:11652 /* 15278's invoice HH id */,
  deposit:8163 /* the excess deposit, physically on 15577 */,
  correction:0, no_webhook:1 }
→ application id 11962, Xero post_payment synced, 15278 owing £0.
```
