<!--
Extracted verbatim from the root CLAUDE.md (Sep 2026 restructure).
CLAUDE.md was ~757KB / 5,746 lines and was consuming most of every session's
context window before a single turn of work. It now carries only the
always-applicable conventions; the detail lives here.

This file is the FULL record: design decisions, incident forensics, shipped-work
history. The distilled "never do X" rules that must reach every session live in
`.claude/rules/*.md` (auto-loaded when Claude opens a matching file).
-->

# Returns, Close-Out, Cancellations & Combine — module reference

#### Step 4b: Returns & Close-Out System ← IN PROGRESS (Apr 2026)

When a job returns, there's a sequence of physical and admin tasks before it's truly done. This system extends the existing `job_requirements` framework with **post-hire close-out requirement types** that auto-create when a job enters return status and auto-detect completion from real data sources (HH billing, excess table, interactions).

**Design principle:** Same requirement card system as pre-hire prep, same status tracking, same UI patterns. Post-hire cards appear on the Job Detail "Job Requirements" tab under the Post-Hire toggle. The Returns page aggregates close-out progress across all returning jobs.

**Auto-creation trigger:** Derivation engine creates post-hire close-out requirements when HH status reaches 6 (Returned Incomplete) or 7 (Returned). Some types are conditional — only created when the job has relevant data (crew, excess records, etc.).

##### Close-Out Requirement Types

| Type key | Label | Icon | Condition | Auto-detect source | Status flow |
|----------|-------|------|-----------|-------------------|-------------|
| `vehicle` | Vehicle Check-In | 🚐 | Self-drive vehicles on job | Already exists (post_hire phase) | Not Started → In Progress → Done |
| `backline` | Backline De-Prep | 🎸 | Backline items on job | Already exists (post_hire phase) | Not Started → Working On It → Done |
| `damage_review` | Damage & Issues | ⚠️ | Vehicle `has_damage=true` OR manual add | `vehicle_hire_assignments.has_damage`, manual | Open → Awaiting Quote → Quoted → Resolved |
| `invoice` | Invoice | 🧾 | Always (every returned job) | HH `billing_list.php` kind:1 rows | Not Invoiced → Generated → Sent → Done |
| `payment_reconcile` | Payment Reconciliation | 💷 | Always (every returned job) | HH billing balance check (deposits vs hire value) | Outstanding → Done |
| `excess_resolve` | Excess Resolution | 🛡️ | `job_excess` records exist for this job | `job_excess.excess_status` | Pending → Resolved |
| `freelancer_followup` | Freelancer Follow-Up | 👤 | `quote_assignments` exist (crew on job) | Manual (future: portal integration) | Not Contacted → Chased → Done |
| `client_followup` | Client Follow-Up | 📞 | Always (every returned job) | Interactions table: any interaction logged after return_date | Not Contacted → Done |

##### Status Auto-Detection Logic

Close-out cards are **status-reactive** — they read from real data sources and auto-update their status:

| Type | Auto-detection | Manual override? |
|------|---------------|-----------------|
| `invoice` | Polls HH `billing_list.php` for kind:1 (invoice) rows on Money tab load. If found → status moves to `generated`. `sent` is always manual (button click). | Yes — staff clicks "Sent to Client" |
| `payment_reconcile` | Reads HH billing balance (same as Money tab). If `balance <= 0` → auto-resolves to `done`. | Can manually mark done if balance is within tolerance |
| `excess_resolve` | Resolution-authoritative via `syncExcessRequirementStatus()` (May 2026). `done` only when EVERY record is terminally resolved (`reimbursed`/`fully_claimed`/`waived`/`rolled_over`/`not_required`/`released`); else amber `in_progress` — auto-demotes a card staff marked Resolved while money's still `taken`/`pre_auth`/`partially_reimbursed`. Live `pre_auth` = decision pending (not resolved), surfaced as a blue countdown on the card. | Staff can mark done, but next sync re-derives from the money |
| `client_followup` | Queries `interactions` table for any interaction with `job_id` created after `jobs.return_date`. If found → auto-resolves to `done`. | Can manually mark done |
| `freelancer_followup` | Future: detect from freelancer portal submissions. For now: manual status change. | Yes — staff marks after contact |
| `damage_review` | Created when vehicle assignment has `has_damage=true`, or manually added. Status is always manual (awaiting external quotes, etc.). Supports **chase date** for follow-up reminders. | Fully manual |

