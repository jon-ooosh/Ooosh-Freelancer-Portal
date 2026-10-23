# Handoff: Cost capture form redesign (Costs › Capture cost / Edit cost)

> **Read `DECISIONS.md` first.** It records what jon agreed after reviewing this handoff against the code (23 Oct 2026), and it wins wherever the two differ.

## Overview
A UI tidy-up of `frontend/src/components/CostCaptureModal.tsx` (~2,150 lines) in the Ooosh-Freelancer-Portal repo. The current form asks one question ("is the client paying this back, and how much?") through four boxes and two banners. It also asks "which job" twice: once in the freelancer "Which work does it cover?" step and again in "Link to job" and the split modal. This redesign cuts every cost down to five questions, shows only what each kind of cost needs, and merges all job linking into one **Jobs table**.

`original-brief.md` is the brief this work started from. **Its "Things to keep true" section still binds this work**: lines go in the same request as the header, gross is authoritative, credits are signed only by `applyCreditSign()`, a credit is never a recharge, Xero is pushed only through `pushCostToXero`, and the product policy is warnings, not hard gates.

**No change to what is saved** (`cost_intent`, `recharge_mode`, `recharge_amount`, `job_id`, payment method/status, etc.). Every new control maps onto existing fields; see "Mapping to saved data" below. Discuss with jon before changing anything that is saved.

## About the design files
`Costs Modal v2.dc.html` is a **design reference built in HTML**, a clickable prototype of the intended look and behaviour. It is not production code. Rebuild it in the existing React/TypeScript frontend using that codebase's components and patterns, and use the existing OP styling and colours where they differ from the mock. To view it, open the file in a browser with `support.js` beside it. The tabs at the top switch between the four scenarios.

## Fidelity
**Mid/high fidelity for structure, copy and behaviour.** The layout, section order, wording and interactions are agreed with jon. Visual styling follows the current modal (purple accent, the same typography as the app), but use OP's existing tokens and components rather than copying the hex values exactly.

## The five questions (section order, top to bottom)
1. **What is it?** Three cards: **Receipt** (already paid) / **Bill** (to be paid) / **Refund / credit** (money back to us). The AI picks one; staff confirm or change it. A freelancer invoice is just a Bill whose supplier is a freelancer. A note on the right reads "AI read this as …", and changes to "Changed from what the AI read" if staff override it.
2. **From the document.** AI-read fields shown as a compact summary (supplier and Xero match, date, invoice/ref, pay-by for bills). "Edit details" turns them into inputs.
   - **Amounts row:** Gross · VAT · Net · Rate (e.g. "20% VAT"), all on one baseline, with a "Change amounts / VAT" link that opens today's four VAT modes (20% VAT / No VAT / Manual / VAT reclaim) and the gross/VAT/net inputs in place. The same maths as today: 20% → enter gross or net and the others fill in; No VAT → gross = net; Manual → VAT typed by hand.
   - **When the AI is unsure** of a field, that field alone shows open in an amber box with a one-line reason. If it is unsure of the VAT, the amounts section opens automatically with a note. This is the main case for insurance invoices on vans and similar.
   - Warnings appear inline under the field they belong to (e.g. "From the invoice (terms say 16 Oct)").
3. **What it's for.** Category + Description side by side. **Van** appears here: filled in automatically from the job for vehicle categories such as fuel ("RX71 KHL · on job #16710", with Remove), otherwise a "+ Link a van" link that opens **in place**. Service-history fields only appear for repair/servicing categories, as today.
4. **Jobs and who pays.** One table (detail below). It replaces "Whose invoice / Which work does it cover", "Link to job" and the "covers several jobs" split modal.
5. **Payment.**
   - Receipt: "Paid by" segmented: **Ooosh card ••4412 / Cash / Someone else**. Someone else → "Who paid?" input; Shell stays the supplier (VAT invoice); we record the amount as owed to that person.
   - Bill: one summary line, "Pay later · due 23 Oct 2026 · awaiting payment", with **Change** opening the payment method/status selects.
   - Credit: one line, "Credit note from X. It comes off their next bill in Xero." Who-pays is hidden; credits are never charged to the client.

Below that: "+ Notes" (opens in place with **Remove**; helper text: "Staff only. Shows on this cost in OP; not sent to Xero or the freelancer." **Confirm this is accurate**), plus "+ Question for {freelancer}" on freelancer bills.

**Removed:** "Split into lines" (jon: not needed in this UI), the "This job so far" box, both fuel banners, the "Is this part of a quote?" cards, and the 💡 footer hint.

## Jobs table (the core change)
- **Freelancer bill:** the table is filled with that freelancer's booked work. Each row has a tickbox, date, role/venue, job number and name, the invoiced total, and a status chip (✓ As expected / ⚠ Check N lines / Question asked / Not on this invoice).
  - Ticking a row links the cost to that job. Ticking several splits it. No separate step.
  - Rows expand (▸/▾) into the transport calculator's lines (Fee, Fuel, Tolls, Parking…) with **Expected**, an editable **Invoiced** amount, and a chip per line.
  - **Matching rule (existing): a line passes if within 20% or £10 of expected, whichever is greater.** Exact → "✓ Matches"; within tolerance → "≈ Close enough"; outside → "⚠ £60.00 over/under" plus a red strip with **Ask them about it** (adds a pre-written line to the "Question for {freelancer}" box: "#16744 fuel (Thu 1 Oct): you've invoiced £80.00 but we estimated £20.00. Can you explain the difference?") and **Accept it**. Both can be undone.
  - A row with a mismatched line opens by default; matching rows stay collapsed and show a one-line who-pays summary ("Fee: already in quote · Fuel, Parking: charge to client").
  - Ticking an unbooked row fills Invoiced with the expected amounts.
