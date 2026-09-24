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

`docs/*-SPEC.md` are the hand-written per-feature specs; several rules point at them.

**CLOSED, Sep 2026:** `docs/STAFF-RECORDS-SPEC.md` — the private staff area. **All
seven phases shipped**: files, key data, `staff_tasks` + "My To Do", reviews, the
staff-facing review, document review cycles, retention. §20 is the current state and
the short list of what is deliberately NOT built. Read it before changing anything here.
Wider to-do work (assigning to others, recurring) is the general tasks module, not this one.

**The staff DVLA/document check has NOTHING to do with `drivers`.** jon's decision,
Sep 2026: the `drivers` machinery verifies self-drive-hire CLIENTS (30-day
insurability, `services/driver-validity.ts`); the staff one is an annual sanity check
on an employee (`services/staff-doc-cycles.ts`). Same words, different people, different
consequence. Never merge them.

**`staff_record_files` objects live under the `staff-records/` R2 prefix, and that
prefix is the ONLY one `GET /api/files/download` role-gates.** Every other prefix it
serves is readable by any authenticated caller, freelancers included. Never file
anything private under `files/`.

**BUILT (steps 1–8), Sep 2026:** `docs/SHOP-SALES-SPEC.md` — the **Shop Till**
(`/money/shop`). Ad-hoc shop sales, internal stock consumption and sale-stock
lookup, with HireHop remaining the single stock database. **§19 is the current
state, the live settings, and what to do next — read it before touching this.**

Three rules from it that bite elsewhere:
- **A stock movement is EITHER a HireHop job line OR a `tally_save` adjustment,
  never both** — doing both halves the shelf count silently.
- **`success: true` from HireHop does NOT mean HireHop did it.** Verify writes by
  reading back; it has returned success for a no-op twice.
- **The weekly shop job is never synced into OP's `jobs` table** and must never
  be linked to from the UI. Sale stock is only consumed while that job is
  DISPATCHED, so any status change releases a week of stock, silently.

**The Staff page is one URL, two levels.** `/staff/admin` is the roster; a person opens
in place as `?person=<id>&tab=overview|employment|records|reviews|access`. The person is
in the URL rather than in component state so a notification can deep-link to the tab
that answers it — new bells should link that way, not at the bare page. The page is
manager-tier but Records, Reviews and the Overview's data are admin-only, so anything
added to those tabs must degrade for a manager rather than 403.

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
| Is this driver identity-authorised? | `services/identity-review.ts` `isIdentityAuthorised()` |
| Is this driver cleared for paperwork? | `hire-forms.ts` `isDriverAuthorisedForAgreement()` |
| Is this driver signed for THIS hire? | `services/driver-hire-progress.ts` |
| Who receives this client email? | `services/money-emails.ts` `resolveClientEmailTarget()` |
| Who receives a PCN email? | `services/pcn-recipient.ts` |
| Who could we contact on this job? | `services/job-contact-candidates.ts` |
| What's this van's hire status? | `services/fleet-hire-status-sync.ts` |
| Is this job genuinely returning? | `services/hire-lifecycle.ts` |
| What happens to transport when a job dies? | `services/job-close-cascade.ts` |
| What happens to requirements when a job dies? | `services/requirement-close-sweep.ts` |
| When is this bill due? | `services/supplier-terms.ts` `resolveDueDate()` |
| What are this job's costs? | `GET /costs/by-job/:jobId` |
| Money coming BACK from a supplier? | `services/cost-credit.ts` |
| What does this held item need next? | `services/held-item-query.ts` |
| Talking to HireHop | `services/hirehop-broker.ts` |
| Sending any email | `services/email-service.ts` |
| Pushing a deposit to HireHop | `services/hh-deposit.ts` |
| Pushing anything from HireHop to Xero | `services/hh-xero-sync.ts` |
| Encrypting PII | `services/encryption.ts` |
| What is this person called? | `frontend/src/lib/displayName.ts` |
| …the same, on the backend | `services/display-name.ts` |
| Picking or creating a venue | `frontend/src/components/VenuePicker.tsx` |
| Showing a private-bucket file in the DOM | `frontend/src/hooks/useAuthedFileUrl.ts` |
| Opening a private-bucket file in a new tab | `frontend/src/lib/openAuthedFile.ts` |
| Bank holiday or company day? | `frontend/src/lib/companyCalendar.ts` |
| Verifying an API key | `middleware/api-key.ts` |
| What must never leave a general `people` response? | `services/people-private-fields.ts` |
| Does this person own this task? | `services/staff-tasks.ts` `assertCanTouch()` |
| Who is due a staff review? | `services/staff-employment.ts` `listReviewsDue()` |
| What needs an admin's attention on Staff? | `services/staff-attention.ts` |
| What does a reviewee get to see? | `services/staff-review-prep.ts` `getMyReview()` |
| Does this module need a new person field? | Check `people` first — it already has phone, mobile, home address, DOB and both emergency contacts (mig 001) |
| When is a STAFF document due a re-check? | `services/staff-doc-cycles.ts` — the record's own `action_on` fires; the per-type intervals only pre-fill it (never `driver-validity.ts` — different people) |
| What staff data has expired? | `services/staff-retention.ts` |
| What does a shop item cost / what VAT? | `services/shop-stock.ts` `resolveVatRate()` (the HireHop rate is an INDEX, not a percentage) |
| What is a shop transaction worth? | `services/shop-sales.ts` |
| Which HireHop job do shop sales go on? | `services/shop-period.ts` `getOrCreateShopPeriod()` |
| What is this shop sale called (`OT-SHOP-00100`)? | `services/shop-sale-ref.ts` `saleRef()` |
| Which jobs can a till sale go on / who's in today? | `services/shop-routing.ts` |
| Refunding a shop sale / money back off a deposit | `services/shop-sales.ts` `reverseShopSale()` → `hh-deposit.ts` `refundDepositOnHH()` |

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

Backups 02:00 · job financials 03:00 · holiday entitlement 06:05 · Xero reconcile 07:45 ·
bill payment pull-back 07:50 · compliance 08:00 ·
chase alerts 08:10 · auto-chase runner 08:10 · lock-up chaser 08:45 · staff time digest
08:45 · return-to-work chase 08:50 · stale-enquiry
auto-lose 09:00 · freelancer offer chase 09:05 · carnet forms 09:15 · referral safety-net 09:18 · storage reminders
09:20 · holding reminders 09:25 · close-out chase 09:30 · staff documents 09:35 ·
pre-auth expiry 09:40 · staff records 09:45 (to-dos, record action dates, reviews due, absence-detail purge) · Stripe pre-auth discovery 09:50 · year-end cash-out reminder
09:55 (December + January) · company-days prompt 09:58 (November) · OOH reminders 10:00 ·
HireHop sync every 30 min · sanity scanners every 15 min · notification escalation
every 15 min · shop drain every 2 min · shop stock mirror every 15 min ·
Gmail ingestion every 10 min.

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
