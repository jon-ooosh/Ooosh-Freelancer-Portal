# Cost capture redesign: what jon agreed (23 Oct 2026)

The Claude Design handoff in this folder (`README.md`, the prototype, `screenshots/`) is the
look and the section order. Where it differs from this page, **this page wins**: the
handoff was written without the code, and these are the corrections jon agreed after a
review against it.

Three PRs, in this order:
1. **Per-job recharges** (backend, built): migration 318, `v_cost_recharges`,
   `services/cost-recharges.ts`. See `docs/COST-CAPTURE-RECHARGE-SPEC.md` "Per-job recharges".
2. **The laptop form** (built): rebuild `CostCaptureModal.tsx` to the agreed design below. Where the
   build differs, see "What PR 2 built" at the end.
3. **The phone flow**: the one-question-per-screen stepper, with My Receipts folded in.

## The form (PR 2)

**First question, before the upload:** "What are you adding?" **Receipt** (paid already) /
**Bill** (to pay) / **Refund** (money back). A person answers it, not the AI. The phone
starts on Receipt. The AI reads everything else as now.

**Refund:** pick the PURCHASE it refunds first (today's Record refund flow, `RecordRefundModal`),
so the credit inherits job, van, category and card. The photo of the refund slip stays in
the left pane. "Can't find it" stays as a way out. "Record refund" on a cost row opens this
same form with the purchase picked: one refund route, not two. **Copy:** OP never sends a
credit note against a bill to Xero (it says "raise it in Xero yourself"), so no "Approve &
send to Xero" on a refund, and no "It comes off their next bill in Xero".

**Paid by (receipts):** Company card ••last4 (the uploader's) / Cash / Wise / **Me** (my own
money = `reimburse_me`, saves for approval, not a plain Save; whoever paid uploads it).
Amex, Lloyds card, PayPal, Lloyds transfer are no longer offered for new costs, but an old
cost on one still shows and edits with it ("no longer offered"). No "Someone else".

**Bill:** "Pay later · due … · awaiting payment", Change for the due date / "awaiting invoice".

**Who pays:** one answer per JOB ROW: Already in quote / Charge to client (or "Only part? £",
net) / We cover it. Saved on the cost when it is on one job, on each share when it is split
(PR 1). A freelancer's fee is never charged. Not per line.

**Jobs table:** ticking a freelancer's work also splits the job costs (one share per job;
this reverses the 22 Oct "kept apart" call in `FREELANCER-PORTAL-SPEC.md` §5.1, on purpose).
Studio evenings stay tickable rows but are NOT attributed to a job (one sitter covers the
building, shared by every rehearsal that night). Fix the Costs list's "5 jobs" label, which
counts ticked work items: "1 job · 3 nights".

**Matching:** the existing rule, the larger of 25% or £10 over the expense estimate, before
VAT, fees should match (`system_settings.freelancer_invoice_tolerance_*`). One overall check
in the bar under the table. Each row's amount is pre-filled in proportion (as today) and
editable; a row gets its own chip only once its real figure is typed. Expanding a row shows
the expected breakdown (Fee, Fuel, Tolls) read-only, plus Invoiced boxes for the expense
lines on a job that recharges, which add up into that job's "Only part? £".

**Question for the freelancer:** keep it visible on their Earnings page; word the box as a
prompt to us ("Ask them before approving: …"); the pre-written text must be fit for them to
read. No email is sent. Remove = clear (approving clears it too). Approve is not offered
while a question is open.

**Split into lines:** out of sight, behind "Change amounts / VAT". When the AI proposes
parts, show one line ("Read as 2 parts: different VAT rates") with Edit. (22 costs ever had
lines: 21 from the AI, 1 by hand, none "crew fronted".)

**AI-unsure fields** open in amber from signals the reader already gives (amounts it had to
repair, an odd date, a near-miss supplier, a duplicate). No AI change for now.

**Duplicate check:** add same amount + same date + same supplier (Xero contact where known,
else the normalised name), warn only, with "Open it". Keep today's invoice-number check.
On the phone: "Looks like this receipt was already added. Attach the photo to it instead?"

**Dropped:** remembering category / who pays per supplier (the AI already reads Shell as
Fuel; who pays depends on the job, not the supplier).