##### Damage & Issues — "The Limbo Problem"

The `damage_review` requirement type addresses the most painful post-hire issue: things stuck in limbo (waiting for damage quotes, missing cables, insurance claims, etc.).

**Features:**
- **Chase date field** — "Follow up on this in X days" (reuses the same chase mechanism as pipeline)
- **Notes field** — free-text description of the issue (already exists on all requirements)
- **Activity log** — status changes logged to job interactions timeline
- **Dashboard surfacing** — future: "X jobs with unresolved damage" widget
- **Multi-issue support** — a job can have multiple `damage_review` requirements (one per issue, using `custom_label` to distinguish: "Scratched bumper GX17DHN", "Missing XLR cable")

**Status flow for damage:**
```
Open → Awaiting Quote → Quoted → Claimed (via excess) → Resolved
                                → Written Off → Resolved
                                → Client Paying → Resolved
```
For v1, simplified to: `Open → Awaiting Quote → Quoted → Resolved` (4 steps). Complex flows can be added later.

##### Returns Page Redesign

**Two sections (same as current but enhanced):**

**Active Returns** (HH status 6, 7, 8):
- Each job card shows close-out checklist as coloured dots/pills:
  - Green dot = done, Amber dot = in progress, Red dot = blocked/overdue, Grey dot = not started
- Sort by: return date (default), days since return, outstanding items count
- Filter pills: "Needs Invoice", "Damage Open", "Excess Pending", "Freelancer Outstanding", "All"
- Click job → Job Detail page, Post-Hire tab shows the close-out requirement cards
- Jobs with `status=8` (Requires Attention) get a red highlight

**Completed** (HH status 11):
- Collapsible section (same as current)
- Shows close-out summary (all dots green)

**Close-out progress endpoint:**
```
GET /api/returns/close-out-progress
```
Returns close-out status per job in bulk — reads from requirements (post_hire phase) + HH billing + excess table + interactions. Single endpoint to power the Returns page without N+1 queries.

##### Migration 044: Close-Out Requirement Types

```sql
-- New requirement type definitions for post-hire close-out
INSERT INTO requirement_type_definitions (type, label, icon, steps, sort_order) VALUES
  ('invoice',              'Invoice',                '🧾', NULL, 200),
  ('payment_reconcile',    'Payment Reconciliation', '💷', NULL, 210),
  ('excess_resolve',       'Excess Resolution',      '🛡️', NULL, 220),
  ('freelancer_followup',  'Freelancer Follow-Up',   '👤', NULL, 230),
  ('client_followup',      'Client Follow-Up',       '📞', NULL, 240),
  ('damage_review',        'Damage & Issues',        '⚠️', NULL, 250)
ON CONFLICT (type) DO NOTHING;
```

No new tables needed — all types use existing `job_requirements` table with `phase = 'post_hire'`.

##### Implementation Phases

**Phase A — Foundation (migration + derivation engine + Returns page)** ✅ COMPLETE
- [x] Migration 044: insert new requirement type definitions
- [x] Extend `hh-requirement-derivation.ts`: auto-create close-out requirements when job status >= 6
- [x] Conditional creation logic (only freelancer_followup if crew exists, only excess_resolve if excess records exist, only damage_review if has_damage flagged)
- [x] Returns page rebuild: close-out dots per job, filter pills, sort options
- [x] `POST /api/requirements/closeout-progress` bulk endpoint

