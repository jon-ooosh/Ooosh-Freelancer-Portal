# Freelancer portal programme (Oct 2026)

The freelancer portal (`src/`, freelancer.oooshtours.co.uk) and the freelancer-facing van screens
(`frontend/src/modules/vehicles/`, freelancer scope) are being straightened out and refreshed in a
series of PRs. This file is the handover: what's decided, what's done, what's next. Read it before
touching completion, the chaser, Earnings, the guides or anything freelancer-facing.

## 0. Start here (next session)

**State on 22 Oct 2026:** PR 1 (completion fixes), the payment-terms PR, PR 2 (security) and PR 3 (the
portal reskin) are merged and deployed. The "How to invoice Ooosh Tours Ltd" Google Doc and its copy in
the portal's Resources are updated (§4). Past work on the Completed page (§10), PR 4 (the van screens in
the portal look, §11) and PR 5 (portal 2FA, §7) are merged and deployed; 2FA **ships OFF** until jon
sets `portal_2fa_enforced_from` in Settings, after telling freelancers in the WhatsApp group (there is no
banner). Earnings part 1, freelancer invoices linked in Costs (§5.1), is merged and deployed, and jon
linked the past invoices (one, Glenn Saggers, isn't in OP and stays unlinked); the one-off page is
removed. The Costs follow-ups (§5.1) are merged and deployed. Earnings part 2, the portal tab (§5.2), is
built, with the portal's favicon. Nothing is half-built.

**Do next, in this order** (one PR each; jon merges and deploys, then the next starts from fresh main):

1. **The four freelancer guides (§8)**, now that PR 4 gives the screenshots the new look. Rebuild the
   shop-till guide (`docs/guides/shop-till/`) in the new look at the same time. The invoicing guide can now
   point at the Earnings tab.
2. **Transactions through the shared pool (`docs/SECURITY-AUDIT-BRIEF.md` B.5).** Four places; own PR.
3. **Simplify the cost capture form, last** (jon, 22 Oct 2026: "very heavy, very wordy"; even he couldn't
   tell what the "This job so far / Is this part of a quote? / recharge" block was asking). jon's call:
   once everything else is done, start with a clickable mock-up and go from there. Not part of this
   programme, but raised here. **Under way (23 Oct 2026):** the Claude Design mock-up was reviewed and
   agreed with changes, in three PRs. PR 1, per-job recharges (migration 318, `v_cost_recharges`,
   `COST-CAPTURE-RECHARGE-SPEC.md` "Per-job recharges"), is built; PR 2 the laptop form, PR 3 the phone
   flow (folding in My Receipts). That PR also moved the cost split save onto one client, so item 2
   above has three places left, not four.

**How we work:** discuss and agree before coding (jon's preference), one PR per item, deploy commands
in the reply (CLAUDE.md "Deployment"), run `npm run db:migrate` only when a PR adds a migration.
§12 is how this programme tested its changes; the scripts lived in a session scratchpad, so recreate
them from the recipe there.

## 1. The order of work

| # | PR | State |
|---|---|---|
| 1 | Completion fixes (§2) | merged 21 Oct 2026 |
| – | Payment terms aligned (§4) | merged 21 Oct 2026 |
| 2 | Security quick fixes (§6) | merged 21 Oct 2026 |
| 3 | Portal reskin to the Claude Design handoff (`docs/design/freelancer-portal-refresh/`), §9 | merged 21 Oct 2026 |
| – | Past work on the Completed page (§10) | merged 21 Oct 2026 |
| 4 | Van screens reskin, freelancer scope only (§11) | merged 21 Oct 2026 |
| 5 | Portal 2FA (§7) | built 21 Oct 2026, ships off |
| 6a | Earnings part 1: freelancer invoices linked in Costs (§5.1) | merged 22 Oct 2026; past invoices linked, one-off page removed |
| – | Costs follow-ups: job numbers in the work list, "no work ticked" prompt, recharge default (§5.1) | merged 22 Oct 2026 |
| – | Calculator: setup premium charged to the client, crew fuel once (`PLATFORM-CONVENTIONS.md`) | merged 22 Oct 2026 |
| 6b | Earnings part 2: the portal tab (§5.2), plus the portal favicon | built 22 Oct 2026 |
| 7 | Four freelancer guides (§8) | after PR 4, so the screenshots show the new look |
| – | Pool transactions (`SECURITY-AUDIT-BRIEF.md` B.5) | any time |

## 2. Completion: what PR 1 changed and why

**Van-only "All Done".** Every back / wrong-van / cancel button on the van screens went to
the portal's `/job/{id}/complete?vanOnly=true`, whose "All Done" completed the job (and stopped the
chaser) with no van moved. And the server counted "a van on this job is out on hire" as a finished
COLLECTION, which it is before anyone collects it. Now:
- `services/quote-completion.ts` `isVanLegDone()` is THE check: the `van_leg_done_at` stamp, or the
  van's record by direction (delivery: booked out / active / returned; collection: soft check-in,
  checked in or returned). `maybeCloseQuote` uses it.
