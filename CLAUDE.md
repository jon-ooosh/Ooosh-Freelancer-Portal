# CLAUDE.md — Ooosh Operations Platform

<!--
MAINTAINING THIS FILE — read before adding anything.

This file is loaded into the context window at the start of EVERY session and
re-injected after every /compact. In Sep 2026 it had grown to ~757KB (5,746
lines, ~150–200k tokens) and was consuming most of the window before a single
turn of work. Keep it small or that comes straight back.

Where new material goes:

  A rule that must reach every session, whatever file is open
      -> here, as ONE line (plus a half-line of why)

  A rule that only matters when touching one area
      -> .claude/rules/<area>.md  (auto-loads when Claude opens a matching
         file, costs nothing otherwise — this is where most rules belong)

  What happened on job 16xxx and why we changed it
      -> docs/reference/<AREA>.md  (the full record; nothing is deleted,
         it just stops being paid for on every turn)

  Shipped-work checklists, phase status, "what's next"
      -> docs/reference/ROADMAP.md

Compressing a rule is fine; dropping the REASON is not. A rule with no "why"
gets "simplified" away by the next Claude who doesn't know what it cost.
Target for this file: under ~500 lines.
-->

## Project overview

The **Ooosh Operations Platform** — a unified business operations hub for Ooosh Tours,
replacing Monday.com and wrapping around HireHop (job/equipment management) and Xero
(accounting). The repo is named "Freelancer-Portal" for historical reasons; it is the
full operations platform.

**People are the primary entity.** Everything connects back to people and their
relationships. A person exists independently of any company, band, or role.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite + TypeScript (SPA) |
| Backend | Node.js + Express + TypeScript |
| Database | PostgreSQL 16 |
| Cache/queues | Redis |
| Real-time | Socket.io |
| File storage | Cloudflare R2 (private `ooosh-operations`, public `ooosh-vehicle-photos`) |
| Auth | JWT (email + password, bcrypt) |
| Scheduling | node-cron |
| Styling | Tailwind CSS |

**Server:** Hetzner CAX11 at `49.13.158.66` · **Domain:** `staff.oooshtours.co.uk`
**Database:** `ooosh_operations` (`sudo -u postgres psql -d ooosh_operations`)

Demo seed logins: `admin@oooshtours.co.uk` / `admin12345`, `tom@example.com` / `freelancer123`

## Layout

```
backend/src/     routes/ services/ config/ middleware/ migrations/ scripts/
frontend/src/    pages/ components/ modules/vehicles/ lib/ hooks/ contexts/
src/             the freelancer portal (separate Next.js app, same repo)
shared/types/    shared TypeScript types
deploy/          server scripts + nginx reference config
docs/            specs (*-SPEC.md) + reference/ (extracted module detail)
```

`routes/` and `services/` are flat and named after their domain — `ls` them rather
than guessing. `frontend/src/modules/vehicles/` is the absorbed standalone vehicle
module (book-out, check-in, prep, allocations, fleet).

## Key commands

```bash
cd backend  && npm run dev        # dev server, hot reload
cd backend  && npm run build      # compile TypeScript
cd backend  && npm run db:migrate # run migrations
cd frontend && npm run build      # production build
```

---

# Where the rest of the documentation lives

**`.claude/rules/*.md` load automatically** when you open a matching file. You do not
need to read them — they arrive on their own. They carry the "never do X / always go
through Y" rules for that area.

| Rule file | Loads when you touch |
|---|---|
| `money-excess.md` | money / excess / costs / Stripe / Xero / cancellations |
| `drivers-hire-forms.md` | drivers, hire forms, driver verification, referrals, assignments |
| `vehicles-bookout.md` | vehicles, book-out, check-in, fleet, the vehicle module |
| `hirehop.md` | HireHop sync, broker, webhooks, write-back |
| `email-and-notifications.md` | email service, templates, notifications, comms, auto-chase |
| `jobs-pipeline-dashboard.md` | pipeline, requirements, dashboard, jobs, returns |
| `frontend.md` | any frontend file |
| `staff-calendar.md` | staff calendar, holiday, TOIL, overtime, absence, My Time |

**`docs/reference/*.md` is the full record** — design rationale, incident forensics,
shipped-work history. Read one when you need the "why" behind a rule, or when working
somewhere the rules don't cover.

| Doc | Covers |
|---|---|
| `ROADMAP.md` | build status, what's next, open items |
| `MONEY-AND-EXCESS.md` | Money tab, excess lifecycle, pre-auth, top-N, portal, refunds |
| `DRIVERS-AND-HIRE-FORMS.md` | verification, document validity, identity review, allocations, swap |
| `VEHICLES-AND-FLEET.md` | vehicle module, maintenance, compliance, finance, turnaround |
| `OPERATIONS-MODULES.md` | requirements engine, backline, rehearsals, transport & crew, carnets |
| `PIPELINE-AND-ORGS.md` | job editing, band-centric model, lead org, HireHop data cleanup |
| `RETURNS-AND-CANCELLATIONS.md` | close-out, cancellations, combine bookings |
| `INBOX-AND-WAREHOUSE.md` | notifications, threaded messaging, warehouse collections |
| `STORAGE-AND-HOLDING.md` | client storage, holding/merch/lost property |
| `INTEGRATIONS.md` | PCN, staging calculator, backline matcher, leads, auto-chase, staff docs |
| `SHARED-UTILITIES.md` | broker, email, Stripe, encryption, costs/Xero, contacts, scanners |
| `PLATFORM-CONVENTIONS.md` | security posture, crew & transport calculator, HireHop API field reference, dashboard extension points, files tab, DB tables |
| `PLATFORM-HISTORY.md` | original repo-structure tree, full deployment playbook, Phase 1 history |
| `BACKLOG.md` | captured but unscheduled ideas |
| `HIREHOP-BILLING-API.md` | invoices, payments, allocations, refunds and their Xero sync — captured payloads. Read before ANY new billing write. **§8 is the proven end-to-end recipe (invoice → allocate → apply credit in Xero → complete) — the base for the bookkeeping module** |

`docs/*-SPEC.md` are the hand-written per-feature specs; several rules point at them.

**CLOSED, Sep 2026:** `docs/STAFF-RECORDS-SPEC.md` — the private staff area. **All
seven phases shipped**: files, key data, `staff_tasks` + "My To Do", reviews, the
staff-facing review, document review cycles, retention. §20 is the current state and
the short list of what is deliberately NOT built. Read it before changing anything here.
Wider to-do work (assigning to others, recurring) is the general tasks module, not this one.

**CLOSED, Sep 2026:** `docs/TASKS-SPEC.md` — the To Do module (Me › To Do), built on
`staff_tasks`. Anyone can give anyone a task; owner, setter and admins can touch it; private
ones stay off the Everyone view. Repeating to-dos are a `staff_task_series` whose occurrences
are ordinary tasks (`source_type = 'staff_task_series'`), one open at a time. Shared lists
(`staff_task_lists`) hold items with `list_id` set and **no `person_id` until somebody takes
one** — a task or series is owned by a person OR a list (DB CHECK), so `person_id` can be NULL.
Mine also shows my job reminders and Problems, READ-THROUGH only. §2 is the boundary with job
reminders, Problems and the vehicle module — read it before putting any "thing to do"
anywhere. §15 is the phase 3–4 log, §16 the close and what is deliberately not built.
Phase 5 (linking a to-do to a person/org) was skipped; its shape is in `BACKLOG.md`.