**Phase B — Auto-detection (status-reactive cards)** ✅ COMPLETE
- [x] Vehicle check-in + backline de-prep: auto-done when HH status >= 7 (Returned)
- [x] Invoice detection: read HH billing_list for kind:1 rows, auto-flip `not_started → in_progress` ("Generated") when any non-proforma invoice exists
- [x] Payment reconciliation: auto-resolve `not_started → done` ("Reconciled") when total HH OWING minus OP-side VAT relief (`vatSaved` from `calculateVatAdjustment`) is ≤ £0.01. VAT-aware so international jobs paid through the portal at the adjusted rate reconcile correctly even though HH still shows owing == vatSaved.
- [x] Excess resolution: read job_excess statuses, auto-resolve when all terminal
- [x] Client follow-up: query interactions after return_date, auto-resolve when found
- [x] Invoice "Sent" cascade: marking invoice done auto-resolves client_followup
- [x] Invoice + payment_reconcile auto-detection lives in `hh-requirement-derivation.ts` (per-job-live, fires from 30-min sync, on-page auto-sync, and Sync HH button) — NOT just the Returns-page bulk endpoint. The bulk endpoint at `POST /api/requirements/closeout-progress` retains its own inline check (capped at 10 jobs/req, 5 min cache) for the Returns list view.
- [x] HH billing check rate-limited via broker (low priority, 5 min cache); both billing fetch and VAT lookup wrapped in try/catch so a flaky call leaves status at `not_started` rather than rolling back the derivation transaction
- [x] Invoice card labels revised (1 May 2026): `in_progress="Generated"` (auto-set when invoice detected), `done="Sent"` (manual via "Mark as Sent to Client" button) — so the manual progression lands on the most-progressed state

**Phase C — Invoice Sent + type rendering** ✅ MOSTLY COMPLETE
- [x] "Mark as Sent to Client" button on invoice requirement card (in_progress → done)
- [x] RequirementCard type-specific rendering for close-out types (all 6 types have status labels)
- [x] Damage review shows notes inline + chase date in amber
- [ ] Damage requirement: multi-issue support (custom_label per issue)
- [ ] Chase date on damage_review requirements (follow-up reminders via scheduler)
- [ ] Damage auto-creation from vehicle check-in flow (has_damage → auto-create damage_review requirement)

**Phase D — Dashboard + notifications** ✅ MOSTLY COMPLETE (15 Apr 2026)
- [x] Dashboard widget: "Returns & Close-Out" overview with active counts, outstanding items by type, oldest returns
- [x] Notification escalation: priority-based email (normal=4h, high=1h, urgent=immediate), respects working hours + user preferences
- [x] Damage auto-creation: vehicle check-in with `has_damage=true` auto-creates `damage_review` requirement immediately
- [ ] Chase date notifications: daily scheduler scans due_date on post_hire requirements → bell notification
- [ ] Freelancer portal integration: crew feedback prompts
- [ ] Auto-email: remind freelancers to submit expenses/feedback after job

**Completion retro + hire history** ✅ COMPLETE (15 Apr 2026)
- [x] Completion retro modal with rating (Great/OK/Issues default Great), notes, follow-up
- [x] Outstanding close-out items warning in completion modal
- [x] Retro stored as interaction on job timeline
- [x] Hire History tab on Organisation + Person detail pages
- [x] Lost reason displayed alongside retro in hire history
- [x] Lost detail text visible (not just tooltip) in hire history
- [x] Retro notes + follow-up shown inline (not just hover)
- [x] Task reminders / follow-up scheduling from retro: date picker with 1m/3m/6m presets creates follow_up notification snoozed until due date
- [x] Client's upcoming jobs shown in completion modal (blue info box with future bookings)
- [ ] Show client's upcoming jobs in completion modal (future)

##### Mobile Considerations (Apr 2026)
- Returns page uses card layout (not tables) — already mobile-friendly
- Close-out dots are small enough for mobile viewing
- Job Detail post-hire tab scrollable via existing tab bar mobile fix
- Filter pills use `flex-wrap` for mobile reflow

#### Step 4c: Cancellation System ← FOUNDATION COMPLETE (Apr 2026)

Full cancellation workflow distinguishing **lost enquiries** (never confirmed) from **cancelled bookings** (were confirmed, now cancelled). Replaces the previous approach where both mapped to `lost`.

**Full spec:** `docs/CANCELLATION-SPEC.md`

**Key decisions:**
- `cancelled` is a distinct pipeline status from `lost` (maps to HH status 9 vs 10)
- Cancellation calculator uses post-VAT-adjustment figures for accuracy
- VE103B certs are NOT voided on cancellation — requirements marked as not needed
- Transport & crew costs surfaced in modal for informed decisions
- Admin/manager can action cancellation; other staff see "Refer to Manager"
- Re-opening a cancelled job creates a new booking (via HH `job_duplicate.php`) — original stays cancelled for audit
- Partial cancellation (scope reduction) deferred to future