- `POST /api/portal/jobs/:id/complete` with `vanOnly` answers 409 `van_leg_pending` unless it's true,
  and no longer stamps the equipment leg.
- The portal's van-only screen says "Van not booked out / collected yet" instead of offering All Done.
- The van screens' back / cancel / wrong-van links go to the portal JOB page (`lib/safe-url.ts`
  `portalJobUrl()`). Only a finished van step goes to the completion page.

**Crew jobs** complete in the portal (they had no Complete button but were chased with a link to one):
notes, optional photos, and an OPT-IN "Equipment on hire" note to the client (the delivery-note PDF's
`variant: 'hire'`, template `equipment_on_hire_note`). No signature. The job page decides crew vs
delivery from the job's own `boardType`, not the link's `?board=crew`.

**People jobs** (`quotes.what_is_it = 'people'`, a delivery/collection quote with passengers): the
Start page offers a People option only on these jobs. It declares no van and no equipment leg and
opens a short completion (notes, optional photo). No delivery note or collection email goes to the
client (one used to, with the HireHop item list).

**Delivery notes are filed on the job** (22 Oct 2026), the same as a warehouse collection sign-off.
The PDF a delivery completion makes (and a ticked crew "Equipment on hire" note) goes on the job's
Files tab (`jobs.files`, R2 key under `delivery-notes/`), and the Activity Timeline says who it was
emailed to, which sends failed, or that it wasn't sent. A delivery's note is now made even when
"Don't send" is ticked, so the office has a copy to send on (Files tab › Email). If the PDF can't be
made, the timeline says so. A further copy for a client otherwise comes from HireHop (jon's call: no
"make one now" button in OP).

**When it ends, when we chase** (jon): `services/quote-schedule.ts` is THE definition, shared by the
chaser and the portal.
- Crew and People: complete from the start of the LAST day; chased from 09:00 UK the day after it.
  OP stores no finish time, so this is by date. A single-day job shows Complete all day on the day.
- Ordinary deliveries/collections: chased from arrival time, as before, now in UK time (the old JS
  maths ran an hour late all summer).
- Every person on a job gets each reminder (the per-quote level bump used to block all but the first).

**Van collection sign-off** (`CollectionPage.tsx`): the CUSTOMER signs; "Customer not here" needs a
short note instead (where the keys were, anything else). Checked before anything is written. The
signature is stored on the event (a regenerated report used to say "Signed in person at book-out"),
the note rides with the client notes everywhere, and the report says when the customer wasn't there.

**Equipment ticks** on the delivery/collection page are saved now, as one system note on the job's
Activity Timeline ("Equipment checklist at delivery by X: 3 of 4 ticked…"). Nothing ticked = no note.

**Crew fee display**: a crewed quote for more than one person stores the WHOLE crew's fee; each crew
member was shown all of it. The portal now shows an even share unless staff set an individual rate.
Per-person rates by role are part of the Earnings work (§5).

Also: real Completed / Cancelled "View all" pages, "Add to Calendar" downloads an .ics, Earnings is a
"coming soon" page until §5.

## 3. Things to know

- People jobs and crew jobs complete with `customerPresent` true and no signature; only a hand-over
  has a customer to be present or not.
- Crew multi-day jobs: Complete is offered from the last day; a link can still reach the form earlier,
  and the form warns (warnings, not gates).
- A "9am to 9am" one-off ticked as multi-day in the calculator has its last day as the next day.
- The approval email's "Set up your portal login" button is `system_settings.freelancer_portal_url`
  (Settings › Freelancer welcome links). It was seeded as `https://www.freelancer.oooshtours.co.uk`,
  a host with no DNS record, so from 21 Sep to 22 Oct 2026 the button led to "This site can't be
  reached". Migration 313 points it at `https://freelancer.oooshtours.co.uk/register`. The portal has
  no `www.` address; never type one.

## 4. Decisions log (jon, Oct 2026)

- Confirming a job is by email from the office, not in the portal.
- Collection signature: the customer's, with a "not here" note.
- Freelancer fees: never say "plus VAT" (99% aren't registered; those who are add it).
- Payment terms: first Friday one week after APPROVAL, 8 to 14 days after approval (a Friday approval
  is paid the Friday after next). Please don't chase until 30 days after sending the invoice. Done in
  the code (`supplier-terms.ts` `freelancerDueDateFromApproval()`; bills approved before the deploy
  keep their invoice-date due date), both freelancer emails and the "How to invoice Ooosh Tours Ltd"
  Google Doc.
- The guides are available to everyone; quote the screen's own wording; no staff-site warning (that
  code path is fixed).
- Briefing items are read live from OP (`settings/checklists.json` in R2, edited at
  staff.oooshtours.co.uk/vehicles/settings → Checklists → Briefing): one list, general plus per van type.