**CLOSED, Oct 2026:** `docs/INCIDENT-CLAIMS-SPEC.md` — possible insurance claims
(Vehicles › Claims, replacing the broker's Word claim form). Always opened from a Problem
(`job_issues.claim_id`); the broker is never contacted automatically — only a manager's "Send to
broker". §1 lists the settled decisions, §18–21 what Phases 1–4 shipped (video and retention deliberately not built), §22 troubleshooting. Claim files live under the
`claims/` R2 prefix, which `GET /api/files/download` gates to staff — never file them under `files/`.

**The staff DVLA/document check has NOTHING to do with `drivers`.** jon's decision,
Sep 2026: the `drivers` machinery verifies self-drive-hire CLIENTS (30-day
insurability, `services/driver-validity.ts`); the staff one is an annual sanity check
on an employee (`services/staff-doc-cycles.ts`). Same words, different people, different
consequence. Never merge them.

**`staff_record_files` objects live under the `staff-records/` R2 prefix, and that
prefix (with `claims/`) is the ONLY one `GET /api/files/download` role-gates.** Every
other prefix it serves is readable by EVERY staff login whatever their role (the
route is staff-only since Oct 2026; `backups/` is no longer on it). Never file
anything private under `files/`.

**BUILT (steps 1–10 + the sitter till), Sep 2026:** `docs/SHOP-SALES-SPEC.md` — the **Shop Till**
(`/money/shop`). Ad-hoc shop sales, internal stock consumption and sale-stock
lookup, with HireHop remaining the single stock database. **§19 is the current
state, the live settings, and what to do next — read it before touching this.**
**§20, the weekly close** (invoice → approve → allocate payments → complete) — LIVE
(`services/shop-close.ts`, admin-only button on *This week*; first real week closed
28 Sep 2026; since 12 Oct it runs itself Monday 08:55 for every clean finished week —
`shop_auto_close_enabled`; a week that stopped part-way waits for the button). **HireHop never pushes an allocation to Xero — OP applies the credit in
Xero itself** (`HIREHOP-BILLING-API.md` §8).

Three rules from it that bite elsewhere:
- **A stock movement is EITHER a HireHop job line OR a `tally_save` adjustment,
  never both** — doing both halves the shelf count silently.
- **`success: true` from HireHop does NOT mean HireHop did it.** Verify writes by
  reading back; it has returned success for a no-op twice.
- **The weekly shop job is never synced into OP's `jobs` table** and must never
  be linked to from the UI. Sale stock is only consumed while that job is
  DISPATCHED, so any status change releases a week of stock, silently.

**PHASES 0–3 BUILT, Oct 2026:** `docs/VEHICLE-SALES-SPEC.md` — selling a van (sales pack, per-buyer
share links, activity + To Do follow-ups, hand-off to the existing sold modal). Built: DVSA MOT history
(Vehicle › History › MOT), the sale page (`/vehicles/fleet/:id/sale` — stage, price, chosen photos,
photo re-check, "For sale" pills), per-buyer share links (public page `/van/:token`) and the activity
log (offers; follow-ups are To Do items, `source_type = 'vehicle_sale'`). Phase 4 (PDF) is not built.
§1 is the settled decisions, §11–14 what shipped. **What a buyer sees is built ONLY by
`shapeForBuyer()` in `services/vehicle-sale-links.ts`** — from an allow-list, per the link's switches. **A sale never changes the van** — it stays active and hireable; removing the van from the
fleet closes its open sale as sold.

**CLOSED, Oct 2026:** `docs/HIRE-CLOSE-OUT-SPEC.md` — the bookkeeping module:
finishing a hire's money from the post-hire cards (raise invoice → excess decision → allocate
deposits in HireHop AND Xero → complete), one job at a time, on the shared recipe
`services/hh-invoice-close.ts` (`HIREHOP-BILLING-API.md` §8). Born from job 16015: HireHop's "New
payment" dialog records a REFUND when its invoice dropdown is left at "none". Built:
`services/hire-close-out.ts` + `routes/hire-close-out.ts` (`/api/close-out/:jobId/plan|allocate|complete`,
log in `job_closeout_log`) — plan shown first, every write read back, excess NEVER allocated; with more
than one invoice owing a manager picks which one takes the hire payments (`setPaymentTarget()`, Oct 2026 — the rest go by excess claim / Record payment), HireHop↔OP payment and refund mismatches refuse by name.
The UI is ONE panel on the **Money tab**, `CloseOutMoneyPanel.tsx` (Oct 2026 redesign): one pill, five
steps, one next-action line with its reason behind "Why?", a short ledger; stages from `lib/closeOutPlan.ts`
`closeOutView()`, shared with the Overview's Invoice card (now a signpost, `CloseOutSignpost.tsx`, "Open in
Money →") and the Money tab's coloured dot. One button raises the invoice if needed (draft from uninvoiced
lines → penny check → approve dated today → Xero) then allocates in HireHop + Xero (`POST /close-out/:jobId/run`).
**A job's FIRST invoice is laid out like the quote**: an empty draft with the supply list pasted on
(`billing_paste.php`, prices multiplied out by `MULTIPLIER` as HireHop's grid does — `HIREHOP-BILLING-API.md`
§10.7); a top-up invoice stays `all: 1`; kill-switch `system_settings.closeout_invoice_layout = 'flat'`;
"Mark as sent" ticks the Invoice requirement; "Complete the job" opens the page's own status modal. The balance
shows once, in the Financial Summary, only when non-zero. No Xero links, no Details modal. **An EU hire** (the "Non-standard VAT rules" item)
gets its draft split by `services/eu-vat-split.ts` (real lines to £0, each edited in place by its own id, per nominal a UK-days line at 20% and a
non-UK-days line at code 33; vehicles zero-rated only on a 31+ day hire or with the "starts and ends outside the UK" item, otherwise 20% in full — never split by days), checked against the portal's figure, then approved in the same press.
Completing a job is the status
change at the top of the page, and that modal refuses open Problems (manager + reason to override;
`routes/pipeline.ts` enforces it). **Nightly Xero credit sweep** `services/close-out-xero-sweep.ts`
(03:30) applies HireHop's allocations as credits in Xero (`system_settings.closeout_xero_sweep_enabled`,
on since 10 Oct 2026). **Arrival hook** `services/close-out-arrival.ts` (Phase 3b): a hire payment
landing on a job with exactly one invoice owing (or the manager-chosen one) is allocated to it in HireHop + Xero,
after the payment has answered — THAT payment only (never money already sitting on the job), never completes the
job (`closeout_arrival_hook_enabled`, on). **Charges after completion** (misc, PCN) are their own invoice
(`completed-charges.ts`); **the payment portal reads a Completed job's balance from its invoices** (portal repo,
`get-job-details-v2.js`) — and a Cancelled job's while its fee invoice is owing — every other status from the job value. Invoices split by hand (hire vs damage) are made
by a manager in HireHop. An invoice HireHop pushed to Xero but lost the link to (`ACC_ID` empty) is found
by number + total (`hh-invoice-close.ts` `adoptLostXeroInvoices()`). §1 is
settled, §5 the allocation rule, §9 the phases, **§12 the current state and the parked list — read it first.**
Refunds only through the existing routes.