**Foundation — COMPLETE:**
- [x] Migration 047: cancellation fields on jobs table (`cancelled_at`, `cancelled_by`, `cancellation_reason`, `cancellation_fee`, `cancellation_refund`, `cancellation_notice_days`, `cancellation_notes`, `cancellation_tier`, `reopened_from_job_id`, `reopened_to_job_id`)
- [x] `cancelled` added to `PipelineStatus` type, config, writeback mapping, pipeline labels
- [x] HH status mapping split: `cancelled → 9`, `lost → 10` (was both → lost)
- [x] `cancellation-calculator.ts`: T&Cs clause 7.1 (pre-hire) + 7.3 (early return), three hire types, £25+VAT minimum. **The whole calculator works in EX-VAT** — `totalHireCost` is ex-VAT, the 10%/25% tiers apply to it, and callers/email add 20% for display. So `MIN_CANCELLATION_FEE` MUST be the **ex-VAT** figure `25` (= £30 inc-VAT), NOT `30`. Until Jun 2026 it was hardcoded `30`, so when the minimum applied (the common case for small jobs) the fee became £25+VAT+VAT = £36 inc-VAT — VAT counted twice. Reported on job 16114 (showed £36 retained / £165.60 refund; correct is £30 / £171.60). Don't reintroduce £30 as the minimum.
- [x] `cancellations.ts` route: calculate, process, transport-crew, list, reopen endpoints
- [x] Cancellation workflow: status update, timeline log, requirements marked done, vehicle assignments cancelled, crew cancelled + emailed, excess flagged, pending refund created, HH write-back
- [x] `CancellationModal.tsx`: calculator display, transport/crew summary, manual override, RBAC
- [x] Per-tier fee breakdown (only shows tiers relevant to hire length), copyable summary sentence
- [x] HH invoice section: net/VAT/gross breakdown with guidance
- [x] `LostCancelledPage.tsx` at `/jobs/lost-cancelled` with Cancelled/Lost tabs, search, pagination
- [x] Job Detail: red cancelled banner with fee/refund summary, "Re-open as New Booking" button
- [x] Crew cancellation + internal notification email templates
- [x] Client cancellation email (refund amount, timescale, invoice note)
- [x] Chase reminders suppressed for lost/cancelled jobs (clear `next_chase_date`, hide UI)
- [x] Pipeline fields (likelihood, chase) hidden for lost/cancelled jobs
- [x] Re-open: full field copy (dates, managers, orgs, venue) + HH `job_duplicate.php` with items/notes/transport
- [x] Cancellation close-out requirements auto-created (invoice, client follow-up, refund, excess) — same pattern as returns
- [x] Dashboard widget: cancellation overview (pending refunds, outstanding close-out items, fees retained)
- [x] "Back to Lost & Cancelled" navigation from Job Detail

**Remaining work:**
- [ ] HH invoice creation on cancellation (auto-create invoice for retained fee via `billing_deposit_save.php`)
- [ ] Refund processing through OP (currently manual via Money tab — future enhancement)
- [ ] Cancellation data surfaced in client hire history (like retro data)
- [ ] Early return calculator frontend integration (clause 7.3 — backend built, UI not yet)
- [ ] Partial cancellation / scope reduction (deferred — noted for future)

#### Combine Bookings (Jun 2026)

Merge two **same-client pre-hire** bookings into one — the "client wants their two separate hires to become one continuous hire" case (e.g. 15–22 Jul + 29 Jul–1 Aug → 15 Jul–1 Aug). Technically a cancellation of one booking, but a no-fee one that works in our favour (van tied up longer = more charge), so it does NOT run the normal cancellation/fee/refund path. Migration **125** added `jobs.combined_into_job_id`.

**Where:** "🔀 Combine" button in the Job Detail header (2×2 control grid: Sync HH / Pre-Hire Review on top, Combine / Mark Internal below). `MANAGER_ROLES`, pre-hire jobs only. Opens `CombineBookingsModal` — lists the same client's other pre-hire bookings (search fallback) → preview (kept / retired / combined dates / deposit-to-move + any blocks) → type-the-retired-HH-number to confirm.

