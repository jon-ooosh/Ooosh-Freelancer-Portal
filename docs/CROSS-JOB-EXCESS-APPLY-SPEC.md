# Cross-Job Credit → Invoice Apply — Spec

*(formerly "Cross-Job Excess Apply" — broadened Jun 2026 to cover non-excess credits too; excess is the proven core case.)*

**Status:** excess path proven, ready to build (Jun 2026)
**Proof:** live application id **11962** — £137.62 of Skindred's excess held on job 15865 (deposit 8163, physically rolled from 15577) applied to OT-INV-11574 on the unrelated rehearsal job 15278. HireHop accepted, Xero synced, 15278 read £0 owing. Driven by `backend/src/scripts/cross-job-excess-apply.ts`.

## Problem

A client holds money on Job A — an **excess deposit**, OR a **non-excess credit** (hire overpayment, a standalone deposit). The same client owes a balance on Job B (a different, unrelated job — e.g. a rehearsal with no van/excess of its own). We want to settle B's balance out of A's held money and refund/handle any remainder.

**This is the "merge tool, but for an individual payment of any type."** HireHop can't *relocate* a deposit between jobs (that's why OP tracks "which job the money is really on"), but its API **can apply** a deposit on A to an invoice on B — `OWNER=<invoice on B>` + `deposit=<deposit on A>` — regardless of whether that deposit is an excess deposit. The mechanism is identical for excess and non-excess; only the OP-side tracking differs (see "Source types").

### The original framing (excess) — still the proven core

A client's held *excess* sits as a HireHop deposit on Job A. The accountant wants to settle B's balance out of A's excess and refund the remainder. This is the case proven by application 11962 and shipped first.

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

## Source types: excess vs non-excess

The HH application is identical; only OP tracking differs by where the money sits:

| Source | OP tracking on apply | Surfaced on |
|---|---|---|
| **Excess deposit** (linked `job_excess` record) | accumulate `claim_amount` on the excess record; recompute status (proven path) | Excess card + B-side marker |
| **Non-excess credit** (hire overpayment / standalone deposit, no `job_excess` row) | **none to maintain** — OP reads HH live. Write a `job_payments` audit row + the B-side marker. | A's payment history (live) + B-side marker |

So the non-excess case is actually *simpler*: HH is the truth, both jobs' Money tabs reflect it on next read, OP just logs the audit + the link. Source = any held deposit/credit the client has on Job A (the Money tab already enumerates these from `billing_list`). If the selected source is an excess deposit tied to a `job_excess` record, route through the excess claim path so `claim_amount` stays right; otherwise it's a pure HH application.

### ⚠ Bank handling — read the source deposit's real bank, surface it (don't silently auto-derive)

The existing `/claim` endpoint hardcodes `bank: 169` (Worldpay) with a "metadata only" comment. In the live test the £137.62 therefore showed as **Worldpay** even though the excess was collected by **Wise/BACS**.

**Investigated (Jun 2026):** the bank id is **not load-bearing** — nothing in OP keys off it (classification is keyword-based via `isExcessPayment`; no `=== 169` branching anywhere). It's display + Xero attribution only. The **reimburse** path already derives bank from method (`HH_BANK_IDS[method] || 265`); only **claim** hardcodes 169 — an asymmetry, not a designed sentinel (no recorded rationale; original commit lost in the 29 May squash).

**But do NOT "fix" it by auto-deriving from the record's `payment_method`** — that is **silently wrong on rollover chains**, where `payment_method='rolled_over'` maps to 265/Wise and may not be the true original bank. The obvious-but-wrong Worldpay default was very likely left deliberately so a human notices and sets the right bank rather than the system mis-attributing silently.

**Correct resolution:**
1. **Default** the bank from the **source deposit's actual `ACC_ACCOUNT_ID`** read from HH billing for that deposit — authoritative regardless of rollover.
2. **Surface it as a confirmable field** in the apply flow (pre-filled from #1) so a human sees/sets it before posting — honours the "human confirms the bank" intent while making the default correct.
3. Only if the deposit's bank can't be read, fall back to a clearly-flagged default and require explicit confirmation.

Applies to the existing single-job `/claim` path too (same wart) — but ship it as "read-and-confirm," not "silent auto-derive." (Manual correction was needed on the proof's application 11962: Worldpay → Wise.)

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

**Excess path** — `ExcessPaymentModal` → Apply to Invoice flow:
- Keep this-job invoices as the default list.
- Add a collapsible **"Apply to another job (same client)"** section: lazy-loads the same-client open-invoice list, grouped by job (`#15278 — OT-INV-11574 — £137.62`), plus an **"or enter a job number"** input that calls the targeted lookup.
- Add the **confirmable bank field** (defaulted from the source deposit's real bank).
- On select, the existing claim form (amount + notes) runs unchanged; the confirm posts `invoice_id` (+ `target_hh_job` + `bank`).

**Non-excess path** — Money tab:
- A held deposit/credit row in Payment History gains an **"Apply to another job"** action (alongside Refund), reusing the same same-client invoice picker + bank field.
- Confirm posts to a Money-tab apply endpoint (pure HH application + `job_payments` audit + B-side marker) rather than the excess claim endpoint.
- A dedicated **"Apply credit to another job"** entry point on the Money tab can come later if the per-row action proves clunky.

## Target-job visibility

When excess is applied to Job B, B's Money tab should make the cross-job settlement **visible**, not just silently read £0:
- The application already appears in B's HH billing (so payment history shows it).
- Add a line on B's Money tab: *"£137.62 settled from {client} excess held on job #{A}"* — derived from the HH application's memo or a small OP linkage record. Otherwise the link is invisible from B's side and a future staff member can't see where the money came from.

## RBAC & audit

- Apply-to-invoice (incl. cross-job) stays in the existing excess tier (**STAFF_ROLES** — it's day-to-day excess work).
- `allow_cross_client` override (different `client_id`) is **MANAGER_ROLES** + requires a reason — applying one client's money to another's invoice is the dangerous case.
- Every apply logs the existing claim audit + the cross-job target in `claim_notes`. Consider a `job_excess` ↔ target-job link row if we want the B-side marker to be first-class rather than memo-derived.

## Build order

**Phase 1 — excess (proven core):**
1. **Bank handling** on `/claim` — read source deposit's real bank + make it a confirmable field (small, standalone, fixes the existing single-job flow too). Ship first.
2. **Cross-job invoice lookup** endpoints (same-client list + targeted job lookup, with the same-client guard).
3. **Claim endpoint** cross-job audit + same-client guard + `target_hh_job` + `bank`.
4. **Frontend** "Apply to another job" section in the Apply-to-Invoice flow.
5. **B-side marker** on the target job's Money tab.

**Phase 2 — generalise to non-excess credit:**
6. **Money-tab apply endpoint** — apply any held deposit/credit on this job to a same-client invoice on another job (pure HH application + `job_payments` audit + B-side marker). Reuses the picker + bank handling from Phase 1.
7. **Money tab UI** — per-deposit-row "Apply to another job" action.

Keep `scripts/cross-job-excess-apply.ts` as the reference implementation + emergency manual tool throughout.

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