**CLOSED, 14 Oct 2026: cancellations — the money end** (first live job 16739, checked in HireHop and Xero). `docs/CANCELLATION-SPEC.md` final section. A
cancelled job owes its FEE, not the hire: HireHop keeps the hire's lines on a cancelled job (never touch
them — Re-open copies them), so the Money summary (`financial.cancellation`), the close-out plan
(`CloseOutPlan.cancellation`) and the payment portal all read the fee / fee invoice instead. The fee is
ONE custom line on Misc income (190) at 20%, raised on the close-out panel's button
(`services/cancellation-close.ts` on `hh-invoice-close.ts` `raiseCustomLineInvoice()`, shared with
`completed-charges.ts`); payments are allocated up to the fee only; the rest is the pending refund
(its amount re-set at allocation), refunded by a person with Process; excess is the Excess card's; the
job stays HireHop 9 and is never completed. A hire invoiced before cancelling is refused (credit note,
by hand). The portal takes payment at status 9 only while an approved invoice is owing.
**After cancelling (26 Oct 2026):** the internal email is a to-do list (`services/cancellation-alert.ts`), and
the money cards (`invoice`, `payment_reconcile`, `excess_resolve`) are due 3 days out with `keep_after_close`, so the
09:30 close-out scanner chases them for any manager until each ticks itself — spec final section.

**CLOSED, 19 Oct 2026 — live for everyone:** `docs/STRIPE-TERMINAL-SPEC.md` — in-person card payments driven from OP
on a Stripe Reader S700, replacing Worldpay/Amex (contract ends March 2027). §1 is settled: same
Stripe account, money on HireHop bank 267, recording ONLY through `services/record-payment.ts`,
pre-auths via extended authorisation (30 days — the account is "Car rentals", §9.1), no phone card
payments (policy), shop + sitter till in Phase 3. Read it before building anything that takes a card
in person; **§11 is what Phases 0–1 built and where they differ from the plan** (recorded as `stripe_gbp`,
not a new method; Record Payment → Method → Card reader; polling, not Socket.io); **§12 is "Send receipt?"** (the client email waits for staff; a booking confirmation can't be skipped; 15-minute safety net). **§13 is Phase 2** — excess payments + pre-auths on the reader from the excess Manage modal; the pre-auth rule is the portal's, copied (`excess-preauth.ts` `preauthEligibility()`); a reader pre-auth is recorded by `recordPreauthHold()`, the Manage modal's own code. **§14 is Phase 3** — tender "Card reader" (`card_reader`, bank 267) on the shop and sitter tills; the card is taken FIRST and the sale created after (`validateShopSale()` before, `createShopSale()` after, which refuses `card_reader` without a PaymentIntent); refunds go back to the card through Stripe. **§15–16 are Phase 4 and the close**: the reader for everyone; every NEW payment method but the reader, Wise and Cash is admin-only — Stripe (Online), Worldpay, Amex, PayPal, Lloyds (`services/payment-methods.ts` ↔ `lib/paymentMethods.ts`); refunds keep every method, labelled as the money came in (Stripe - Card reader / Stripe (PayPal) / Stripe (Online)); sitter till = reader + cash (+ their bill). **§17 is after the first live excess** (21 Oct 2026): a reader payment asks first when a pre-auth would do; a Stripe hold is worded "release it when the van is back" (a reader hold can last 30 days); "Send receipt?" re-ticks today's addresses on the job. The week's payments work it builds on (PayPal via
Stripe, portal redesign, portal link, Wise matcher) is in `MONEY-AND-EXCESS.md` "Payments, Oct 2026".

**BUILT (PRs 1–4), Oct 2026:** `docs/QUOTE-VERSIONS-SPEC.md` — alternative quotes for one enquiry
(three date spans / van vs van+driver / with a Twin) as a GROUP of jobs. **"Version" in the spec
is "option" in code** (`jobs.option_no`, "(Option 2)" in the HireHop job name, `services/job-groups.ts`)
— "quote versions" already means the quote-PDF diff on the Activity Timeline. §1 is settled: **one
option = one OP job + one HireHop job** ("Quote another option" duplicates the HH job via
`job_duplicate.php`, HireHop FIRST then the OP row); never amend a job in place to become a different
option; **pre-confirmation only** and a group has at most one confirmed member (§1.1); the group is
a thin layer (option bar, Compare slide-over, one collapsed Kanban card); confirm one → a HUMAN marks
the rest lost as `'Confirmed Alternative Quote (from us)'`, which win/loss and Fill-a-Gap must
exclude; option numbers never auto-bump. Payment = choosing: the portal link carries the job number
and refuses a live option whose sibling confirmed (PR 4, portal repo). Built: PRs 1–3 (§10) — the bar
(top of Job Detail), Compare, pin, one card per group on the pipeline, headline counts count a group
once (`job-groups.ts` `nonLeadMemberIds()`), the Confirm panel in the bar (`services/option-confirm.ts`
`afterOptionConfirmed()` on all four confirmation paths; bells on the unattended ones), the §8 guards
(`notAltQuoteLossSql`, `bumpSiblingChaseDates`, `jobNameKeepingOptionSuffixSql`), and the portal hand-off
(`portalOptionsFor()` on `GET /money/job-lookup/:hh` — `payable` is false for a live option whose sibling
confirmed; the portal repo refuses before any Stripe session). Festival-style grouping is NOT a `part_of` group — it is job projects, below (§14 says why: every group read path assumes alternatives). An option confirmed with nobody on the page gets a bell AND a To Do (`source_type = 'quote_option'`). **Spec §14 is the handover: what's left and where it's specified.** **`job_duplicate.php` returns the new job under `ID`** (`readDuplicatedJobNumber()`; Re-open uses
it too). Copy strings: `frontend/src/lib/optionCopy.ts`.