**Survivor (kept) booking is server-decided**, never the browser's call (`assessCombine` in `routes/pipeline.ts`): excess-holder wins (so the held excess never has to move), then status progression (confirmed > provisional > enquiry — an enquiry folds INTO a confirmed booking), then deposit-holder, then earlier start. The endpoint refuses if the call's `:id` ≠ the assessed survivor. If the survivor differs from where staff opened the modal, the frontend navigates there on success.

**The deposit move is the only hard part** — HireHop has no "move deposit between jobs" and **rejects negative deposits** (a rejected row never reaches Xero — this was the first-cut bug). So each deposit is re-attributed the same way an excess reimbursement works: **recreate on the survivor first** (`pushDepositToHH` with explicit `bankId` = original bank), **then refund-against-the-original-deposit on the absorbed job** (`reverseDepositOnHH` → `billing_payments_save.php` with `deposit=<id>, OWNER=0, paid=<amount>` + `post_payment` Xero sync — NOT `billing_deposit_save.php`). Recreate-first ordering means a mid-failure double-counts the money (visible, recoverable) rather than losing it. Same bank + same day = a clean refund-out/receipt-in wash in Xero (stray lines reconcile trivially). **No client emails fire** — it's accounting only.

**Sanity read-back:** after the move, `getNetHireDepositTotal(absorbedHhJob)` (in `services/hh-billing-deposits.ts`) re-reads the absorbed job's NET hire deposits (gross `kind=6` minus `kind=3` refund-against-deposit rows — a gross read would false-positive since the refund is a separate row). Residual > £0.01 → loud `hh_warnings` line telling staff exactly what to remove manually. The modal alerts any `hh_warnings`.

**Eligibility blocks** (re-checked server-side, never trusted from the browser; clear message bounces to a manager): different clients, absorbed job invoiced, both holding real excess money, absorbed job has active transport/crew quotes, survivor not HH-linked, or either job past pre-hire.

**Absorbed job retirement:** `pipeline_status='cancelled'` + `combined_into_job_id` set, £0 fee/£0 refund, `next_chase_date=NULL`; open requirements cancelled, vehicle assignments soft-cancelled (+ fleet status resync), derivation excess stubs (`needed`/`pending`, no money) waived; HH write-back status 9; timeline interactions both sides. Job Detail shows an **indigo "Combined into another booking → View"** banner (links to survivor) INSTEAD of the red cancelled banner (gated on `combined_into_job_id`). **Cancellation analytics must EXCLUDE `combined_into_job_id IS NOT NULL`** — these aren't lost revenue, the money moved sideways.

**Endpoints** (`routes/pipeline.ts`): `GET /:id/combine-candidates` (picker list), `GET /:id/combine-preview?with=<id>` (eligibility + figures), `POST /:id/combine` (survivor = `:id`, `MANAGER_ROLES`). Helpers: `reverseDepositOnHH` + `getMethodForBankId` (`services/hh-deposit.ts`), `getJobBillingFacts` / `getNetHireDepositTotal` (`services/hh-billing-deposits.ts`), `CombineBookingsModal.tsx`.

**Deferred:** moving a *held excess* across (combine forces survivor = excess-holder for now, so it never needs to); multi-deposit edge cases beyond the clean single-deposit hire; combining a job with active crew (blocked — move/cancel the quotes first).

#### Lost / Cancelled cleanup pattern (28 Apr 2026)

**Cross-cutting rule for ALL requirement types** — current and future. When a job moves to `lost` or `cancelled`, every open requirement on the job (reminders, hire forms, excess records, vehicle prep, backline, rehearsal, sub-hires, custom — anything in `job_requirements`) is auto-cancelled UNLESS the user has explicitly opted to keep it alive past close-out.