- Freelancer jobs are confirmed by email from the office (the portal has no "confirm" step).
- Copy on the portal: "Forgotten it?" is the reset link's name (the login errors name it too);
  "Job emails" is what the notification settings are called; the old Monday office statuses
  ("TO DO!", "Arranging") show as "Being arranged". The pause banner is amber (the design's warning).
- Staff who used their OP staff password on the portal (no portal password) were cut off by PR 2 on
  purpose: they set a portal password with "Forgotten it?" (matt@ and one freelancer, Oct 2026). The
  shared info@ login only shows Ooosh-crew jobs, never jobs given to a person.

## 5. Earnings (handover for a new session)

**Verdict from the research (Oct 2026): partly.** OP knows what a freelancer was BOOKED to earn; it
can't say per job whether they've INVOICED it or been PAID.
- Expected amounts: delivery/collection/crew `quote_assignments.agreed_rate`, else the quote fee
  (`freelancer_fee_rounded`, the crew TOTAL for a crew of more than one); multi-drop runs
  `run_groups.combined_freelancer_fee`, once per run per person; studio sitters
  `studio_sitter_shift_assignments.fee`; yard days `freelancer_day_bookings.expected_total`.
- Costs: a freelancer invoice is a `costs` row (account 320 → `cost_type 'freelancer_invoice'`) with a
  free-text `supplier_name`, optional `job_id`, `payment_status`, `paid_value_date` (from Xero's 07:50
  pull-back or a manual pay). No person link, no link to the work it pays for.
  `costs.quote_assignment_id` exists but nothing sets it.
- `GET /people/:id/freelancer-history` (`routes/people.ts`) already merges all four kinds of work per
  person; it's the base for a portal earnings endpoint, after fixing: count a run's combined fee once,
  exclude cancelled quotes and lapsed/withdrawn days, use the per-person share.

**The plan to make Invoiced / Paid accurate:**
1. `costs.person_id` (the freelancer), picked when staff capture a 320 invoice (pre-filled by a unique
   name match, otherwise asked).
2. A `cost_work_items` table (`cost_id` + one of `quote_assignment_id` / `freelancer_day_booking_id` /
   `studio_sitter_assignment_id`, `amount`), kept apart from `cost_allocations` so the by-job read is
   untouched. At capture, staff tick which of that person's done, un-invoiced work the invoice covers
   (amounts pre-filled, difference shown). Invoiced = linked; Paid = the cost is paid with
   `paid_value_date` on or before today (a later date reads "Scheduled").
3. Per-person rates: set `agreed_rate` at assignment, by role (jon wants rates per person).
4. **Backfill (jon wants it):** a staff-reviewed pass linking past 320 costs to people and work
   (exact name + job match proposed, a person confirms). Freelancers trading as a Ltd won't name-match.
5. "Send invoice": v1 a pre-filled email to whoever booked them plus the invoicing guide; v2 a portal
   upload creating a `submitted` cost with the person and work items, belled to the booker. Invoices
   carry bank details: never store them under the R2 `files/` prefix (readable by every staff login).
6. Payment terms (§4) are aligned (Oct 2026), so an approved invoice's "expected payment" date can be
   shown: it is the cost's `resolveDueDate()` due date. Before approval there is no firm date.

Read-only checks to run on production first:
```sql
SELECT COUNT(*), COUNT(quote_assignment_id), COUNT(job_id) FROM costs WHERE cost_type = 'freelancer_invoice';
SELECT COUNT(*), COUNT(agreed_rate), COUNT(*) FILTER (WHERE invoice_received) FROM quote_assignments;
SELECT COUNT(*) FROM cost_allocations WHERE quote_assignment_id IS NOT NULL;
```

The design mock (`docs/design/freelancer-portal-refresh/screenshots/10-earnings.png`): month / tax-year
switch, a total, a Paid / Invoiced / To invoice bar, "N jobs need an invoice", a list with status chips.

### 5.1 Part 1, what shipped (22 Oct 2026): freelancer invoices linked in Costs

**jon's calls (22 Oct):** freelancers keep emailing their invoice (PDF) to whoever booked them; the office
links it in OP and the freelancer sees it in their portal. Uploading through the portal is **parked**
(it would rarely be used, and an email to a person doesn't vanish the way a portal upload can). Fees are
per JOB divided by the people on it, which is what `personalFee()` already does: no per-person rate card,
a role paid differently is its own crewed job. Expenses are estimates: within the larger of £10 or 25% of
the estimate is "about right" (`system_settings.freelancer_invoice_tolerance_gbp` / `_pct`). A query sends
no email (the office contacts the freelancer anyway). Who can query: managers and admins, and whoever
uploaded it. The "invoice received" ticks on yard days and crew bookings were left as they are (jon).
Backfill from 6 April 2026 only (OP went live around then): 93 freelancer invoices, 37 letterheads, 19 of
which match one freelancer by name.

**What it does** (migration 306):
- `costs.person_id` (whose invoice) and `cost_work_items` (which work: one row per booking / sitter
  evening / yard day, with this invoice's share). Kept apart from `cost_allocations` at first (22 Oct);
  **since the capture form's redesign (Oct 2026, `docs/design/cost-capture-redesign/DECISIONS.md`) ticking
  the work ALSO splits the job costs**, one share per job, each with its own who pays (a run's stops are
  spread over their jobs by what was booked). Studio evenings and yard days are on no job, so they stay
  with overheads. `cost_work_items` is still what Earnings and the price check read; `cost_allocations`
  is what the Money tab reads.
- The upload form, for "Freelance crew invoices" (320): **Whose invoice?** filled in from the letterhead
  (`services/freelancer-invoice-person.ts`: remembered from an earlier linked invoice, then an earlier
  remittance address, then one freelancer by name, compared as supplier matching does) and **Which work
  does it cover?** (`services/freelancer-work.ts`: finished work in the last 12 months, newest first, each
  with the booked fee and the quote's expense estimate; a multi-drop run is one item at its combined fee;
  work already on another invoice behind a tick box). Staff only tick: each item's share of the invoice is
  in proportion to what was booked (`shareInvoice()`), re-shared on every save. Booked vs invoiced is
  compared before VAT and never blocks. Ticked work all on one job links that job if none is picked.
- `services/freelancer-fees.ts` `personalFee()` is now THE fee rule, shared by the portal's "Your fee"
  and the work list (it moved out of `routes/portal.ts` unchanged).
- **Query** (`POST/DELETE /costs/:id/query`): a note; "Queried" pill and an amber Query / Edit query
  button beside Verify / Approve on the Bills to pay tab, and a "Question for the freelancer?" box on the
  form. Approving clears it; refused once approved. Audit-logged (`cost_queried`, `cost_query_cleared`).
- Remittance goes to the linked freelancer first (`source: 'freelancer_linked'`); sending one to an
  address that names exactly one freelancer links an unlinked freelancer invoice.
- The Costs list shows the freelancer under the supplier ("Linked · 3 jobs" when the letterhead is their
  own name).

**Follow-ups after first use (22 Oct 2026, migration 315):**
- The work list puts each job number under its date, in the left column, so the numbers line up against
  the invoice (jon).
- Saving a freelancer invoice with no work ticked asks why, and never blocks: "The freelancer isn't in
  OP" (only when nobody is picked), "The work isn't in OP" or "I'll match it later", or go back and tick.
  The answer is `costs.work_unmatched_reason` and shows in the Costs list as "Not matched: …"; ticking
  work clears it (server-side). "Later" is asked again on the next save; the two "not in OP" answers and
  an already-paid invoice are not asked again.
- **A freelancer invoice never defaults to Extra + recharge**, even on a job flagged "recharge running
  costs". It is mostly their fee, which the quote already charges; the old default would have put the
  whole invoice on the Recharges tab, and linking the job from the ticked work made that the usual path.
  It defaults like any other cost (Part of the quote when the job has a quote), and the hint says to choose
  Extra and recharge the fronted part (Partial) if the invoice includes fuel or tolls. The "defaulted to
  Extra + recharge" banner and "(set to Extra)" now show only while they are true.

**The one-off backfill (used and removed, Oct 2026):** a Costs page grouped the unlinked freelancer
invoices since 6 April 2026 by letterhead for jon to link once. Done; the page, its route and its
backend router are gone. An invoice from someone not in OP (Glenn Saggers) stays unlinked: it is paid
as normal and shows on nobody's Earnings. Anything missed is linked from the ordinary edit form.

### 5.2 Part 2, what shipped (22 Oct 2026): the Earnings tab

**jon's calls (22 Oct):** "To invoice" labels start from 22 Oct 2026, when the office began ticking work,
not back to April (the past invoices were linked to the person but not to their work, so April to October
would all have read "To invoice"). The office's query note is shown to the freelancer, and the staff hints
say so. Status words: Received · Queried (with the note) · Approved, due Fri X · Paying Fri X · Paid X. No
"Send invoice" button: invoices are still emailed (PDF) to whoever booked them, and the page points at
Resources for the "How to invoice" guide. Periods: last month, this month, tax year, and last tax year
once there is a whole OP year (from 6 April 2027). The shared info@ login gets a note, nothing else.

**How it counts** (`services/freelancer-earnings.ts`, `GET /api/portal/earnings?period=`, read-only). Money
is by INVOICE, because invoices are complete from April and work links are not:
- **Paid:** invoices paid in the period, by `paid_value_date` (else `paid_at`). Marked paid with a future
  value date is "Paying Fri X" and still counts as Invoiced.
- **Invoiced:** invoices dated in the period and not paid yet.
- **To invoice:** finished work in the period on no invoice, dated on or after
  `system_settings.freelancer_earnings_labels_from` (migration 317, default 2026-10-22; move it back if
  older invoices get their work ticked). Fees only; the office's expense estimate is never sent.
- An unpaid invoice dated before the period is listed under "Still waiting from before" and not added to
  the period, so "where is my money?" is answered on every view.
- So a job done in September and paid on 3 October is October's money; the September view lists the
  job with a "Paid 3 Oct" chip. The card says the period's name, not "Earned", for that reason.
- "Next payment" is the earliest upcoming date across all invoices (an approved one's `resolveDueDate()`,
  or a booked payment's value date), with everything due that day added up.
- Only `cost_type = 'freelancer_invoice'` costs with this `person_id`; credits are left out.

**The page** (`src/app/earnings/page.tsx`, `src/app/api/earnings/route.ts`) follows the design mock
(`docs/design/freelancer-portal-refresh/screenshots/10-earnings.png`): the period card with a Paid /
Invoiced / To invoice bar, "N jobs need an invoice" with the Resources link instead of the button, the
invoices (each opens to the work it covers, with job numbers), and the work with To invoice / Invoiced /
Paid X chips. Titles use the Completed page's wording ("Delivery - The Lexington", "Studio sitter").

**Favicon:** the portal had none. It now uses the staff app's Ooosh record icon (`src/app/favicon.ico`,
`icon.png`, `apple-icon.png`; Next serves them by file name, outside the login check).

## 6. Security quick fixes (PR 2)

All fixed in PR 2; what was done is `docs/SECURITY-AUDIT-BRIEF.md` A.12. Before deploying it,
anyone who logged in with their STAFF password (no portal password) has to set one with
"Forgot your password?", or they are locked out. The findings, as confirmed in the code (Oct 2026):
- Portal login doesn't require `is_approved`, and sessions keep working after a freelancer is removed.
- It falls back to the OP staff password (`users.password_hash`) when the portal password is unset,
  which skips OP's own 2FA.
- No per-account slowdown on wrong passwords (the only limiter is per-IP, and the portal's calls all
  come from Netlify's addresses).
- `src/app/api/hirehop/items/[jobId]` returns any HireHop job's kit list to any logged-in freelancer.
- `GET /api/portal/venues/:id` is unscoped and unused.
- The van screens' `POST /api/vehicles/send-email` sends any HTML to any address for a freelancer
  session, checked only by "the subject mentions the van's reg".
- The portal job response carries the run's combined CLIENT fee.

## 7. 2FA (PR 5)

Email code plus a 90-day "trust this device" cookie per phone, like OP Phase 1 (no passkeys). Sign-up
and password reset count as the second factor. The shared info@ portal login is included: each of
the 5 or 6 phones is trusted once, its code read from the info@ inbox. Staff get "let them in" /
reset on the freelancer's record, and the login says "Can't get the code? Call the office". An
enforcement date setting turns it on. The gate lives in OP's `/api/portal/auth/login` (the endpoint
is public), the device cookie on the portal's domain, passed to OP in the body.

### 7.1 What shipped (21 Oct 2026)

**jon's calls:** "Remember this phone for 90 days" is ticked by default but always shown (code step,
last step of sign-up, the reset form); anyone on the staff team (`STAFF_ROLES`) may give a code or sign
someone out, both audit-logged; no banner (jon tells freelancers in WhatsApp); it ships off; existing
sessions stay signed in when it goes on; no freelancer-side list of phones.

**The switch:** `system_settings.portal_2fa_enforced_from` (Settings › Login security & kiosk, admins,
beside the staff date). Empty = off; from the date (UK day) on, a phone OP doesn't remember needs the
code. Settings are cached for up to a minute, so allow that after saving.

**How it works** (`backend/src/services/portal-login-security.ts`; routes in `routes/portal.ts`):
- `POST /api/portal/auth/login` checks the password and access as before. When the code is owed it
  answers 200 `{ success: false, pending, emailHint, codeSent, codeError }` with NO `user`, so the
  Netlify portal mints no session (it only mints on `success && user`). The code email is
  `portal_login_code` (names the phone from the user agent, greets by `preferred_name`).
- `POST /auth/login/code { pending, code, trustDevice, userAgent }` is the second step; it re-reads the
  person (still approved?) before the session. A wrong or expired code is a 400, never a 401. A pending
  pass that is bad, expired (10 minutes) or for someone no longer approved answers `code: 'pending_expired'`
  and the page goes back to the password.
- `POST /auth/login/send-code { pending }`: a new code. 30 seconds apart, 3 emailed codes in 15 minutes
  per person; a code whose email failed is deleted (it never left, so it holds nothing up). Codes last
  10 minutes, 5 wrong tries kill one, one live code per person.
- The code step and send-code have their own per-address limit (30 in 15 minutes): OP sees every
  freelancer as Netlify's few addresses, so sharing the login's 20 would halve it.
- A remembered phone: OP signs a `portal_device` pass (audience in `tokens.ts`, 90 days) naming a row in
  `portal_trusted_devices`; the ROW is the revocation. The portal keeps it in an httpOnly cookie
  `portal_device` on `/api/auth` (`src/lib/portal-session.ts`), sends it in the login body, and keeps it
  through signing out (that is the point). A pass for another person (shared phone) is no match.
- Sign-up (`register/complete`) and reset (`reset-password`) already prove the inbox, so they take
  `trustDevice` and return `deviceToken` like the code step.
- The code is only a second step: it never replaces the password, including a code staff read out.

**The office's side:** Address Book › person › Freelancer tab › **Portal sign-in**
(`frontend/src/components/PortalSignInCard.tsx`; `GET /people/:id/portal-sign-in`, `POST …/code`,
`POST …/sign-out`). Last signed in, remembered phones (made in the last 90 days, not revoked), whether
the code is on. "Give them a sign-in code" (only while it's on) shows a 6-digit code to read out; it
replaces any emailed code, lasts 10 minutes, still needs the password, and is logged with who asked
(`portal_login_codes.issued_by`; `audit_log` `portal_sign_in_code`, the code itself never). "Sign them
out everywhere" forgets every remembered phone, voids codes and sets `people.portal_sessions_valid_after`
(audit `portal_sign_out_everywhere`).

**info@:** one person row, so each office phone is remembered once, its code read from the info@ inbox.

**Deploy order:** an old portal behind a new OP is fine while the switch is off; with it on, an old
portal would read the code answer as a wrong password. The portal deploys on merge, so switch on after.

**Not built, on purpose:** passkeys, a banner, a freelancer-side list of phones, SMS codes.
**Follow-up noticed:** the three freelancer auth emails (sign-up code, reset link, sign-in code) use the
`internal` email frame ("OOOSH OPS" header, "Internal use only" footer). The new one matches the other
two; moving all three to the `client` frame is a small separate change.

## 8. The freelancer guides (after the reskin)

Four short PDFs in Resources, built like `docs/guides/shop-till/` (real pages, sample data,
phone-width), framed by task:
1. **Getting started**: freelancer.oooshtours.co.uk is the only site; login; the dashboard (Ooosh work
   days, Today, Upcoming, Completed); a job's page; notifications (which emails can't be muted);
   Resources; getting paid; complete promptly (reminders).
2. **Delivering a hire van to a customer** (the book-out): Start → what you're delivering; check the
   plate; mileage and fuel; all 18 photos; brief every item; the customer signs; hire form missing →
   call the office.
3. **Collecting a hire van**: mileage, fuel, 18 photos, customer's notes, the customer signs (or
   "Customer not here" with a note); the warehouse does the full check-in later.
4. **Delivering and collecting backline**: the checklist, notes, signature or photo, the delivery note.

Each opens with three to five rules (check the plate; tap Resume when asked; complete promptly).

## 9. The reskin (PR 3, Oct 2026)

The portal now follows `docs/design/freelancer-portal-refresh/` (README there = the brief; the
`.dc.html` opens in a browser with `support.js` beside it; `screenshots/` are the finals).

- **Tokens:** `tailwind.config.js` `hf` (the design's colours by name) and `kind` (job-kind tile
  colours). The stock `gray`, `green`, `amber`, `red`, `blue` are RE-POINTED at the same palette, so
  `gray-500` here is the design's warm "muted". The old `ooosh` sky blue is gone. Use `hf-*` in new code.
- **Removed with it:** the Monday-era in-memory reset-token and verification-code stores in `src/lib`
  (OP issues and checks both); the portal's "3 resets an hour" check, which never counted anything.
- **Font:** DM Sans via `next/font` (`--font-dm-sans`). Icons: `lucide-react` (pinned 1.50.0), no emoji.
- **Shared pieces:** `src/components/ui.tsx` (button/input class strings, IconTile, BackLink,
  Chevron, SectionLabel, Banner, Segmented, Chip, PageSpinner), `BottomNav.tsx`, `AuthShell.tsx`
  (register / forgotten / reset).
- **Jobs (dashboard):** By date (Today / Tomorrow / Later, plus Earlier for a recent shift or yard
  day) or By type (Deliveries & collections / Studio shifts / Crew / Ooosh work), remembered in
  `localStorage` `ooosh_portal_jobs_sort`. Yard days needing an answer pinned on top. Whole cards open
  the job; only Today cards carry Start / Lock up. The kind label and the travel chip ("Driving there &
  back", "One way · train back", "Train there · drive back") come from `whatIsIt` and the leg: a rule of
  thumb, not stored data. The card's town is `venueCity` (OP's portal job response, Oct 2026).
- **Copy:** British English, hyphens not em dashes, "Forgotten it?" on the login (the login error
  messages name it, so change both together), "Job emails" for the notification settings.
- **Not built from the mock:** Earnings stays a "Coming soon" page (§5).

## 10. Past studio-sitter nights (built 21 Oct 2026; what shipped is at the end)

**The problem (21 Oct 2026):** a sitter's nights disappear from the portal 14 days after them.
`GET /api/portal/studio-sitter/shifts` (`backend/src/routes/portal.ts`) asks
`services/studio-sitter.ts` `getSitterShifts()` for `today - 14` to `today + 365`. The dashboard shows
what that returns (Today / Tomorrow / Later / Earlier), and `/completed` (`src/components/JobHistoryList.tsx`)
only lists quotes from `/api/jobs` (last 30 days). So nothing shows a night older than 14 days. Not caused
by PRs 1-3 (none touched that window). The shift page itself still opens for any date the person is
assigned to (`isSitterAssignedTo()` has no window), so links work.

**To confirm for one person** (production, read-only):
```sql
SELECT s.shift_date, s.status AS shift_status, a.status AS assignment_status, p.email
FROM studio_sitter_shift_assignments a
JOIN studio_sitter_shifts s ON s.id = a.shift_id
JOIN people p ON p.id = a.person_id
WHERE p.first_name ILIKE 'charlie' AND p.last_name ILIKE 'stanley'
ORDER BY s.shift_date DESC LIMIT 10;
```
Rows with `assignment_status` assigned/confirmed and a date more than 14 days ago are hidden by the
window. If the email differs from the one he logs in with, it is a duplicate person record instead.

**Proposed fix (agree with jon first):** keep the dashboard as it is (14 days), and give past nights a
home on the Completed page: OP's route takes an optional `?past=90` (clamped to 14..120 days, the
future window unchanged), the portal's `/api/studio-sitter/shifts` passes it through, and
`JobHistoryList` (which = 'completed') adds the person's past nights from that call as rows ("Studio
sitter · Tue 29 Sep", linking to `/shift/{date}`, "Locked up" when `report_submitted_at` is set), sorted
in with the jobs by date. Yard days could join the same list later (`/api/day-bookings` `past`).

