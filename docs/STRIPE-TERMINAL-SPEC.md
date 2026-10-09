# STRIPE TERMINAL SPEC — in-person card payments driven from OP

**Status:** 📋 PLANNED (6–7 Oct 2026) — jon + Claude. Nothing built. Hardware on order (Stripe Reader
S700); the build starts in a fresh session once it has arrived. Worldpay contract ends **March 2027**,
which is the crossover deadline, not the start date. §1 is the settled decisions (jon's 7 Oct answers
folded in); §9 has one open question left (online extended authorisation).

**Replaces:** the Worldpay card terminal and the Amex merchant account that runs through it, and
every manual "I took £X by Worldpay/Amex, as a payment/pre-auth" entry on the Money tab, the excess
Manage form and the shop till.

**Read first:** `docs/reference/MONEY-AND-EXCESS.md` (the "Payments, Oct 2026" section — PayPal via
Stripe, portal redesign, Wise matcher: this module reuses all of it), `.claude/rules/money-excess.md`,
`services/record-payment.ts`, `services/stripe-webhook.ts`, `services/stripe-event-claim.ts`,
`services/excess-preauth.ts`, `docs/SHOP-SALES-SPEC.md` §19 (the till's tenders).

---

## 0. One-line summary

> Staff press **"Take card payment"** on a job's Money tab (or the till), pick what it is for and
> which reader, and the amount appears on the reader. The client taps. Stripe tells OP by webhook,
> and OP records it through **exactly the path a portal payment takes** — OP row, HireHop deposit on
> the Stripe GBP bank, excess record, Booked push, client email. Nobody types an amount into a
> terminal, nobody tells OP what they did, nobody chooses Worldpay versus Amex, and a pre-auth cannot
> be put through as a payment because OP decides which it is.

## 1. Decisions (settled — don't re-litigate without jon)

1. **Stripe Terminal, server-driven integration.** No SDK on laptops, no pairing: OP's backend
   creates the PaymentIntent and sends it to the reader by API; the reader talks to Stripe over the
   office network. Any laptop can drive any reader. One reader processes one payment at a time;
   Stripe refuses a second push with `terminal_reader_busy`, which OP surfaces as "reader busy".
2. **Same Stripe account** as the payment portal. Same payouts, same webhook receiver
   (`POST /api/webhooks/stripe`), same `stripe_events` keyspaces. Money lands on the **Stripe GBP**
   HireHop bank (267) like portal money. No new bank accounts in HireHop or Xero.
3. **Hardware: ONE Stripe Reader S700** (Wi-Fi / Ethernet). The S710 is the same device with 4G
   added, for markets and vans; not needed at a desk. Fifteen years on one Worldpay terminal says
   one reader is enough; reception and the shop share it and "reader busy" is a wait, not a
   second purchase.
4. **No card-not-present payments over the phone any more — policy.** The portal link (already on
   every quote and proforma, and now on the Money tab) is what a remote client uses. Stripe's
   mail-order mode is deliberately NOT enabled: it brings card-typing back. A text-message link via
   `services/sms-service.ts` is a separate, later idea.
5. **Pre-auths follow the online portal's rules exactly** — which hires get a hold rather than a
   payment, how much, when it can be placed, how it is captured or released — and use Stripe's
   extended authorisation rather than the standard card-present hold (2 days, 5 for Visa). The
   Stripe account's industry is **"Car rentals"** (verified 7 Oct 2026), so the window is **30
   days** on Visa, Mastercard and Amex. The window is a MAXIMUM, not a duration: OP releases
   (cancels the PaymentIntent) or captures on return exactly as it does for the online hold, and
   the client's bank clears a released hold in a few days. Nothing new is invented here.
   **Opportunity to settle in the build, not before:** today a hire longer than the online hold
   window is taken as a payment and reimbursed afterwards (admin time and card fees both ways). A
   30-day in-person window means a hold could cover most hires instead. Verify the real
   `capture_before` on a live hold in Phase 2, and check whether the ONLINE portal's pre-auth can
   also request extended authorisation (Stripe offers it for card-not-present in some cases) —
   if so the same rule change applies to the portal. Decide the rule once, apply it to both.
6. **Recording goes through `services/record-payment.ts`.** Never a second chain. Terminal money is
   `payment_method = 'stripe_terminal'` (new enum value) so staff can tell in-person from online in
   the history, mapped to HireHop bank **267** and labelled "Card (terminal)". A refund is a Stripe
   refund against the payment intent, the same code the portal's refunds use.
7. **Receipts:** no paper and no Stripe receipt emails (the account setting stays OFF; OP's own
   payment and excess emails cover it). The excess **card-slip scan requirement**
   (`receipt_required`, raised for `worldpay` / `amex`) is NOT raised for terminal payments — the
   Stripe record is the audit trail.
8. **Fees are higher than Worldpay and jon accepts that** for the accuracy and time saved. No fee
   comparison is needed in the build.
9. **Worldpay and Amex stay available during crossover** (until March 2027). Nothing in this spec
   removes them; §8 Phase 4 retires them once the terminal has run cleanly for a month.
10. **Warnings, not gates.** A reader offline or busy is a message with a retry, never a blocked
    payment path; the online portal link remains the escape hatch on every screen.
11. **"Other amount" is for any staff member**, with a mandatory reason — the same people can
    already record any amount by any method today, so a tighter gate here would just push them
    back to the manual path.
12. **Admin-only while testing.** The "Take card payment" button (and the till tender) ship behind a
    `system_settings.stripe_terminal_roles` switch defaulting to admin only; jon widens it to all
    staff once the first live payments have run cleanly. Temporary by design — remove the switch
    in Phase 4, don't leave a permanent gate behind.

## 2. What exists that this reuses

| Need | Already built |
|---|---|
| Record a payment (OP row, HH deposit, excess update, Booked push, client email, hooks) | `services/record-payment.ts` `recordPayment()` |
| Webhook receiver, signature check, `stripe_events` receipt log | `services/stripe-webhook.ts` (`POST /api/webhooks/stripe`) |
| Idempotency for business-effect events | `services/stripe-event-claim.ts` (`pe:` keyspace) |
| Pre-auth record lifecycle (hold, capture, release, expiry sweep 09:40, discovery 09:50) | `services/excess-preauth.ts`, `routes/excess.ts`, `job_excess.excess_status = 'pre_auth'`, `amount_held` |
| Refund by payment intent, with `refund_legs` dedup | `services/excess-refund.ts`, `stripe-webhook.ts` `charge.refunded` |
| Which excess record / how much is due | `services/excess-topn.ts`, `v_excess_held` |
| The portal's amount options (deposit 25%, half, full, excess outstanding) | portal `populatePaymentOptions()`; mirrored in `services/wise-incoming.ts` `getMoneyPosition()` — lift that into a shared helper rather than a third copy |
| Live updates to the browser | Socket.io (already wired for notifications) |
| Till tenders | `services/shop-tenders.ts` ↔ `frontend/src/lib/shopTenders.ts` (must stay mirrored) |
| Client email for a payment / pre-auth | `services/money-emails.ts` `sendPaymentEmail` / `sendExcessEmail` |

## 3. Stripe-side setup (Phase 0, jon + Claude together)

1. **Merchant category** — read `business_profile.mcc` on the account (Dashboard → Settings →
   Business details, or `stripe.accounts.retrieve()`); record it in §9.1. Ask Stripe support to set
   it to the vehicle-rental category if it isn't.
2. **Terminal Location** — one, the Ooosh address (Dashboard → Terminal → Locations).
3. **Register the reader** to that location with the code shown on the device; label it
   "Reception". Note its `tr_…` id; OP lists readers from the API, nothing is hardcoded.
4. **Webhook events** — add `terminal.reader.action_succeeded`, `terminal.reader.action_failed`,
   `terminal.reader.action_updated` and `payment_intent.amount_capturable_updated` to the
   **OP Stripe connection** endpoint. Stripe recommends a dedicated endpoint for reader events; a
   second endpoint `POST /api/webhooks/stripe-terminal` is acceptable if the shared one proves noisy,
   but it must share the receipt log and the `pe:` claim.
5. **Restricted key scopes** — `STRIPE_SECRET_KEY` needs Terminal readers (R/W) and Terminal
   locations (R) added to PaymentIntents and Refunds.
6. **Sandbox** — a *simulated reader* exists in test mode; OP has only a live key today. Phase 0
   adds `STRIPE_TEST_SECRET_KEY` + a dev-only switch so the flow can be exercised without a card.

## 4. The flow, step by step (Phase 1: payments)

1. Money tab → **Take card payment**. A modal offers the same options the portal does — deposit,
   half, remaining balance, excess outstanding (full or a stage), plus **other amount + reason**
   (manager-tier, logged). Purpose and amount come from the option; staff never type both.
2. Reader picker (readers from `GET /v1/terminal/readers`, online ones first, last-used remembered
   per browser). One reader → no picker.
3. Backend `POST /api/money/:jobId/terminal/pay` → creates a PaymentIntent (`currency gbp`,
   `allowed_payment_method_types[]=card_present`, `capture_method automatic`, metadata exactly as
   the portal sets it: `jobId`, `paymentType`, excess sub-type/description, `source = 'terminal'`,
   `op_user_id`), records a **pending** `terminal_sessions` row, then
   `POST /v1/terminal/readers/{id}/process_payment_intent`. Returns the session id.
4. Reader shows the amount. The modal shows "Waiting for card…" with **Cancel** (calls
   `cancel_action`; refused by Stripe once a card has been presented — show that honestly).
5. Result arrives on the webhook: `terminal.reader.action_succeeded` → claim the event (`pe:`),
   then `recordPayment()` with `payment_method 'stripe_terminal'`, `payment_reference = pi_…`.
   `action_failed` → store `failure_code` / `api_error` on the session; the modal shows the decline
   and offers **Try again** which re-processes the SAME PaymentIntent (never a new one — Stripe's
   double-charge rule).
6. Modal result is pushed over Socket.io; a **Check status** button polls the reader/PaymentIntent
   for the missing-webhook case. The session row is the audit trail (who, which reader, when, what).
7. Client email via the existing path; Stripe receipt via `receipt_email` when the job has one.

## 5. Pre-auth (Phase 2)

Same as §4 with `capture_method manual` and
`payment_method_options[card_present][request_extended_authorization]=true`. On
`payment_intent.amount_capturable_updated` OP creates/updates the `job_excess` pre-auth record
(`pre_auth`, `amount_held`, `stripe_payment_intent_id`) **through the same code the portal's
pre-auth webhook path uses**, and stores `charge.payment_method_details.card_present.capture_before`
as the hold's expiry so the 09:40 expiry sweep works unchanged. Capture and release reuse the
existing excess endpoints. The modal's wording is "Hold £X on the card", never "Pay".

**Hard rule:** if `capture_before` comes back earlier than the hire's return date + 2 days, OP
warns before the client taps ("this hold would expire on … , before the hire ends — use the online
pre-auth link instead") and does not proceed unless a manager overrides.

## 6. Shop till + sitter till (Phase 3)

- New till tender `stripe_terminal` ("Card (terminal)") in `services/shop-tenders.ts` AND
  `frontend/src/lib/shopTenders.ts`. HireHop bank 267.
- The till's "Pay" with that tender runs §4 against the shop sale (metadata `shop_sale_id`, no job),
  recording via the shop's own sale-payment path, not `recordPayment()` (shop money goes on the
  weekly shop job — `docs/SHOP-SALES-SPEC.md`).
- **Sitter till (freelancer portal, `src/`)** needs a freelancer-reachable endpoint scoped to shop
  sales only: `POST /api/shop/sales/:id/terminal/pay` (freelancer role, amount taken from the sale,
  never from the request). A freelancer cannot start a job payment or a pre-auth.
- Refunds from the till follow the existing "Refund outstanding" shape; the physical refund is a
  Stripe refund to the card, so the counter-refund tender rules change: `stripe_terminal` refunds
  settle on creation like cash/card do today (`COUNTER_REFUND_TENDERS`).
- One shared reader: the till and reception will collide occasionally. Surface "reader busy" and
  let them wait; buy a second reader only if it happens daily (§9.3).

## 7. Data

- `terminal_sessions` (new): id, job_id (nullable), shop_sale_id (nullable), reader_id, reader_label,
  payment_intent_id, purpose (`deposit|balance|excess|excess_preauth|shop|other`), amount, status
  (`pending|succeeded|failed|cancelled`), failure_code, started_by, started_at, finished_at,
  job_payment_id, excess_id. Keyed on `payment_intent_id` (unique) so a webhook replay is a no-op.
- `job_payments.payment_method` enum + `services/hh-deposit.ts` `HH_BANK_IDS` / labels +
  `routes/money.ts` / `routes/excess.ts` zod enums gain `stripe_terminal` → 267. The
  `receipt_required` rule stays `worldpay`/`amex` only.
- No change to `job_excess`; the pre-auth record is the same shape the portal creates.

## 8. Phases

| Phase | What | Done when |
|---|---|---|
| 0 | §3 Stripe setup, MCC verified, test key + simulated reader, reader listing endpoint | A simulated payment round-trips in dev; MCC and `capture_before` behaviour written into §9.1 |
| 1 | §4 payments from the Money tab (deposit / balance / excess / other) | A live £1 payment on a test job lands in OP, HireHop (bank 267) and the client email, and a decline + retry works |
| 2 | §5 pre-auth with extended authorisation; expiry stored; capture/release reused | A live £1 hold shows on the Money tab as `pre_auth`, releases from the existing button, and the 09:40 sweep ignores it until `capture_before` |
| 3 | §6 shop till + sitter till tender | A shop sale paid on the reader reconciles in the weekly close |
| 4 | Retire Worldpay/Amex: hide the tenders and methods for NEW entries (keep for history), drop the card-slip to-do, update `.claude/rules/money-excess.md` | March 2027, after a clean month |

## 9. Open questions (answer before the phase that needs them)

1. ~~Merchant category code~~ — **answered 7 Oct 2026: "Car rentals"** (Dashboard → Settings →
   Business details → edit → Industry; it only shows in edit mode). 30-day extended window.
2. ~~Stripe email receipts~~ — stay OFF (jon, 7 Oct).
3. ~~Second reader~~ — no; one reader, shared (jon, 7 Oct).
4. ~~"Other amount"~~ — any staff, reason mandatory (jon, 7 Oct).
5. **Can the online portal's pre-auth use extended authorisation too?** If yes, the "hold instead of
   pay-and-reimburse" rule change in §1.5 applies to both channels. Verify in Phase 2.
6. **Text-message portal link** — out of scope here; `services/sms-service.ts` can do it later.

## 10. Not in scope

Tap to Pay on phones, offline mode (server-driven readers don't support it; Worldpay was online-only
too), tips, multi-currency, Stripe Connect, replacing the online portal.