**Why this exists:** Without this rule, requirements stranded on dead jobs keep firing scanner emails forever (orphaned reminders, hire-form chase emails for a hire that's not happening, excess pre-auth chases on a cancelled booking). Original symptom that drove the design: a test reminder on a Lost job kept emailing daily with no way to stop the chase, because the hourly reminder scanner had no `pipeline_status` filter and no way to acknowledge a notification "for good".

**The contract — every requirement type follows this:**

1. **Migration 064** added `keep_after_close BOOLEAN NOT NULL DEFAULT FALSE` on `job_requirements`. Any new requirement type inherits this column automatically.

2. **`CancelOpenRequirementsSection.tsx`** is shown in BOTH the Lost modal (`PipelinePage`, `JobDetailPage`) and the Cancellation modal (`CancellationModal`). It loads ALL open requirements (any type, any phase) on the job and lets staff tick the ones to keep alive. Default is unchecked = cancel. Event-triggered requirements whose trigger matches the target status (e.g. `event_trigger='cancelled'` on a cancellation) are shown with a disabled checkbox + "will fire on the way out" label, since they fire then self-mark done.

3. **Frontend submits `keep_requirement_ids: string[]`** (the ticked-to-keep ones). Empty/absent = cancel everything still open.

4. **Backend cleanup is handled in two places** (mirroring the two transition paths):
   - `PATCH /api/pipeline/:id/status` for `lost` transitions (`backend/src/routes/pipeline.ts`)
   - `POST /api/cancellations/:jobId/process` for `cancelled` transitions (`backend/src/routes/cancellations.ts`)
   Each path: (a) flags kept items with `keep_after_close = true`, (b) lets the event-trigger pass run (fires + self-marks done any reminders triggered on this status), (c) sweeps everything else still open with `status = 'cancelled'` and `notes` annotated `[Auto-cancelled: job marked lost]` / `[Cancelled]`. The order matters — flag first, fire triggers second, sweep last — so triggered requirements fire before cleanup deletes them.

5. **Background scanners check the flag.** Any scheduler task that finds work to do via `job_requirements` MUST gate on `pipeline_status NOT IN ('lost', 'cancelled') OR keep_after_close = true`. Currently applied to:
   - Reminder scanner (`config/scheduler.ts` — hourly)
   - Close-out chase scanner (`config/scheduler.ts` — daily 09:30)
   When adding a new scanner (hire-form reminders, excess pre-auth expiry, carnet chases, etc.), include this gate in the SQL.

**Per-requirement-type expectations (current & future):**

| Type | Cancel-on-close default | Notes |
|---|---|---|
| `reminder` | Cancel | Most common. Kept items survive (e.g. "chase the deposit refund in 2 weeks"). |
| `hire_forms` | Cancel | Auto-emails stop. Kept rare — only if a driver still needs to sign for some retroactive reason. |
| `excess` | Cancel | Pre-auth chases stop. Kept if money still needs collecting/refunding from cancelled job (use `keep_after_close` rather than leaving status open). |
| `vehicle` / `backline` / `rehearsal` | Cancel | Prep work no longer needed. |
| `transport` / `crew` | Cancel | Quote-side cancellation already handled separately by `cancellations.ts` step 5a. |
| `invoice` / `payment_reconcile` / `excess_resolve` / `client_followup` / `freelancer_followup` / `damage_review` | Cancel by default | But these are POST-hire close-out requirements — most cancellations re-create them via the cancellation close-out auto-creation path, so the cancel-then-recreate behaviour is correct. |
| `carnet` / `merch` / `sub_hire` / `custom` | Cancel | Kept rare. |
| **Future types** | **Cancel by default** | Always include the `keep_after_close` gate in any background scanner/auto-emailer for the new type. |

**Acknowledgement cascade:** Clicking "Done" on an inbox notification linked to a `reminder` requirement marks the underlying requirement as `done` too (`POST /api/notifications/:id/acknowledge`). Without this, hourly scanner re-creates a fresh notification 24h later because requirement status is still open. Cascade is currently `reminder`-only — other requirement types keep their full status workflow on the job page.

**Cascade-on-delete:** `DELETE /api/requirements/:id` also removes any pending notifications linked to that requirement (`entity_type='job_requirements' AND entity_id=$1`). Stops orphan notifications haunting the inbox after a requirement has been hard-deleted.

**Phase in `action_url`:** Notification action URLs include `&phase=pre_hire` or `&phase=post_hire` so clicking through from the inbox lands on the correct toggle. Without this, pre-hire reminders are invisible on dispatched+ jobs (which default to post-hire view) and vice versa. JobDetailPage reads `?phase=` from the URL to seed the toggle state.

#### Step 5: Payment Portal Repointing
*Merged into Step 3 Phase E (Money System).* See above for full repointing plan with `DATA_BACKEND` env var toggle.
