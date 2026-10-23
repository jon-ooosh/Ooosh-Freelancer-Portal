# Brief: simplify the cost capture form (Costs › Capture cost / Edit cost)

Paste this as the first message of a new Claude Code chat on the Ooosh-Freelancer-Portal repo.

## The problem (jon, 22 Oct 2026)

"The whole Costs modal is getting very heavy, very wordy, lots and lots of different things going on.
Complication is going to make it even more likely to go wrong or be used incorrectly. We made this
thing together and I mostly understand how it works, but even I'm unsure what this is asking or
telling me re the extra costs."

The block that confused him sits under "Where it goes" once a job is linked:
- **"This job so far"**: quoted to client, costs logged against the quote, extras.
- **"⛽ Expecting to recharge: Fuel … billed at actual + 20%"**: the job's quotes have expense lines set
  to `chargeMode: 'recharge'`.
- **"⛽ This job recharges running costs — defaulted to Extra + recharge"**: `jobs.recharge_running_costs`.
- **"Is this part of a quote?"** Part of the quote (`cost_intent = 'quote_actual'`: the client already
  paid for it through the quote) or Extra (`'extra'`: can be recharged), then "Recharge to client"
  (none / full / partial, partial in £ net of VAT).

In plain words it asks one question: **is the client paying us back for this, and how much?** It
takes four boxes and two banners to ask it.

## How we agreed to work (jon's call)

1. **No code first.** Write a short plan: which questions each kind of cost really needs, and what
   to hide, merge or drop. Agree it with jon.
2. **Then a clickable mock-up** (an Artifact, the Design type is fine), showing at least a fuel
   receipt on a job, a freelancer invoice, and a supplier bill with no job. jon reacts.
3. **Then build**, one PR, tested against the real screens.

jon's working rules: discuss and agree before coding; stress-test his ideas rather than agree by
default; plain British English; one PR per item; deploy commands in the reply (CLAUDE.md
"Deployment"); no unnecessary changes, don't remove comments.

## What the form is today

`frontend/src/components/CostCaptureModal.tsx` (about 2,150 lines). It opens from the Costs page,
a job's Money tab, a Problem's page, the vehicle Service history tab, and Record refund
(`grep -rl CostCaptureModal frontend/src`). Left pane: the receipt (AI reads it and fills the form).
Right pane, top to bottom:

- Supplier (with Xero contact matching: `services/supplier-match.ts`, "is it this one?" offers),
  invoice date (future/old-date warnings), invoice number, payment due (derived from terms; override).
- Money: 20% VAT / No VAT / Manual / VAT reclaim modes; gross, VAT, net; "Split into lines"
  (cost lines, `docs/COST-LINES-SPEC.md`).
- **What it was for:** category ("What's this cost for?", which is the Xero account and the cost
  type), description.
- **Where it goes:**
  - For "Freelance crew invoices" (320) only: Whose invoice? / Which work does it cover? and the
    "Question for the freelancer?" box (`components/costs/FreelancerInvoiceLinks.tsx`,
    `docs/FREELANCER-PORTAL-SPEC.md` §5.1).
  - Link to job, plus "This invoice covers several jobs" (the split modal).
  - The confusing recharge block above.
  - Vehicle link, plus "Add to the service history" with mileage / garage / status / next due.
- **How it's paid:** payment method, payment status, notes.
- Footer: a Xero hint line, Cancel, Approve & save (managers, bills), Save.
- On save, a freelancer invoice with no work ticked asks why (never blocks).

## Already fixed (PR #1535, 22 Oct)

- A freelancer invoice no longer defaults to Extra + full recharge on a "recharge running costs"
  job. That default would have billed the freelancer's fee to the client a second time.
- "defaulted to Extra + recharge" and "(set to Extra)" now only show while they're true.

## Things to keep true (they're in the rules; read before changing anything)

- `.claude/rules/money-excess.md` loads when you open the costs files. The parts that bind the
  form:
  - lines go in the SAME request as the header;
  - gross is authoritative and VAT is derived from the lines;
  - credits are a second row with their sign set only by `applyCreditSign()`;
  - a credit is never a recharge;
  - the Xero push only through `pushCostToXero`.
- **Warnings, not hard gates** (CLAUDE.md "Product policy"). Every field that exists must stay
  reachable for the case that needs it, even if it's tucked away.
- This is a **UI tidy-up**: no change to what is saved (`cost_intent`, `recharge_mode`,
  `recharge_amount`, `job_id`, etc.) unless jon agrees it.
- The recharge rules themselves: `docs/COST-CAPTURE-RECHARGE-SPEC.md` and
  `docs/POST-HIRE-EXPENSE-RECHARGE-SPEC.md` (read these to learn what "Extra" and the Recharges
  tab are for). Bills and payments: `docs/COSTS-PAYMENT-AUTOMATION-SPEC.md`.

## Ideas to test (not decisions)

- Ask the recharge question in one line: "Is the client paying this back?" No / Yes, all of it /
  Yes, part (£…). Derive `cost_intent` from it, instead of asking "part of the quote?" separately.
- Show the job summary only when it helps answer that question, in one line, not a box.
- Show sections by kind of cost. A freelancer invoice almost never needs recharge or the vehicle
  section. A fuel receipt on a running-costs job almost always does recharge.
- Fewer hint lines: one sentence per section at most, and only where a wrong answer costs money.

## Testing

`docs/FREELANCER-PORTAL-SPEC.md` §12 describes the recipe: a throwaway Postgres with every
migration, the real routers on a test server, the built staff app in Playwright.

## Parallel work

Another chat is writing the freelancer guides (`docs/guides/`, plus PDFs). It won't touch the
costs files. The one shared file is `docs/FREELANCER-PORTAL-SPEC.md` §0, whose to-do list mentions
this work; edit only its Costs line. If both PRs add a migration, the second to merge will need
renumbering (the runner's list is hardcoded).