- **Any cost:** "+ Add another job" (freelancer: "+ Add a job not in their booked work") opens a search box with job suggestions in place. A new row is pre-filled with whatever amount isn't on a job yet. With no job: a dashed box, "Not linked to a job, so it goes to overheads." with "+ Link to a job".
- **Single-job receipt:** one simple row (no chevron) with the job summary line ("Quote £1,840 · costs so far £55.74 · recharges running costs at actual +20%") and one amount line.
- **Allocation bar** (when more than one job or amounts don't sum): green "✓ Invoice £443.60 · allocated to jobs £443.60"; amber "£x of £y isn't on a job. Fine if it's overheads; otherwise tick or add a job."; red "Allocated £x more than the invoice total". Warning only, never blocks saving.

### Who pays: per line, three options (exact copy)
| Option | Helper text (shown for the selected option) |
|---|---|
| **Already in quote** | Client has already been charged for this |
| **Charge to client** | **Not in quote:** recharge plus markup (on jobs that recharge running costs: "recharge at actual +20%") · link "Only part?" → £ net input, link back "Charge all of it" |
| **We cover it** | **Not in quote,** but we're not recharging the client |

Defaults: freelancer **fee** → Already in quote (keeps the PR #1535 fix: never double-bill a fee). Fuel/tolls/parking on a job with `recharge_running_costs` → Charge to client. Other costs added to a job → Already in quote.

### Mapping to saved data
- Already in quote → `cost_intent='quote_actual'`, `recharge_mode='none'`
- Charge to client (all) → `cost_intent='extra'`, `recharge_mode='full'`
- Charge to client (part) → `cost_intent='extra'`, `recharge_mode='partial'`, `recharge_amount` = net £
- We cover it → `cost_intent='extra'`, `recharge_mode='none'`
- Receipt / Bill / Credit → existing payment method/status + credit sign via `applyCreditSign()`; **no new field**
- Ticked job rows → existing job links/split rows (one per job); per-line who-pays → cost lines (same request as header).
- **Check with jon:** whether per-line who-pays within one job needs cost lines on the save side, or whether the existing split model already covers it.

## Footer
A one-line summary of what will happen, built live, e.g. "£443.60 across 2 jobs · £150.20 charged to client · 1 question to Pabs Sounds · bill due 23 Oct 2026", with an amber line below for the most important open warning (a mismatched line → "1 line doesn't match the booking. Ask about it or accept it."; allocation gap; "Say who paid…"). Buttons: Cancel · **Save for approval** (bills/credits) · primary **Approve & send to Xero** (bills/credits; managers) or **Save** (receipts).

## Left pane
The scanned document (the AI reads this one) with View/Replace, then **Supporting documents**: "Evidence only, not read by the AI"; a dashed "+ Add supporting documents" drop zone that **accepts several files at once** (multi-select and drag-drop); each file listed with type badge, View and ×.

## Mobile (staff only; nearly always paper fuel receipts)
A one-question-per-screen stepper with a progress bar, back chevron and "n of 4":
1. **Snap the receipt:** camera view → Retake / **Use this photo**.
2. **Is this right?** Receipt/Bill/Refund segmented; AI-read rows (supplier, date, amount + VAT, category), each tappable to edit → **Looks right**.
3. **Which job?** Search (job, client, van reg); **"No job, goes to overheads" first**; then **Recent transport jobs** (job number, name, van reg, date, "recharges fuel" flag). Tapping a job moves straight to the next step.
4. **Who pays?** Summary card; the three who-pays options as large cards with the same copy as the laptop version (defaulted from the job); the van filled in from the job (Change); Paid by Ooosh card / Cash / Someone else → **Save receipt**.
5. Done: tick and summary, then **Snap another receipt**.
Tap targets are at least 44px (buttons 52px).

## Screenshots (`screenshots/`)
- 01–03 Fuel receipt on a job (top, jobs/who pays, payment + footer)
- 04–06 Freelancer bill, 3 jobs (top, jobs table, expanded mismatched row)
- 07–08 Same, after "Ask them about it" + supporting docs added (question box, footer)
- 09–11 Supplier bill, no job (AI-unsure VAT open + invoice number flag, overheads, footer)
- 12–17 Mobile: photo → check → which job → who pays (2 shots) → done

## Files
- `Costs Modal v2.dc.html` + `support.js`: the clickable prototype (open in a browser)
- `original-brief.md`: the brief and the rules to keep
- `screenshots/`: the states listed above

## Working agreement (from the brief)
One PR. Test against the real screens (FREELANCER-PORTAL-SPEC §12 recipe). Plain British English. No unnecessary changes; don't remove comments. Put the deploy commands in the reply.