**BUILT, 21 Oct 2026:** `docs/JOB-PROJECTS-SPEC.md` — job projects: "these jobs all belong to the same
festival" (core backline, outlier stages, band spot-hires). A panel top right on Job Detail (name, client,
lead Ooosh-er, roll-ups, every job), "+ Add to a project" in the header, a chip on Kanban cards, project
names in global search, "+ New job in this project" = a blank New Enquiry with the project's client and
dates. **Its own table (`job_projects`) and column (`jobs.job_project_id`) — never `job_groups`**, and not
`jobs.hh_project_id`/`project_name` (HireHop's, unused). **The project's dates are defaults for NEW jobs
only — never pushed into existing jobs** (Start/End are what HireHop charges). All logic in
`services/job-projects.ts`; copy in `frontend/src/lib/projectCopy.ts`.

**BUILT (all three phases), Oct 2026:** `docs/STAFF-LOGIN-SECURITY-SPEC.md` — two-factor for every OP
staff login. Phase 1: a 6-digit email code as the second factor, **trusted devices** (the
`op_device` cookie, httpOnly, `/api/auth` only, 90 days — a person's own laptop and phone are
asked once each), per-account slowdown on wrong passwords (Redis, fail-open), `users.login_disabled`
(the `system@` service identity never logs in), My profile › Login security, Staff page › Access
› Login security (reset, sign out everywhere; an admin's row only by an admin), and the grace
period `system_settings.staff_2fa_enforced_from` (a banner until that date, then the login
insists; editable in Settings). `services/staff-login-security.ts`; `/auth/login` answers `{ pending, methods }`
when a second step is owed. **Phase 2: passkeys** (`services/staff-passkeys.ts`, @simplewebauthn, RP id
`staff.oooshtours.co.uk`): "Sign in with a passkey" is the whole login; **mandatory for admins** — an admin
with no passkey gets a modal that will not close, and once they have one the email code is refused for them;
recovery codes are admins only, shown once. The banner's "Set up now" opens the setup modal in place.
**Phase 3: the kiosk till** (`services/kiosk-till.ts`, `/warehouse/till`): the warehouse PIN session gains
`scopes: ['collections','till']`, the PIN is accepted only from `system_settings.kiosk_allowed_ips`, the
till is held to `KIOSK_TILL_ALLOW` on `routes/shop.ts` (sales only, cash or reader, each naming a person
from the dropdown → `recorded_in = 'kiosk_till'`, `recorded_by_person_id`), the reader behind
`stripe_terminal_kiosk`. **Spec §8 is what shipped and where it differs from the design.**

**IN PROGRESS, Oct 2026:** `docs/FREELANCER-PORTAL-SPEC.md` — the freelancer portal programme. Done:
completion fixes, payment terms, security fixes, the Claude Design reskin of the portal (tokens in
`tailwind.config.js` `hf`/`kind`, shared pieces in `src/components/ui.tsx`), past work on the Completed page
(every kind, one window: `src/lib/history.ts`), the van screens in the portal look for freelancers only
(`frontend/src/modules/vehicles/components/freelancer/`, colours from `shared/design/freelancer-tokens.cjs`),
portal 2FA (emailed code + 90-day remembered phone; **ships OFF** until jon sets `portal_2fa_enforced_from`; §7.1),
freelancer invoices linked to the freelancer and their work in Costs (§5.1; the past ones linked by hand, Oct 2026),
the Earnings tab in the portal (§5.2: money by invoice, "To invoice" from 22 Oct 2026).
Next: the four guides. The Costs form simplification is done (three PRs, Oct 2026: `docs/design/cost-capture-redesign/DECISIONS.md`).
**§0 "Start here" is the handover; read it before touching anything freelancer-facing.**

**DRAFT, Oct 2026:** `docs/DISCOUNTS-SPEC.md` — structured discounts (per group of things on a job ×
hire length × job value, quiet periods, 50% cap with manager override, per-ARTIST brand endorsements).
Phase 1 (artist endorsements) BUILT 16 Oct 2026 — spec §4; the rest is decisions only. The groundwork AI quoting will read.

**PARKED, Oct 2026:** `docs/AI-QUOTING-SPEC.md` — Claude drafts quotes (vans first) and the
reply; a person always sends. **HireHop forbids generating its document PDFs via the API**
(support, 15 Oct 2026) — never work around it; §3 is the evidence. §5 the decisions, §6 what must exist first.

**IN PROGRESS, Oct 2026:** `docs/AI-KNOWLEDGE-SPEC.md` — the house knowledge every AI client draft
reads: the voice (Phase A built), house guides as Staff Documents shared with Claude (Phase B built —
admin-only Claude switch, `house-knowledge.ts`), the client brief, and "remember this?" client facts.
**Code rails beat written guidance**; nothing is learned without a human tick. §9 is the decisions.

**LIVE, Oct 2026:** `docs/TOUR-FINDER-SPEC.md` — the Leads module (Jobs → Leads): Ticketmaster
tour search, AI scoring that weighs OOOSH history, address-book matching, contact research,
outreach → chased Cold enquiry, jobs-for-this-tour linking. **§20 is the current state and what's
left.** Searches are run by hand on purpose (no scheduler). Contact research wants management /
the band / tour managers — not promoters or agents.

**The Staff page is one URL, two levels.** `/staff/admin` is the roster; a person opens
in place as `?person=<id>&tab=overview|employment|time|records|reviews|access|absence`. The person is
in the URL rather than in component state so a notification can deep-link to the tab
that answers it — new bells should link that way, not at the bare page. **Exception:
anything waiting for an approval** (leave, overtime, WFH requests, day swaps) links to the bare page,
because the "Waiting for you" panel there is the approvals surface; the person's Time
off tab is not reliable for it (jon, Oct 2026 — see `staff-notifications.ts`). The page is
manager-tier but Records, Reviews and the Overview's data are admin-only, so anything
added to those tabs must degrade for a manager rather than 403. Every tab is built
from `components/StaffCard.tsx` (Oct 2026) — use it for anything new there so the
tabs keep reading the same way.

---

# Always-on conventions

These apply wherever you are working.

## There is probably already a helper — check before writing a second one

The most common failure mode in this codebase is two places deriving the same fact and
drifting apart. Before writing logic that answers one of these questions, use the
existing definition:

| Question | THE definition |
|---|---|
| How much excess do we hold? | `v_excess_held` (view) |
| Who is charged, how much? | `services/excess-topn.ts` |
| Is this money figure settled? | `frontend/src/lib/money.ts` |
| Which documents may a re-opened sign-up form show? | `services/freelancer-documents.ts` |
| Is this driver's paperwork valid? | `services/driver-validity.ts` |
| What excess does this licence record attract? | `services/licence-excess.ts` |
| Is this driver identity-authorised? | `services/identity-review.ts` `isIdentityAuthorised()` |
| Is this driver cleared for paperwork? | `hire-forms.ts` `isDriverAuthorisedForAgreement()` |
| Is this driver signed for THIS hire? | `services/driver-hire-progress.ts` |
| Something went wrong for a driver on the hire form — record it, email info@? | `services/hire-form-errors.ts` (`POST /driver-verification/telemetry/client-error`, table `hire_form_error_events`). Critical only emails, one per driver per page per hour, 10 an hour in all; there is deliberately no screen |
| Who receives this client email? | `services/money-emails.ts` `resolveClientEmailTarget()` |
| Who receives a PCN email? | `services/pcn-recipient.ts` |
| Who could we contact on this job? | `services/job-contact-candidates.ts` |
| What's this van's hire status? | `services/fleet-hire-status-sync.ts` |
| Is this job genuinely returning? | `services/hire-lifecycle.ts` |
| What is a freelancer paid for a delivery / collection / crew booking? | `services/freelancer-fees.ts` `personalFee()` — their agreed rate, else the quote's fee (a crew's fee split evenly). The portal's "Your fee", Costs and Earnings all use it |
| Which of a freelancer's work is finished, what was it booked at, which invoice covers it? | `services/freelancer-work.ts` (`listFreelancerWork()`, `cost_work_items`; a run is one item at its combined fee). Whose invoice: `services/freelancer-invoice-person.ts`. Ticking the work also splits the job costs (`cost_allocations`, one share per job; studio evenings and yard days stay with overheads) since the capture form's redesign (`FREELANCER-PORTAL-SPEC.md` §5.1) |
| Which jobs does a cost land on, and who pays on each (capture form)? | `frontend/src/components/costs/costJobs.ts` `planSplit()` — one job holding the whole cost saves on the cost, anything else is a split whose shares carry who pays; sent as `allocations` in the SAME `POST`/`PATCH /costs` request and checked by `services/cost-allocations.ts` before anything is written. The split modal is retired (`docs/design/cost-capture-redesign/DECISIONS.md`) |
| Has this receipt already been added (no invoice number)? | `GET /costs/check-duplicate` — same amount to the penny, same day, same supplier (Xero contact, else the normalised name); warn only. `?receipt_r2_key=` answers "did my save land?" by the uploaded photo |
| Snapping a receipt on a phone | `/receipt` (`pages/ReceiptCapturePage.tsx`) — every staff role; "Waiting for a receipt" (it replaced `/my-receipts`, which redirects), the AI read, which job, who pays, save. The photo, the AI read and the retry rules are `components/costs/receiptRead.ts`, shared with the laptop form; a save is never re-sent blind |
| Which jobs had a van out around a date (a fuel receipt's job)? | `GET /costs/van-jobs?date=&reg=&search=` — two days either side of the hire, a swapped-out van ends at the swap, the dual assignment↔job match, the receipt's reg first |
| What does a freelancer's Earnings page show (paid, invoiced, to invoice, next payment)? | `services/freelancer-earnings.ts` `getFreelancerEarnings()` — money by INVOICE (paid in the period / dated in it and unpaid), "To invoice" only from `freelancer_earnings_labels_from`; never the expense estimate (`FREELANCER-PORTAL-SPEC.md` §5.2) |
| When does a quote's work end? When does the completion chaser start? | `services/quote-schedule.ts` — crew and People jobs by their LAST day (complete from it, chased 09:00 UK the day after), deliveries/collections from arrival time in UK time; shared by the chaser and the portal (`docs/FREELANCER-PORTAL-SPEC.md` §2) |
| Has a quote's van leg actually happened (booked out / collected)? | `services/quote-completion.ts` `isVanLegDone()` — by direction; "out on hire" is NOT a collection. The portal's van-only "All Done" and `maybeCloseQuote` both ask it |
| What happens to transport when a job dies? | `services/job-close-cascade.ts` |
| What happens to requirements when a job dies? | `services/requirement-close-sweep.ts` |
| When is this bill due? | `services/supplier-terms.ts` `resolveDueDate()` — a freelancer invoice: the first Friday a week after APPROVAL, 8 to 14 days (jon, Oct 2026, final — it had moved to the invoice date and back); bills approved before the switch (`system_settings.freelancer_terms_approval_from`) keep the invoice-date rule |
| What are this job's costs? | `GET /costs/by-job/:jobId` |
| Which recharges are there, on which job, still to do? | `v_cost_recharges` (view, one row per job a recharge bills) — a recharge is on the whole cost OR on each job's share of a split cost, never both; load / write one through `services/cost-recharges.ts` |
| Money coming BACK from a supplier? | `services/cost-credit.ts` |
| What does this held item need next? | `services/held-item-query.ts` |
| Talking to HireHop | `services/hirehop-broker.ts` |
| Sending any email | `services/email-service.ts` |
| A bell that ASKS for something — when is it done? | `services/bell-rules.ts` — ONE rule per `notifications.resolve_key` ("still needed while …", SQL over the bell row); `notification-resolve.ts` `retireDoneBells(key, id?)` applies it (call it from the code that finishes the thing — instant) and `sweepDoneBells()` every 5 min catches every other path. Set the key at insert; never on an FYI bell. Older wiring, same file: leave/overtime/WFH/day-swap `retire…Bells()` in `staff-notifications.ts`, mentions `resolveMyThreadMentions()` / `markMentionsSeen()`. Open bells refresh live (`notifications_resolved`); services push through `config/socket.ts` `emitToUser()` |
| Did this email actually arrive? Is this address bouncing / blocked by Resend? | `services/email-delivery.ts` (Resend webhook → `email_delivery_events`, `email_address_problems`); frontend `hooks/useEmailProblems.ts` + `components/EmailProblemFlag.tsx`. `email_log` 'sent' only means Resend accepted it |
| Pushing a deposit to HireHop | `services/hh-deposit.ts` |
| Pushing anything from HireHop to Xero | `services/hh-xero-sync.ts` |
| Encrypting PII | `services/encryption.ts` |
| Which of Ooosh's own guides does an AI client draft read? | `services/house-knowledge.ts` `getGuidesFor(topics)` — Staff Documents an admin shared with Claude (`ai_shared`, `ai_topics`), current approved version only; a shared `voice` guide replaces the built-in voice. Never a second reader (`AI-KNOWLEDGE-SPEC.md` §4) |
| Which Claude model? | `config/anthropic.ts` `CLAUDE_SONNET_MODEL` / `CLAUDE_HAIKU_MODEL` — never a model string in a service. Read a Claude structured-output reply with `readStructuredJson()`; Sonnet 5.5+ rejects forced `tool_choice` |
| Opening a possible insurance claim | `services/incident-claims.ts` `createClaimFromIssue()` — always from a Problem |
| The claim form's fields (staff form, PDF, client form) | `services/claim-form-fields.ts` (frontend: `@claimform`) |
| A claim's client links, driver code, damage marks, sketch | `services/claim-links.ts` (public routes: `routes/claim-form.ts` — every save through `sanitiseSection()`) |
| Chasing a client for their claim form / how far it's got | `services/claim-chase.ts` (`runClaimClientChase()`, `formProgress()`) |
| A van's GPS route between two times | `services/traccar-server.ts` `getRouteForReg()` (a claim's trace: `services/claim-gps.ts`) |
| Which tracker is in this van? Which Traccar device is it? Is this position real? | `services/gps-trackers.ts` (register + `isRealFix()` — 0,0 is a no-fix report, never a place); frontend `findDeviceByReg()` in `modules/vehicles/lib/traccar-api.ts` finds the device by the fitted tracker's IMEI |
| Texting someone about anything | `services/sms-service.ts` — each template goes live on its own via `SMS_LIVE_TEMPLATES` |
| Preparing a photo for upload (EXIF time, HEIC, compress + thumb) | `frontend/src/lib/imageNormalise.ts` `prepareImage()` |
| What is a van worth (approx.)? | `services/vehicle-value.ts` `estimateVehicleValue()` |
| What does DVSA say about this van's MOT? What IS its MOT date? | `services/dvsa-mot.ts` — DVSA's expiry is `mot_due` everywhere (`decideMotDue()`): whenever DVSA has a date it wins at the daily check; a typed date stands only until then, flagged (`mot_due_source = 'manual'`). **Never "keep the later date"** — a later-than-real MOT date makes alerts fire late. `markMotDueEdited()` after any manual write. Board flags: `components/mot/MotFlags.tsx`. Advisories are ticked off per item on the latest test (`markAdvisory()`, spec §18) — never hidden; the chip counts only open ones |
| Is this van for sale? Who may change the sale? Do its photos need a re-check? | `services/vehicle-sales.ts` (frontend pill: `useOpenSalesByVehicle()` in `modules/vehicles/lib/vehicle-sales.ts`) |
| What may a buyer see on a sale link? | `services/vehicle-sale-links.ts` `shapeForBuyer()` (sections: `frontend/src/components/vehicle-sale/BuyerSections.tsx`) |
| What is this person called? | `frontend/src/lib/displayName.ts` |
| …the same, on the backend | `services/display-name.ts` |
| Picking or creating a venue | `frontend/src/components/VenuePicker.tsx` |
| Is this new person / org probably already in the address book? | `services/address-book-similar.ts` (fuzzy, warn-only; `GET /duplicates/similar`, frontend `SimilarRecordsWarning.tsx`). The Duplicates page is the exact after-the-fact clean-up |
| Does this search look like a phone number? | `services/address-book-search.ts` `phoneDigitsForSearch()` — shared by the People and Organisations list searches |
| Artist endorsements (who, which brand, the deal, last confirmed) | `services/endorsements.ts` — on a person OR a band (artist not in OP), never both; deal is free text; over 12 months since the last check is flagged. `forClientContext()` feeds New Enquiry / Job view. Page: Operations › Backline – Endorsements |
| Recently viewed (per user) | `services/address-book-views.ts` — written ONLY when a detail page passes `?track_view=1`; pickers reading the same GET must not count |
| Which address-book tabs have content (main row vs "More")? | `frontend/src/hooks/useTabPresence.ts` + `components/EntityTabs.tsx` — asks each tab's own endpoint; an empty tab moves under More, never hidden; one opened during a visit stays in the row until you leave the page. Both pages keep the tab in `?tab=` |
| Find-or-create a person (by email) / org (by exact name) from an inbound source | `services/address-book-resolve.ts` — exact only; shared by the website enquiry intake and Leads. Also `isGenericMailbox()` (info@, bookings@… is an org email, not a person) |
| Did this job book, get lost, get cancelled? (history views) | `services/job-outcomes.ts` `JOB_OUTCOME_SQL` — org Hire History tab + Leads client history |
| What does OP know about a lead's band (enquiries, losses, retros)? | `services/leads/history.ts` `getClientHistory()` |
| Which leads go on the dashboard? | `services/leads/attention.ts` `getLeadAttention()` |
| Recording what happened to a lead (who, when) | `services/leads/events.ts` `logLeadEvent()` — never fails the action; read by the Leads timeline + Last activity |
| Which existing jobs belong to a lead's tour? Is it already quoted / booked? | `services/leads/tour-jobs.ts` — `syncTourJobs()`, `liveTourJobSql()` (drives the In pipeline stage + the dashboard card), `TOUR_JOB_OUTCOME_SQL` |
| A DATE column as `YYYY-MM-DD` in Leads code | `services/leads/dates.ts` `dateOnly()` — never `toISOString()` on a DATE (node-postgres gives local midnight; UK summer time shifts it a day) |
| What's today's date (or today + n)? | `services/uk-date.ts` `ukToday()` / `ukDatePlus()` / `ukDateOf()` (frontend: `lib/ukDate.ts`) — **never `new Date().toISOString().slice(0, 10)`**: the server and `toISOString()` are UTC, so between 00:00 and 01:00 BST that's yesterday (TOUR-FINDER-SPEC §19.1) |
| Telling a job's timeline it belongs to a Lead Finder tour | `services/leads/tour-jobs.ts` `noteLinkedJobs()` / `noteUnlinkedJob()` |
| Showing a private-bucket file in the DOM | `frontend/src/hooks/useAuthedFileUrl.ts` |
| Opening a private-bucket file in a new tab | `frontend/src/lib/openAuthedFile.ts` |
| Bank holiday or company day? | `frontend/src/lib/companyCalendar.ts` |
| Verifying an API key | `middleware/api-key.ts` |
| Is this a STAFF access token? | `middleware/auth.ts` `verifyStaffToken()` — `authenticate` and the Socket.io handshake both use it; never a second `jwt.verify` for staff |
| Is this login allowed in, does this device skip the code, is this account slowed down? | `services/staff-login-security.ts` — the second factor, trusted devices, the per-account slowdown; `routes/auth.ts` decides, this answers |
| A FREELANCER's portal sign-in: is the code on, does this phone skip it, a code (emailed or read out by staff), sign out everywhere | `services/portal-login-security.ts` — `routes/portal.ts` decides, this answers; the office's card is `PortalSignInCard.tsx` on the Freelancer tab (`docs/FREELANCER-PORTAL-SPEC.md` §7.1) |
| A passkey (register, log in with, remove), an admin's recovery codes | `services/staff-passkeys.ts` — challenges in Redis, rows in `user_passkeys`; frontend `lib/passkeys.ts`; the one setup flow is `components/LoginSecuritySetup.tsx` |
| May the warehouse kiosk's PIN session call this? Who may it name on a sale? Where does the PIN work? | `services/kiosk-till.ts` — `staffOrKioskTill(KIOSK_TILL_ALLOW)`, `assertKioskSeller()`, `kioskIpAllowed()`; a kiosk request carries `req.kiosk`, never `req.user` |
| Minting or verifying ANY JWT | `services/tokens.ts` `signFor(audience, …)` / `verifyFor(audience, …)` — every family has its own `aud`; never call `jsonwebtoken` directly (the portal session, on its own secret, is the one exception) |
| What must never leave a general `people` response? | `services/people-private-fields.ts` |
| A freelancer's tasks on a day booking / sitter evening — whose, which day, auto-tick, telling them | `services/freelancer-tasks.ts` — owned by a booking OR a shift, never a person; no date column (read through the owner). NOT To Do |
| Who can be given something to do? | `services/assignable-staff.ts` — active + staff role + a CURRENT employment record. Shared by To Do's "For" picker and `/users?assignable=true` |
| May this person change this task? | `services/staff-tasks.ts` `assertCanTouch()` — owner, setter or admin |
| When does a repeating to-do fall next? | `services/task-recurrence.ts` (pure; the form asks it via `/staff-tasks/series/preview`) |
| Shared To Do lists, watchers, archiving | `services/staff-task-lists.ts` (take / put back: `staff-tasks.ts` `takeTask()` / `releaseTask()`) |
| My job reminders and Problems, for To Do › Mine | `services/staff-task-pullins.ts` — read-only; writes go through their own modules |
| Who is due a staff review? | `services/staff-employment.ts` `listReviewsDue()` |
| What needs an admin's attention on Staff? | `services/staff-attention.ts` |
| What does a reviewee get to see? | `services/staff-review-prep.ts` `getMyReview()` |
| Does this module need a new person field? | Check `people` first — it already has phone, mobile, home address, DOB and both emergency contacts (mig 001) |
| When is a STAFF document due a re-check? | `services/staff-doc-cycles.ts` — the record's own `action_on` fires; the per-type intervals only pre-fill it (never `driver-validity.ts` — different people) |
| What staff data has expired? | `services/staff-retention.ts` |
| Is this person in the building / working from home? | `services/staff-day-status.ts` (`StaffDay.location`; requests in `services/staff-wfh.ts`) |
| A staff member swapping a day ("work Friday instead of Saturday") — may they, ask, approve, what the calendar shows | `services/staff-swaps.ts` — two `staff_pattern_exceptions` legs sharing a `swap_group_id`, which is the swap's id; asked for on My Time, approved like holiday, nothing on the calendar until approved; no ledger (`docs/STAFF-CALENDAR-SPEC.md` §8.2) |
| What goes in a person's calendar feed? | `services/staff-ical.ts` — own time only, never a colleague's |
| Building or restyling a tab on the Staff page | `frontend/src/components/StaffCard.tsx` — Card, StatCard, InfoRow, Pill, button classes (the Time off look) |
| What does a shop item cost / what VAT? | `services/shop-stock.ts` `resolveVatRate()` (the HireHop rate is an INDEX, not a percentage) |
| What is a shop transaction worth? | `services/shop-sales.ts` |
| Which HireHop job do shop sales go on? | `services/shop-period.ts` `getShopPeriodForSale()` (the week it was rung up in) → `getOrCreateShopPeriod()` |
| Which VAT does an international hire attract (portal figure, Money tab box)? | `services/vat-adjustment.ts` `calculateVatAdjustment()` / `vehiclesZeroRated()` — equipment split by UK / non-UK days; vehicles 0% only at 31+ days or with the "starts and ends outside the UK" item, else 20%; rehearsals / services 20%. **The payment portal has its OWN copy** (`netlify-functions` `functions/vat-adjustment.js`) — change both |
| Splitting an EU hire's invoice by UK / non-UK days | `services/eu-vat-split.ts` — on the DRAFT only; which line gets which VAT rule is `vat-adjustment.ts` `classifyNominals()`, shared with the portal figure |
| Settling a HireHop invoice end to end (draft, approve, Xero, allocate in HH, apply credits in Xero, complete) | `services/hh-invoice-close.ts` — THE recipe (`HIREHOP-BILLING-API.md` §8); callers pass a `CloseReporter`. Shop and hire close-out both sit on it; never a second copy |
| Closing a finished shop week (its pre-flight, penny check, state) | `services/shop-close.ts` — on the recipe above |
| A cancelled job's money (its fee invoice, what is owed / to refund, the refund reminder) | `services/cancellation-close.ts` — planned and allocated by `hire-close-out.ts` (`CloseOutPlan.cancellation`); frontend sums `lib/money.ts` `cancellationFeeGross()` / `cancellationBalance()` |
| An invoice built only from custom lines (charge after completion, cancellation fee) | `services/hh-invoice-close.ts` `raiseCustomLineInvoice()` |
| Charging a client after the job is Completed (misc, PCN fee + fine) | `services/completed-charges.ts` `raiseChargeInvoice()` — its own invoice from custom lines only; never before completion (those costs go on the HireHop job); left out of the job-total sums via `isChargeOnlyInvoice()` |
| Finishing a HIRE's money (plan → allocate hire deposits in HH + Xero → complete) | `services/hire-close-out.ts` — on the recipe above; never excess, never a refund; `job_closeout_log` is its record |
| Has the "OP Shop Sales" HireHop contact been edited? | `services/shop-contact-check.ts` |
| What is this shop sale called (`OT-SHOP-00100`)? | `services/shop-sale-ref.ts` `saleRef()` |
| Which jobs can a till sale go on / who's in today? | `services/shop-routing.ts` |
| Does the week's shop job match the till? What did the week take? | `services/shop-reconcile.ts` |
| The till's payment methods (backend / sitter till) | `services/shop-tenders.ts` — mirrors `frontend/src/lib/shopTenders.ts` |
| A shop sale's receipt / refund receipt | `services/shop-receipts.ts` |
| Refunding a shop sale / money back off a deposit | `services/shop-sales.ts` `reverseShopSale()` → `hh-deposit.ts` `refundDepositOnHH()` |
| The client's payment portal link (and its hash) | `services/payment-portal-link.ts` `getPaymentPortalLink()` — computed live from HireHop, never stored; the hash changes with the hire dates |
| A card-reader (S700) payment — sending, waiting, recording, test mode, who may use it | `services/stripe-terminal.ts` — `terminal_sessions` is the record AND the once-only gate; recorded through `recordPayment()` as `stripe_gbp` + `source = 'stripe_terminal'`; gated by `system_settings.stripe_terminal_roles` |
| Which jobs belong to the same festival? Its value, lead, default dates | `services/job-projects.ts` (`getProject()` roll-ups; quote options inside count once) |
| Recording a payment OP takes itself (staff click, Wise matcher) | `services/record-payment.ts` `recordPayment()` — OP row, HH deposit, excess update, Booked push, client email, hooks. The route is a thin wrapper; never re-implement the chain |
| A bank transfer that arrived in Wise — which job, hire or excess? | `services/wise-incoming.ts` — detector in the Gmail loop (DKIM-gated), matcher (job number → HH invoice → payer name as evidence), `incoming_bank_payments` queue on the Money overview. Amount = what the client SENT; Xero owns the fee |

Frontend display helpers with the same status: `lib/roles.ts`, `lib/driverStatus.ts`,
`lib/jobOrgName.ts`, `lib/vehiclePrep.ts`, `lib/preauth.ts`, `lib/revisitDate.ts`,
and `statusLabel`/`statusColor` in `ExcessPaymentModal.tsx`.

## Migrations

- **The migration runner has a HARDCODED file list.** Adding a `.sql` file is not
  enough — add the filename to the `migrations` array in `backend/src/migrations/run.ts`
  or it silently never runs.
- **Never edit a migration once it could have been applied anywhere.** The runner skips
  already-applied files, so the revised version never lands and production quietly
  diverges. Always add a new migration.
- Take the next free number at build time; parallel branches collide and get renumbered
  on merge.

## RBAC

Six roles: `admin`, `manager`, `staff`, `general_assistant`, `weekend_manager`, `freelancer`.

- **Use the shared constants, not hardcoded role lists.** `STAFF_ROLES` for anything the
  whole non-freelancer team needs; `MANAGER_ROLES` for money out the door, hard-gate
  overrides and PII reads; bare `authorize('admin')` only for irreversible decisions.
  Hardcoding `authorize('admin','manager','staff')` silently locks out `weekend_manager`
  and `general_assistant` — that shipped as a live bug.
- **`authenticate` accepts STAFF access tokens only** (`{ id, email, role }`, no
  `scope`/`type`/`typ` — Oct 2026). `JWT_SECRET` also signs public, kiosk and freelancer
  tokens; each has its own middleware. A new token type gets a marker and its own
  middleware — never widen `authenticate`. Table in `PLATFORM-CONVENTIONS.md` "Token
  types"; open items in `docs/SECURITY-AUDIT-BRIEF.md`.
- **`POST /auth/register` is manager-tier, and only an admin may create an admin.**
  It was PUBLIC with a caller-chosen role until Oct 2026. The `freelancer` role is
  not a login: refused at register, login and refresh — freelancers use the portal.
- **`weekend_manager` ≡ `manager`.** `authorize()` grants a weekend manager anywhere
  `manager` is allowed, so never list it separately. Frontend: use `hasManagerRole()` /
  `roleAllowed()` from `lib/roles.ts`, **never bare `role === 'manager'`**.

## Data handling

- **Soft-cancel, don't delete.** `vehicle_hire_assignments`, `job_excess` and the wider
  hire-tracking chain use `status = 'cancelled'`. The row records something that
  physically happened and R2 events reference it. There is no `DELETE FROM
  vehicle_hire_assignments` in the codebase and there shouldn't be.
- All SQL is parameterised. All IDs are UUIDs.
- **JSONB columns must be `JSON.stringify`d on write** — node-postgres sends a JS array
  as a Postgres ARRAY literal, which JSONB rejects. An EMPTY array survives, so the bug
  only surfaces once the feature is genuinely used.
- **Never reuse a pg parameter in two different type contexts** (a varchar column
  assignment and a text operator) — Postgres rejects the statement with `42P08`.
- **A regex in SQL is a plain `'...'` string, never `E'...'`.** An `E''` string eats
  the backslashes, so `\[` reaches the regex as a bare `[` and the pattern becomes a
  character class: it either throws ("invalid character range" — the auto-cover
  revert) or strips every matching letter (the inbox un-ack: "Check the van tyres" →
  "Chhys"). Both shipped and sat unnoticed until Oct 2026.
- API responses are `{ data, pagination }` or `{ error }`.

## Dependencies

- **Never run `npm audit fix --force`** — it pulls breaking majors that break the build.
  Plain `npm audit fix` (semver-safe) is fine and already applied.
- Two vulnerabilities are **deliberately left in `backend/` and must not be "fixed"**:
  `xlsx` (no npm fix exists; only parses trusted admin uploads) and `uuid` (only fixable
  via a breaking major, for a bounds issue we don't hit).
- The "critical" npm sometimes reports is `handlebars` via `ts-jest` — **dev-only, not
  shipped**. Don't panic over the severity label.
- Dependabot is live. **Always let a Dependabot PR build in the affected dir before
  merging** — a bump occasionally needs a code tweak.

## Product policy

- **Warnings, not hard gates.** Dispatch is the only hard gate and even that has a
  manager override. Red prep windows, excess shortfalls and compliance flags inform;
  they don't block. A gate with no route through it strands staff.
- **Never silently move money.** Surface a recomputed figure and let a human decide.
- Email domain is `@oooshtours.co.uk`.

## HireHop status mapping

| OP `pipeline_status` | HH | Note |
|---|---|---|
| `new_enquiry` / `quoting` / `paused` | 0 | HH stays Enquiry |
| `provisional` | 1 | |
| `confirmed` | 2 | Booked |
| `prepped` | 5 | HH has no usable "prepped"; it jumps to 5 on checkout |
| `dispatched` | 5 | OP-only distinction — doesn't push back |
| `returned_incomplete` / `returned` | 6 / 7 | see `hire-lifecycle.ts` — status 6 is ambiguous |
| `completed` | 11 | |
| `cancelled` / `lost` | 9 / 10 | distinct concepts, don't conflate |

HH codes: 0 Enquiry · 1 Provisional · 2 Booked · 3 Prepped · 4 Part Dispatched ·
5 Dispatched · 6 Returned Incomplete · 7 Returned · 8 Requires Attention ·
9 Cancelled · 10 Not Interested · 11 Completed

## Scheduled tasks (`config/scheduler.ts`)

Backups 02:00 · job financials 03:00 · Traccar backup + 12-month GPS purge 03:10 UK (off until `TRACCAR_DATABASE_URL` is set — `docs/TRACCAR-POSTGRES.md`) · close-out Xero sweep 03:30 (off until its setting is on) · holiday entitlement 06:05 · Xero reconcile 07:45 ·
bill payment pull-back 07:50 · compliance 08:00 ·
chase alerts 08:10 · auto-chase runner 08:10 · payroll report 08:20 (last month's, once, from the 1st) · lock-up chaser 08:45 · staff time digest
08:45 · return-to-work chase 08:50 · stale-enquiry
auto-lose 09:00 · freelancer offer chase 09:05 · carnet forms 09:15 · referral safety-net 09:18 · storage reminders
09:20 · claim client chase 09:21 · claim check dates + GPS capture 09:22 · holding reminders 09:25 · close-out chase 09:30 · staff documents 09:35 ·
pre-auth expiry 09:40 · staff records 09:45 (repeating to-do repair, to-dos, list items to watchers, to-do follow-ups, record action dates, reviews due, absence-detail purge) · Stripe pre-auth discovery 09:50 · year-end cash-out reminder
09:55 (sends 2 January) · company-days prompt 09:58 (November) · OOH reminders 10:00 · sitter task summary 16:00 ·
HireHop sync every 30 min · sanity scanners every 15 min · notification escalation
every 15 min · shop balance check every 15 min · shop drain every 2 min · shop stock mirror every 15 min ·
shop auto-close + email Mon 08:55 · shop contact check 06:40 · DVSA MOT refresh daily 07:30 ·
Gmail ingestion every 10 min · card-reader receipt sweep every 5 min (a reader payment unanswered for 15 min gets its email) · bell sweep every 5 min (retires bells whose thing is done, `bell-rules.ts`; also runs before each escalation).

Adding one? Gate it on the lost/cancelled + `keep_after_close` rule and the
`is_internal` rule (see `jobs-pipeline-dashboard.md`).

## Core tables

`people` · `organisations` · `person_organisation_roles` · `venues` · `interactions` ·
`users` · `jobs` · `job_contacts` · `job_organisations` · `job_requirements` ·
`quotes` · `quote_assignments` · `quote_contacts` · `drivers` · `vehicle_hire_assignments` · `job_excess` ·
`fleet_vehicles` · `costs` · `job_issues` · `held_items` · `storage_tenancies` ·
`notifications` · `audit_log` · `system_settings` · `external_id_map` ·
`shop_sales` · `shop_sale_lines` · `shop_sale_periods` · `shop_stock_cache`

`system_settings` is the generic key/value store for staff-editable operational config
(gate codes, thresholds, templates, feature toggles). **Use it rather than adding an env
var** when the value needs changing without a deploy.

---

# Deployment

Production is at `49.13.158.66`; the user SSHs in as root. Claude cannot SSH — provide
the commands.

```bash
cd /var/www/ooosh-portal
git status                     # investigate unexpected local changes BEFORE pulling
git pull origin <branch>
cd backend  && npm install && npm run build
cd ../frontend && npm install && npm run build
sudo systemctl restart ooosh-portal
sudo systemctl status ooosh-portal
journalctl -u ooosh-portal -n 50 --no-pager
```

- **Backend `.env` must have `SESSION_SECRET`** (the portal cookie secret, shared
  with the Netlify portal app) **and it must differ from `JWT_SECRET`** — the service
  refuses to start otherwise (Oct 2026). Production has it; a fresh server needs it.
- **`RESEND_WEBHOOK_SECRET`** (backend `.env`, Oct 2026) is the signing secret of the Resend webhook pointed at `https://staff.oooshtours.co.uk/api/webhooks/resend` (events: email bounced / suppressed / complained / failed / delivered). Without it the endpoint answers 503 and delivery problems go unseen.
- **A restart finishes the requests in progress first** (`index.ts`, up to 60s — Oct 2026), so
  `systemctl restart` can sit for a few seconds when a slow request is running; it isn't hung. Job
  16169: a restart landed 4 seconds after a card receipt and cut off the Money tab's reload.
  **The plain `systemctl restart` is the restart command (jon's call, Oct 2026).**
  `deploy/safe-restart.sh` is an OPTIONAL extra — it waits for a card-reader payment in progress
  first (up to 5 minutes, then stops without restarting; `FORCE=1` overrides). Don't make it the
  default or put it in `deploy.sh`.
- **The server runs Node 22 LTS from the NodeSource apt repo** (`/usr/bin/node`, upgraded from an
  EOL Node 20 on 23 Oct 2026 after CVE-2026-111497). `weekly-maintenance.sh`'s `apt upgrade` keeps it
  on the latest 22.x; Node 22 leaves maintenance April 2027 — `docs/MAINTENANCE.md` §1.3 is the plan.
- **`npm install` before building is not optional** on the manual path — a PR that added
  a dependency fails the build with "Cannot find module …". `deploy.sh` always installs.
- Run `npm run db:migrate` from `backend/` if there are new migrations. Re-running is
  safe; the runner skips applied ones.
- **The live Nginx config is `/etc/nginx/sites-available/default`, NOT `ooosh-portal`.**
  `deploy/nginx-ooosh-portal.conf` is a tracked reference copy that is not symlinked.
  Nginx changes must be applied manually on the server (`nginx -t && systemctl reload
  nginx`) — neither `git pull` nor `deploy.sh` will do it.
- Multi-branch merges happen on the server: fetch each branch, checkout the target,
  merge, migrate, build, restart.
