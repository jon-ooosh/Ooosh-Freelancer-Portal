# Hire Close-Out (Bookkeeping) — Spec

**Status (9 Oct 2026): PLANNED. Nothing built.** This is the "bookkeeping module" that
`docs/reference/HIREHOP-BILLING-API.md` §8 says the shop close is the base of. §1 is what
jon settled in the design discussion; §4 is the flow; §9 is the build order and the
captures that must happen before Phase 2. Read `HIREHOP-BILLING-API.md` §0 and §8
first — every HireHop write here follows its three rules.

---

## 0. Why — one dialog, two outcomes

Finishing a hire today means someone opening HireHop's **Billing** tab, selecting a
deposit, pressing **New payment**, and choosing an invoice from the "Allocated to
invoice" dropdown. That dropdown defaults to **none**. With an invoice chosen the row is
an allocation; with **none** it is a **refund to the client** (`OWNER = 0`). Same
button, same dialog, one dropdown apart, and the wrong value is the default.

Job 16015 (Sep 2026): the £1,140.97 first deposit was "paid" with no invoice selected.
HireHop recorded a refund, pushed it to Xero, and showed £254.17 owed. Stripe still held
the money. OP mirrored HireHop faithfully. The payment portal, by a separate bug (now
fixed, netlify-functions PR #33), happened to show the true cash position and was the
only screen anyone questioned. A hand process verified nothing; three systems disagreed
and only a coincidence surfaced it.

Everything that arrives as money already comes through OP (portal → Stripe webhook,
Wise matcher, staff Record Payment, Stripe Terminal soon). What is still done by hand is
the other end: raising the invoice, allocating the deposits, applying the credit in Xero,
completing the job. OP already does all four for the shop week (`services/shop-close.ts`,
live since 28 Sep 2026). This module does them for hires, one job at a time, with a human
pressing each step and HireHop + Xero read back after every write.

**The prize:** once OP covers the whole normal close, HireHop's "Add a new payment" and
"Create a new deposit" permissions (separate ticks in the user-role screen, verified
8 Oct 2026) can be switched off for everyone but managers. The 16015 mistake becomes
structurally impossible rather than merely discouraged.

---

## 1. Settled decisions (jon, 8–9 Oct 2026)

1. **One job at a time, human-driven, from the post-hire close-out cards.** No batch
   runner, no scheduler. Blast radius is one job. The cards already exist and already read
   their state from HireHop (`invoice`, `payment_reconcile`, `excess_resolve` in
   `RETURNS-AND-CANCELLATIONS.md`); this module adds the actions behind them.
2. **Refuse loudly, never improvise.** Shop-close discipline: pre-flight, then act, then
   read back; any disagreement stops with a sentence a human can act on. A stopped step
   has changed nothing it has not already reported.
3. **Order: invoice → excess decision → allocate → complete.** Applying excess needs an
   invoice to apply it to, so the invoice comes first. The excess decision is a human step
   in the middle; this is a stepper, not a button.
4. **Excess is a warning, not a gate.** The Complete step says what excess is still held
   and offers Manage or Complete anyway (an insurance claim can run on after the hire
   invoice is settled). Excess deposits are **never** allocated by this module; they reach
   an invoice only through the existing claim flow (`routes/excess.ts` `/:id/claim`).
5. **Never silently move money.** Allocation is bookkeeping (notes in a drawer onto a
   bill). Anything that would send money back out — a surplus, a refund — is surfaced with
   the choices and left to a person. The existing refund route stays the only refund path.
6. **More than one invoice is allowed; split-party invoicing is not.** Recharges raised
   after the main invoice, staged billing on long hires and (later) cancellation fees all
   produce extra invoices and must allocate correctly. "Bill days 1–2 to X and 3–4 to Y" is
   a policy no: an invoice is made out to whoever the job is made out to.
7. **"Raise invoice" bills only what is not yet invoiced.** PROVEN 9 Oct 2026 (job 15745,
   `HIREHOP-BILLING-API.md` §3): `all: 1` picks up only lines with `invoiced_so_far` = 0,
   so a later charge is just another `all: 1` call.
8. **Allocation spreads across open invoices, oldest first**, allocating
   `min(deposit available, invoice owing)`, hire deposits only, oldest deposit first.
   **Phase 1 refuses a job with more than one OPEN invoice** ("two invoices owing — not
   yet supported, allocate by hand") until the first real two-invoice job has been walked
   through with the plan on screen; the rule is written, the live proof is not (§9 item 3).
9. **The HireHop permission lockdown waits for Phase 2** (Raise invoice) **and the
   additional-charges path.** Until then staff still need the Billing tab to invoice.
   Managers keep billing rights permanently as the escape hatch.
10. **Cancellation is a separate piece of work**, after this one. It will reuse the invoice
    call, the allocation step and the existing refund route, so it gets easier here.
11. **Invoice date = the day it is raised** (jon, 9 Oct). Never back-dated to the return
    date; the allocation is dated the same day, so Xero never sees an allocation before
    its invoice.
12. **"Apply to another job" is real HireHop bookkeeping, not an internal ledger.** It
    posts job A's deposit onto job B's approved invoice (`OWNER` = B's invoice,
    `deposit` = A's deposit) — live for excess (PR #711) and non-excess (PR #933). It
    needs B's invoice to exist first, so for B it is a step-4.1-then-apply sequence; for A
    it is one of the three surplus choices in §4.3. **Its Xero leg is probably a no-op**
    (§4.3 step 2) — capture 5.
13. **Tax code 33 (Zero Rated Income) for the non-UK portion** (jon, 9 Oct; bookkeeper to
    confirm). HireHop ids and Xero mappings: `HIREHOP-BILLING-API.md` §10.4.
14. **Applying credits in Xero is automatic.** It is bookkeeping that mirrors what HireHop
    already says, it writes nothing to HireHop, and it is idempotent, so it runs as a sweep
    (§4.3 step 2) as well as inside the stepper. Everything else stays human-pressed.
15. **Credit notes stay manual.** Creating one is not captured (`HIREHOP-BILLING-API.md`
    §7) and carries the Xero 2263 trap. Compensation is a discount on the job's lines before
    invoicing (preferred), a credit note by hand before payment, or a partial refund after.

---

## 2. Scope

**In:** the four steps in §4 on a returned, non-internal hire job; the allocation rule
(§5); pre-flight checks (§6); the run log; the arrival hook (Phase 3); raising an
additional invoice for charges (Phase 4).

**Out, deliberately:** cancellation (own spec next), credit notes, voiding invoices,
anything that refunds (existing routes), batch or scheduled closes, invoices to a party
other than the job's client, excess decisions (existing excess flows own them).

---

## 3. Where it lives

The **Post-Hire** tab on Job Detail, on the existing cards. Status text stays as it is
(derived from HireHop by `hh-requirement-derivation.ts`); each card gains one primary
action and reads back after it.

| Card | Today | Adds |
|---|---|---|
| **Invoice** | "Generated" when any kind=1 row exists; "Mark as Sent" | **Raise invoice** (Phase 2) — draft from uninvoiced lines, penny check, approve, push to Xero. Shows the invoice(s), their status and Xero cloud |
| **Excess Resolution** | Resolution-authoritative pill; Manage → existing modal | Unchanged. The Complete step reads its state |
| **Payment Reconciliation** | "Reconciled" when owing ≤ 0 | **Allocate payments** (Phase 1) — the plan (§4.3) shown first, then HireHop + Xero allocation, read back. Surfaces any surplus with its three choices. Staff-facing wording stays about HireHop ("allocated", "balance owed", "reconciled"); the Xero fact ("credit applied in Xero" / "awaiting") is one **admin-only** line, because only jon and the bookkeeper act on it and the sweep is automatic (jon, 9 Oct) |
| *(new, bottom of the tab)* | — | **Complete job** — enabled when Invoice and Payment cards are green; amber with override when excess is still held |

Two cards, not one, for now: both requirement types already exist on every returned
job and the Returns page counts their dots, so merging them is a migration plus a
derivation change for no proven gain. They are written to read as consecutive steps of
one flow; revisit merging after Phase 2 (jon asked, 9 Oct).

Design rule for the cards (jon: "it needs to flow and make sense"): every action shows
**what it will do before it does it** — the plan is a list of sentences ("Allocate
£4,629.82 of payment 9091 to OT-INV-12252", "Leave £886.80 of payment 8661 unallocated —
decide below"), then one button. After it runs, the same card shows the read-back
("OT-INV-12252 shows £0.00 owing in HireHop and £0.00 due in Xero"). The run log (§7) is
behind a disclosure on the card, like the shop's.

Use `StaffCard.tsx` primitives for anything new; the Money tab and the Returns page are
read-only consumers of the same HireHop state and need no change.

---

## 4. The flow

Every step: **pre-flight → one HireHop write at a time → read back → log**. Every step is
idempotent and resumable: it reads HireHop first and skips what already exists, so a job
half-closed by hand is adopted, not refused (unlike the shop, which refuses an existing
invoice because it only closes weeks it invoiced itself — rule 9 below replaces that).

### 4.1 Raise invoice (Phase 2)

Pre-flight stops if: the job is internal; HireHop status < 6 (not returned) unless a
manager overrides; "Net to invoice" is £0.00 (nothing to bill — card says so and offers
nothing); a **draft** invoice already exists (adopt it: skip to the penny check).

1. **Draft** — `billing_save.php` as `shop-close.ts` does (`all: 1`, `ref` = the job's
   name and dates so the Xero Reference reads well). Read back: one new kind=1 row at
   status 0. The broker retries POSTs, so count drafts before and after, never trust the
   reply.
2. **Penny check** — draft gross = HireHop's own quoted total inc VAT for the uninvoiced
   lines (for a first invoice, the kind=0 accrued × VAT). The shop also checks "= payments
   held"; a hire does **not** (balances owed and overpayments are normal) — it reports the
   difference instead. Stop at the draft on a mismatch; a draft never reaches Xero.
3. **Approve** — `billing_save_status.php` status 2, dated the return date (open question
   §10.3). Read back `STATUS >= 2` and a `NUMBER`. Never approve an invoice already ≥ 2.
4. **Invoice → Xero** — `syncSavedRowToXero` with `hh_task: post_invoice_credit`
   defaulted (the helper's default is `post_payment`, wrong for an invoice). Read back
   `ACC_ID` on the row. A Xero refusal is an amber panel + `sendXeroSyncFailedAlert`,
   never a swallowed error (`money-excess.md`).

The Invoice card then shows the invoice; "Mark as Sent" stays a manual click.

### 4.2 Excess decision (existing flows — no new code)

The Excess Resolution card already owns this. Before allocation the Payment card shows a
one-line note if any `job_excess` record is non-terminal: "£1,200 excess still held
(Aaron Thomas Duffy) — claim, roll over or reimburse from the Excess card". It does not
block. Excess deposits are excluded from §4.3 by the kind=6 pre-pass set (the same
`isExcessPayment` text test `money.ts` and `hh-billing-deposits.ts` use — keep them in
sync).

### 4.3 Allocate payments (Phase 1)

Pre-flight stops if: no approved invoice exists (card says "Raise the invoice first");
any §6 mismatch; HireHop or Xero unreachable.

**The plan** (shown before the button): computed from a fresh `billing_list.php` read by
the rule in §5. Lists each allocation, each invoice's resulting owing, and any surplus.

**Execute:**
1. For each planned allocation: `billing_payments_save.php` `{ id: 0, OWNER: <invoice>,
   deposit: <deposit>, paid: <amount>, bank: <the DEPOSIT's bank>, desc: '', date: today,
   no_webhook: 1 }`. One write, then re-read the billing rows and confirm the deposit's
   `-owing` fell by the amount and the invoice's `owing` fell by the amount. Stop on any
   disagreement; allocations already made stand and are skipped on the next press.
2. **Apply in Xero** — `applyCreditsInXero` lifted out of `shop-close.ts` into a shared
   service: for each invoice-side application row, the deposit's `ACC_DATA.OverpaymentID`
   → `xeroBroker.getOverpayment` → allocate only what is not already applied to this
   invoice → `allocateOverpayment`, dated today. Then `GET /Invoices/{ACC_ID}`: **Xero's
   `AmountDue` is the only judge of "paid"**. Multi-invoice: run per invoice.
   **Cover every invoice-side application on this job's invoices, not only the ones
   this step just made** — HireHop's own push for an allocation does nothing in Xero
   (§8 step 6, proven Sep 2026), so excess claims, cross-job applies and hand-made
   allocations have very likely been leaving Xero's invoice at "Awaiting payment" with
   the overpayment unallocated, fixed by the office pressing "Apply credit" by hand. For a
   row whose `OWNER_DEPOSIT` is **not on this job** (cross-job target side) the
   `OverpaymentID` lives on the SOURCE job's deposit row, so read that job's billing too
   (the application row's description names the source job: `"<job> - …"`). Capture 5
   **CONFIRMED 9 Oct 2026** (jon, in Xero): every deposit sits as an unapplied overpayment
   and every invoice as Awaiting payment until the bookkeeper applies the credit by hand;
   nothing OP has pushed has ever allocated in Xero except the shop close. So this step
   sweeps **all** of a job's allocations, `apply-credit` and `/:id/claim` call the same
   shared step after their HireHop write, and **the same step runs on its own** for jobs
   that already carry HireHop allocations — a nightly sweep over jobs invoiced in the last
   N months whose Xero invoice still shows AmountDue > 0 (jon, 9 Oct: "if everything
   matches, just do it"). It is the one automatic piece besides the arrival hook, and it
   is safe to be: no HireHop write, idempotent by construction, Xero's AmountDue is the
   judge, and a job whose figures don't match is skipped, logged (§7, `user_id` NULL) and
   listed on the Money overview rather than guessed at. Gated by a `system_settings`
   toggle like the arrival hook.
3. **Read back**: each targeted invoice's HireHop `owing` and Xero `AmountDue` match the
   plan. The card shows the result; `payment_reconcile` re-derives to "Reconciled" when
   every invoice is at £0.00.

**Surplus** (deposits still holding money after every open invoice is at £0.00): the card
shows "£886.80 of payment 8661 is unallocated" with three choices, all existing routes:
**Refund** (`POST /money/:jobId/refund-payment`, Stripe-first), **Apply to another job**
(`POST /money/:jobId/apply-credit`, same-client guard), **Hold on account** (no HireHop
change; a To Do is created on the job so it is not forgotten). The module never picks one.

**Balance still owed** (invoices at > £0.00 after every hire deposit is used): the card
says so and the portal link is right there. Nothing else to do until money arrives (§4.5).

### 4.4 Complete job

Enabled when every approved invoice shows £0.00 owing in HireHop **and** Xero and no
hire deposit holds money (or a Hold-on-account decision is recorded). Amber, with
"Complete anyway (excess still held)" for a manager, when `job_excess` has a non-terminal
record. `status_save.php` status 11, read back. The 30-minute HireHop sync carries 11
into `pipeline_status = completed`; do not set it locally first (`hirehop.md`).

### 4.5 Arrival hook (Phase 3)

The one automatic piece. When `recordPayment()` or the Stripe webhook's payment-event
lands a **hire** (non-excess) deposit on a job that has **exactly one approved invoice
with owing > 0** and no §6 mismatch, run §4.3 for that deposit alone and, if that leaves
every invoice at £0.00 and nothing unallocated, run §4.4 with no excess override (an
excess still held means it stops at "ready to complete" and leaves the card amber). Any
other shape does nothing and leaves the card for a human. Logged like a manual run with
`user_id = NULL`.

---

## 5. The allocation rule

Inputs, from one `billing_list.php` read: open approved invoices (kind=1, `STATUS ≥ 2`,
`owing > 0`, not proforma) sorted by date then id; hire deposits (kind=6, `credit > 0`,
not excess by the text test) with `available = min(-owing, credit - paid)` per
`readDepositAvailability()` (which already nets off `OWNER = 0` refund rows), sorted by
date then id.

```
for invoice in invoices (oldest first):
  for deposit in deposits (oldest first) while invoice.owing > 0:
    amount = min(deposit.available, invoice.owing)
    if amount >= £0.01: plan(deposit → invoice, amount); deposit.available -= amount; invoice.owing -= amount
surplus = deposits still with available >= £0.01
shortfall = invoices still with owing >= £0.01
```

Worked examples (figures from the three live jobs in `HIREHOP-BILLING-API.md` and this
week's incident):

| Job state | Plan | Then |
|---|---|---|
| 16015 as HireHop read it on 8 Oct (8661 refunded, 9091 + excess 9093 already applied) | Nothing to allocate (9091 at £0 available; 9093 is excess) | Shortfall £254.17 → "balance owed", portal link |
| 16015 corrected (refund row deleted; 8661 holds £1,140.97) | 8661 → OT-INV-12252 £254.17 | Surplus £886.80 on 8661 → three choices |
| Clean one-invoice hire, deposits = invoice | each deposit → the invoice in full | Complete |
| Main invoice settled, then a £120 damage recharge invoiced, client pays £120 via portal | new deposit → recharge invoice £120 (arrival hook, Phase 3) | Complete |
| Long hire billed in two stages, one deposit of £3,000 against invoices of £1,800 then £1,500 | deposit → inv A £1,800; deposit → inv B £1,200 | Shortfall £300 → balance owed |

Cross-job rows: an application whose `OWNER` is an invoice **not on this job** is money
that left (source side) and is neither available nor owing here; one whose
`OWNER_DEPOSIT` is a deposit not on this job (target side) has already reduced this
invoice's owing. Both are already in HireHop's figures; the rule needs no special case,
but the plan must **display** them so the numbers add up on screen
(`CROSS-JOB-EXCESS-APPLY-SPEC.md`).

---

## 6. Pre-flight mismatch checks (refuse, name the problem)

| Check | Why | Message shape |
|---|---|---|
| Every positive kind=6 hire deposit has an OP `job_payments` row (by `hirehop_deposit_id`) and vice versa, amounts equal | A hand-entered deposit, or one OP recorded that never reached HireHop | "Payment 8661 (£1,140.97) is in HireHop but OP has no record of it — check how it was taken" |
| Every `OWNER = 0` refund application has an OP refund record (`job_payments` source refund / `refund_legs`) | **This is the 16015 check.** HireHop says money went back; OP says it never did | "HireHop shows £1,140.97 refunded from payment 8661 on 25 Sep but OP has no refund — if nobody refunded it, delete that row in HireHop (and its Xero mirror) and try again" |
| Every deposit to be allocated has `ACC_DATA.OverpaymentID` | Pre-OP deposits may never have reached Xero | "Payment 7001 isn't in Xero as a payment, so there's no credit to apply" |
| Every approved invoice has `ACC_ID` | Invoice never reached Xero | push it (§4.1 step 4) or stop |
| Job is not internal; `pipeline_status` not cancelled/lost | Nothing to invoice; cancellation has its own path | card hidden |
| No OP operation in flight on the job (advisory lock, as `withShopDrainLock`) | Two people pressing at once | "Someone else is closing this job — try again in a moment" |

---

## 7. Data

One table, no state columns on `jobs` (state is always re-read from HireHop):

```sql
CREATE TABLE job_closeout_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES jobs(id),
  step        VARCHAR(40) NOT NULL,      -- 'preflight' | 'draft' | 'penny' | 'approve' | 'invoice_xero' | 'allocate_hh' | 'allocate_xero' | 'complete' | 'arrival'
  ok          BOOLEAN NOT NULL,
  detail      TEXT NOT NULL,
  hh_refs     JSONB,                     -- { invoiceId, depositId, applicationId, amount } — JSON.stringify on write
  user_id     UUID REFERENCES users(id), -- NULL = arrival hook
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON job_closeout_log (job_id, created_at);
```

Register the migration in `backend/src/migrations/run.ts`. Hold-on-account is a To Do
(`staff_tasks`, `source_type = 'job_closeout'`), not a column.

---

## 8. Reuse map — there is already a helper

| Need | Use |
|---|---|
| Read billing rows, deposit availability | `hh-deposit-release.ts` `readBillingRows()`, `readDepositAvailability()` |
| Draft, penny, approve, Xero push, allocate HH, allocate Xero, complete | lift from `shop-close.ts` into `services/hh-invoice-close.ts` (shared by shop and hire; shop keeps its own pre-flight and period bookkeeping) |
| Xero invoice / overpayment / allocation | `xero-broker.ts` `getInvoice`, `getOverpayment`, `allocateOverpayment` |
| HireHop → Xero task | `hh-xero-sync.ts` `syncSavedRowToXero` (pass the whole save response) + `sendXeroSyncFailedAlert` |
| Hire vs excess deposit text test | `hh-billing-deposits.ts` `isExcessText` (mirror of `money.ts`) |
| Refund / apply to another job | `routes/money.ts` `refund-payment`, `apply-credit` — called from the card, never re-implemented |
| Excess state for the warning | `job_excess` terminal set as in `syncExcessRequirementStatus()` |
| Card status derivation | `hh-requirement-derivation.ts` (unchanged; it will simply find the rows this module creates) |
| Talking to HireHop at all | `hirehop-broker.ts`; gate every local mirror on `pushResult.success`, verify by reading back |
| Today's date | `uk-date.ts` `ukToday()` |

---

## 9. Build order and the captures that gate it

**Phase 1 — Allocate payments** (on jobs invoiced by hand). Shared service extracted from
the shop close; the plan + button on the Payment Reconciliation card; §5, §6, §7; surplus
choices wired to existing routes; Complete job step. Manager-tier to press
(`MANAGER_ROLES`; review after a month — allocation moves no cash). Shop close keeps
working unchanged (regression: close a shop week after the extraction).

**Phase 2 — Raise invoice.** Needs capture 1. Then the lockdown of HireHop payment and
deposit permissions for non-managers.

**Phase 3 — Arrival hook.** Small once Phase 1 exists; gated by a `system_settings` toggle
so it can be switched off without a deploy.

**Phase 4 — Additional charges.** "Add a charge" on the Damage & Issues card: adds a job
line (OP already adds lines to HireHop jobs for the shop — reuse) with a nominal picked
from a short list (Vehicle damage 184, Premium Splitter hire 185, Misc income, cleaning…)
then Raise invoice bills just that line. Needs captures 1 and 2. The excess claim picker
then sees the new invoice as it does today.

**Captures (status 9 Oct 2026 — payloads in `HIREHOP-BILLING-API.md` §3, §10):**
1. ✅ **Partial invoicing** — `all: 1` bills only uninvoiced lines; `all: 0` makes an empty
   draft for hand-picked lines.
2. ✅ **Lines** — adding (`items_batch_save.php`) and editing (`items_save.php`) a job line;
   VAT is NOT on the job line but on the INVOICE line (`billing_save_item.php`, tax code
   id 33 = Zero Rated Income); hand-picking lines onto a draft (`billing_assign_list.php` →
   `billing_save_items.php`) with price, discount, VAT and nominal per row.
3. ⏸ **Two settled invoices** — none found in the wild; deferred. Phase 1 refuses more than
   one open invoice (§1.8) and the first real one is walked through live.
4. ✖ **16015's refund row** — deleted before capture. Not needed: OP's own refund route
   posts the same `OWNER: 0` shape and 16043's rows were captured earlier (§5).
5. ✅ **Xero** — nothing is applied automatically; see §4.3 step 2.
6. ✅ **Tax codes** — `HIREHOP-BILLING-API.md` §10.4.
7. ✅ **A custom line on an invoice** — HireHop's "New custom item" is
   `billing_save_item.php` with `id=0`, `kind=3`, a `note`, `unit`/`total`, `vat_id`,
   `nominal_id` (`HIREHOP-BILLING-API.md` §10.3b). No job item behind it. This is the EU
   split's zero-rated line; the charge-item fallback is dropped.

### 9.1 How to capture

Chrome DevTools (F12) → **Network** → tick **Preserve log** → filter **Fetch/XHR**. Do the
action in HireHop. Click the request (`…_save.php`, `billing_list.php`) → **Payload** tab,
"view source", copy; **Response** tab, copy. Paste both into the chat with one line saying
what you clicked. Only the URL path matters from the headers — leave cookies out, and strip
a `token=` if one appears in the URL. For a read-only capture (3, 4) just reload the Billing
tab and copy the `billing_list.php` response. Drafts never reach Xero, so for capture 1
stop at the draft, and delete the drafts afterwards. Nothing in captures 1–3 needs a
deposit on the scratch job (a deposit creates a real Xero overpayment).

---

## 10. Open questions

### 10.1 EU hires — proposed: fix the VAT on the INVOICE lines; the job is never touched

The rule already exists and is already what the client has been told (`vat-adjustment.ts`,
ported from the portal; HMRC 741A): vehicle and equipment revenue is 0% for the non-UK
days (proportional, by nominal group), 0% on the whole vehicle hire at 31+ days, and
services / delivery / crew / storage / rehearsals stay at 20%. The trigger is the
"Non-standard VAT rules" item whose quantity is the non-UK days.

**Today's fudge** (jon): add dummy "EU van" / "EU backline" items to the job (which lose
their nominal codes), discount the real lines down to the UK-taxable amount, invoice the
dummy lines at 0%. Done by hand, every time.

**What the captures changed.** VAT lives on the invoice line, not the job line
(`HIREHOP-BILLING-API.md` §10), and a job line can be put on an invoice **once only** (jon,
9 Oct — never twice, so no "same line at two rates"). So Raise invoice drafts from the
job's lines as they are and then corrects the DRAFT, and the job's supply list, status,
prep and availability are never involved — which answers the "won't this move the job to
prepping?" worry: nothing is added to the job.

**The method — the invoice-line VAT split: today's fudge, on the invoice instead of the
job, with nominals kept, by API:**

- **31+ days**: set every vehicle line to tax code 33 (`billing_save_item.php`). No split.
- **Under 31 days**, per nominal group (vehicle group, equipment group — the same grouping
  `vat-adjustment.ts` already does): edit each real line's price down to its UK-days share
  at 20% (`billing_save_item.php`, `total` = the new net), then add ONE 0% line per group
  for the non-UK share — "Non-UK days (zero-rated, HMRC 741A): <n> of <m> days" — carrying
  that group's `nominal_id` and tax code 33. Pennies: the group's lines + its 0% line must
  equal the group's original net exactly (`reconcileLines` discipline); services, delivery,
  crew, storage and rehearsal lines are untouched. The 0% line is a **custom invoice
  line** (`billing_save_item.php`, `id=0`, `kind=3` — capture 7, §10.3b): no job item
  behind it, so nothing is added to the job.

One invoice, and the penny check compares its gross to
`calculateVatAdjustment()`'s adjusted total (what the portal showed the client), and Xero
receives the right tax type on every line so the VAT return is right untouched. The quote
keeps showing full UK VAT until invoicing, which is what the portal's wording already
says. Done at invoice time, not quote time (the quote is edited too often before then).
Tax code 33, bookkeeper to confirm (§1.13). The cancellation-fee invoice will use the
same line-level machinery (jon, 9 Oct).

### 10.2 Who may press "Complete anyway" with excess held — manager, or any staff?

### 10.3 Hold on account — is a To Do enough, or does the Money tab want a pill?

---

## 11. Deliberately not built

Batch closes · scheduled closes · credit notes · voiding invoices · split-party
invoices · any refund path other than the existing routes · editing allocations (release
back off an invoice stays in `hh-deposit-release.ts`, used by the excess flows) ·
cancellation (next spec).