**Confirmed on production (jon, 21 Oct 2026):** Charlie's 29 / 30 Sep and 5 Oct nights were `assigned`
under the email he logs in with, so it was the window, not a duplicate record. His 28 Sep assignment was
`cancelled` and correctly stays hidden.

**What shipped (jon's decisions, 21 Oct 2026), replacing the proposal above:**
- **One window for every kind of work** (it was 30 days for jobs, 14 for nights, the last 10 yard days):
  **this month and last** by default, so the oldest month shown is always whole (someone writing last
  month's invoice sees all of it); **"Show the last 6 months"** at the foot of Completed goes to six
  months in all. Defined once in `src/lib/history.ts` (`historyStart()` / `historyStartOlder()`). Longer
  is Earnings' job (§5). Cancelled uses the same default, with no "Show older".
- **OP:** the three portal list routes take `?since=YYYY-MM-DD` (`parseSince()` in `routes/portal.ts`:
  malformed is ignored, clamped to the last 200 days and to today). `/jobs` uses it for completed and
  cancelled (default still 30 days). `/studio-sitter/shifts` adds `past` (nights before tonight, back to
  `since`) and `/day-bookings` adds `done` (accepted or completed days gone by). The existing `shifts` and
  `past` lists are unchanged, so the dashboard's own sections are too. `/jobs` now buckets by `ukToday()`.
- **Portal:** `JobHistoryList.tsx` (Completed) lists jobs, nights and yard days newest first under month
  headings with a count each. A night opens `/shift/{date}` and says "Locked up" when the report is in; a
  yard day is a record only (it has no page). A failed nights / yard-days load says so in a banner and
  never reads as "nothing there". The dashboard's Completed number counts the same rows (each stop of a
  run is one row), so Charlie's nights show in it.
- Shared labels for a night, a yard day and a fee moved to `src/lib/work-labels.ts` (unchanged).
- Tested end to end (§12): the real portal against OP's real routes on a throwaway database seeded like
  Charlie's case; 32 route checks and 34 screen checks.

## 11. PR 4: the van screens, freelancer scope only

The design is screens 13-19 / mocks 3a-3g in `docs/design/freelancer-portal-refresh/` (README "Vehicles
module" section; open the `.dc.html` in a browser with `support.js` beside it).

- **Where:** the staff app (`frontend/`), reached by freelancers through `src/pages/FreelancerBookoutShell.tsx`
  and `FreelancerCheckinShell.tsx` (they wrap the vehicle module's `BookOutPage.tsx` / `CollectionPage.tsx`).
  Also `components/FreelancerVanPicker.tsx`, `components/FreelancerLinkError.tsx`,
  `components/book-out/PhotoCapture.tsx`, `components/book-out/SignatureCapture.tsx`.
- **Only in freelancer scope:** wrap the two shells in a theme container (e.g. `data-theme="freelancer"`)
  and style through it, so the staff navy UI is untouched. Never change staff behaviour.
- **Read first:** `.claude/rules/vehicles-bookout.md` (freelancer mode, drafts, photo memory rules,
  multi-van picker) and `.claude/rules/frontend.md`.
- **Behaviour unchanged.** Keep: the 9 fuel levels, the 18 photos in order, the briefing items read
  live from OP settings, the fuel-drop warning, the customer signature on a collection with the
  "Customer not here" note (PR 1; the design's "Your signature" on 3g is wrong), back / cancel links to the
  portal JOB page (`lib/safe-url.ts` `portalJobUrl()`), draft resume (`acceptDraft()`).
- **Look:** the portal's tokens and fonts (`tailwind.config.js` `hf` / `kind` at the repo root, DM Sans,
  lucide icons). `frontend/` has neither lucide nor DM Sans yet: add `lucide-react` pinned (the portal
  uses 1.50.0) and load DM Sans for the freelancer wrapper only.
- **Test** the way §12 says, against `vite preview`, with the shells' token-resolve calls mocked.

**What shipped (built 21 Oct 2026; jon's five calls agreed first):**
- **How:** same engine, a second face. `BookOutPage` / `CollectionPage` keep every bit of logic (steps,
  `canAdvance`, autosave and drafts, compression, uploads, retries, `handleSubmit`); when `scope ===
  'freelancer'` they draw freelancer-only screens from `frontend/src/modules/vehicles/components/freelancer/`
  (`ui.tsx` kit, `VanConfirm`, `FreelancerPhotos`, `DoneScreen`) that call the same functions. The staff
  JSX is untouched. The shared `PhotoCapture`, `SignatureCapture` and `DraftResumePrompt` take an optional
  `look="freelancer"`; without it they render as before. The shells wrap everything in `FreelancerTheme`.
- **Tokens, once:** the design's colours moved to `shared/design/freelancer-tokens.cjs`, read by BOTH
  Tailwind configs (portal and `frontend/`), so the van screens and the portal can't drift. DM Sans is
  self-hosted (`@fontsource-variable/dm-sans` 5.3.0, imported by the kit only); `lucide-react` 1.50.0.
- **Jon's calls:** (1) Back from a freelancer's first step returns to "Is this the van in front of you?";
  they never reach the staff steps (Select Vehicle, Driver & Hire), and an old draft saved on one resumes
  on Fuel & mileage. (2) "No, call the office" dials 01273 911382; "‹ Portal" still goes to the job
  page. (3) Photos: a "Next up" card with the framing guide and tip, "Take photo" opens the camera
  straight away (no full-screen guide, no "Photo guides" switch), all 18 tiles four across with short
  names, a taken photo offers Retake / Remove, an extra photo can carry a label. (4) Check & sign: Driver
  (Drivers when more than one), Mileage, Fuel, Photos, Hire ends when known, Notes when written, and the
  VE103B tick when it shows. (5) The done screen is the design's when every step worked; otherwise it
  lists what happened. Smaller: the fuel gauge keeps red / amber / green by level; photo names on screen
  have no em dashes (the PDF keeps REQUIRED_PHOTOS' names); text shared with staff passes through
  `noEmDash()` before a freelancer sees it.
- **Collection:** step 0 ("Vehicle & Job") is the van screen; 1 to 3 are numbered. The customer signs
  ("Customer's signature"), "Customer not here" with its note stays (the design's 3g was wrong).
- **"Both" jobs:** the done screen says the equipment checklist is next when the portal's return link
  has no `vanOnly=true` (how the portal already tells them apart). Book-out still hops back to the portal
  3 seconds after a clean submit.
- **Proof it changed nothing else:** the staff book-out and collection screens (select, draft prompt,
  state, photos, briefing, confirm) were screenshotted on main and on this branch: pixel-identical. A
  full freelancer book-out and collection were submitted on both from the same draft: every request
  (event, fleet status, 18 photo uploads, condition report, collection) identical apart from ids, times
  and the signature image. 45 screen checks on the new flows. The portal's compiled CSS is byte-identical
  after the token move.
- **Deploy:** the staff frontend gains two packages (`npm install` before the build) and reads
  `../shared/design/`; the portal (Netlify) rebuilds on merge with the same colours.

## 12. How this programme tested (recreate as needed)

- **Portal pages:** `SESSION_SECRET=<any 32+ chars> npx next dev -p 3100`, then Playwright (`npm root -g`
  has it; Chromium is at `/opt/pw-browsers`). Sign a session cookie with `jose`
  (`new SignJWT({ id, email, name }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt()` with the same
  secret), add it to the browser context, and `context.route('**/api/**', ...)` to answer every portal
  API call with fixture JSON shaped like OP's responses. Phone viewport 390x844, scale 2.
- **OP routes:** a throwaway Postgres 16 (`initdb` as the postgres user, a spare port), `npx tsx
  src/migrations/run.ts up` against it (the full history applies cleanly), a throwaway `redis-server`,
  then a tsx script that mounts the real routers (`routes/portal.ts`, `routes/vehicles.ts`) on an
  express app with `cookie-parser` and drives them with `fetch`. Delete the database afterwards.
- **PR 5 (2FA):** the OP test server also mounted `routes/people.ts`, patched `emailService.send` to
  record each email (and render it with `renderPreview()`), and offered a test-only staff token
  (`signFor('staff', …)`) and a settings-cache reset. Its `app.set('trust proxy', 1)` matches production,
  so the route script sent a different `X-Forwarded-For` per call to stay under the login limiter. The
  real portal (`next dev`, `OP_BACKEND_URL` pointing at it) was driven through off / on / remembered /
  unticked / email down / sign-up / reset in Playwright, and the staff card ran in `vite preview` with
  `/api/people/**` forwarded (`route.fetch`) to the real OP routes under that staff token.
- **Before pushing:** `npx tsc --noEmit -p .` in the root, `backend/` and `frontend/`; `next build`
  (stop the dev server first; they share `.next`); `npm run build` in `backend/` and `frontend/`.
- **A reskin must not change behaviour:** compare each page's `fetch(` calls, navigations and request
  bodies against `origin/main` (grep both versions and diff). PR 3 did this for every page.