**Retired as separate tools:** the split modal (its row action opens the form at the Jobs
table) and the second refund route.

**Footer:** says that Save sends a receipt to Xero; the client's recharge figure is the net
+ markup + VAT, not the receipt's gross. Allocating more than the invoice is blocked (the
server refuses it; arithmetic, not policy).

**Use the real categories** (`COST_CATEGORIES`), not the mock's ("Motor fuel", "Office
equipment hire", "Tolls & parking" don't exist).

**Not in the mock, still needed:** edit mode (approved / in Xero / recharged costs), the
existing warnings (invoice number already used, "is it this Xero contact?", the old-date
fix, "no work ticked: why?", the AI's "link job #…"), and jobs with more than one van (pick
the van on the cost date, after any swap).

## The phone flow (PR 3)

The stepper in the mock, staff only. Step 1 shows "Waiting for a receipt (n)" (today's My
Receipts list) above the camera; tap one to attach, or snap and let the duplicate check offer
"attach to this one instead". The Wednesday receipt chaser then links to it, and
`/my-receipts` retires. The excess QR upload page (`/m/receipt/:token`) is a different thing
(card-machine slips for excess) and stays.

## Found on the way, fixed in PR 1

- A weekend manager's "Approve & save" was silently ignored (the server listed admin and
  manager only). Now `isManagerTier()`.
- The resolve modal warned "that's a loss" on every PART recharge (it compared with the
  whole invoice). It now checks only a recharge of the whole amount.

## What PR 2 built, and where it differs (Oct 2026)

Built as above, with these differences, each the simpler of two ways to the same end:
- **"Charge to client" on a freelancer's job is one figure, not Invoiced boxes per expense line.** It
  starts as what they invoiced over their fee on that job (their fee is in the quote) and can be typed
  over. Per-line boxes would be lost on the next edit, since nothing stores them.
- **Each work row has one Invoiced figure** (its share of the invoice), with its chip once typed; the
  expanded row shows the booking (fee, fuel, tolls) read-only. No "Accept it" button: a chip is a warning,
  and saving as it is accepts it.
- **"AI-unsure" is the reader's overall confidence**: below high, the amounts open with a note. The date,
  near-miss supplier and duplicate warnings show in place, as before.
- **Refund opens the refund flow** (pick the purchase first) with the document handed over, rather than
  turning this form's right-hand side into the refund form.
- **Who pays sits on the job rows, under the work rows**, not inside each work row: Will Fox's five days
  on three jobs are three answers, not five.
- **A one-job freelancer invoice with a studio evening is a one-share split**, so the evening stays with
  overheads, as agreed.

## What PR 3 built, and where it differs (Oct 2026)

The phone receipt page, `/receipt` (`frontend/src/pages/ReceiptCapturePage.tsx`), as agreed (jon, 26 Oct
2026), with these settled on the way:
- **Where and who:** its own full-screen page for every staff role, general assistants included. The
  Quick Log tile, the Wednesday chaser (email and bell) and "+ Capture cost" on a phone-sized screen open
  it; `/my-receipts` redirects to it. Costs is in the Money menu for every staff role too.
- **What it handles:** receipts and bills. Refund opens the refund window; a freelancer's invoice gets
  "Open the full form" (the laptop form, with the photo handed over), and so does anything needing
  several jobs, lines or a VAT reclaim.
- **Which job:** "No job, goes to overheads" first, the job number on the receipt if there is one, then
  the jobs with a van out around the receipt's date (two days either side; the van whose reg the AI read
  first; `GET /costs/van-jobs`), then a search by job, client or reg.
- **Already added:** a snap that matches one of my receipt-less purchases (same amount, same day) or the
  laptop's duplicate check offers "Attach the photo to it instead?"; one that already has a receipt is a
  warning only.
- **Photos:** shrunk to 2048px and HEIC converted to JPEG before upload, on the phone AND the laptop form
  (`components/costs/receiptRead.ts` `preparePhoto()`, on `lib/imageNormalise.ts`).
- **Weak signal:** reads and uploads are asked again when no reply came; the save is sent once and, on a
  lost reply, the page looks for its own photo before offering "Try again".
- **Receipt / Bill stays the person's answer** on the phone too: the phone starts on Receipt and the AI
  never switches it, even when it reads a due date.
