# Freelancer portal programme (Oct 2026)

The freelancer portal (`src/`, freelancer.oooshtours.co.uk) and the freelancer-facing van screens
(`frontend/src/modules/vehicles/`, freelancer scope) are being straightened out and refreshed in a
series of PRs. This file is the handover: what's decided, what's done, what's next. Read it before
touching completion, the chaser, Earnings or the freelancer guides.

## 1. The order of work

| # | PR | State |
|---|---|---|
| 1 | Completion fixes (§2) | merged 21 Oct 2026 |
| – | Payment terms aligned (§4) | merged 21 Oct 2026 |
| 2 | Security quick fixes (§6) | merged 21 Oct 2026 |
| 3 | Portal reskin to the Claude Design handoff (`docs/design/freelancer-portal-refresh/`), §9 | this PR |
| 4 | Van screens reskin, freelancer scope only | after |
| 5 | Portal 2FA (§7) | after |
| 6 | Earnings (§5) | **new session**, after the above |
| 7 | Four freelancer guides (§8) | after the reskin, so the screenshots show the new look |

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

