<!--
Extracted verbatim from the root CLAUDE.md (Sep 2026 restructure).
CLAUDE.md was ~757KB / 5,746 lines and was consuming most of every session's
context window before a single turn of work. It now carries only the
always-applicable conventions; the detail lives here.

This file is the FULL record: design decisions, incident forensics, shipped-work
history. The distilled "never do X" rules that must reach every session live in
`.claude/rules/*.md` (auto-loaded when Claude opens a matching file).
-->

# Operations Modules — module reference

Requirements engine, backline, rehearsals/studio sitters, transport & crew ops, carnets.

#### Step 6: Operations Modules (Hire Readiness) ← ARCHITECTURAL REVISION (Apr 2026)

**Paradigm shift (Apr 2026):** The Prep Checklist is now **primarily HH-derived**, not manually created. HireHop line items are the source of truth for *what's on a job*; the OP adds the *operational intelligence* on top — who needs to do what, when, and whether it's done.

**Architecture:** Each confirmed job gets a **Prep Checklist** (the new default tab on Job Detail). Requirements are automatically generated from HireHop line items via the **HH-Derived Requirements Engine** (see section below). Manual requirements still exist for OP-only activities (incoming deliveries, lost property, etc.).

**Key design decisions:**
- Prep Checklist = the job-level dashboard. Always the first tab you see.
- Status system is **non-linear** (any status → any status), styled like pipeline badges (rectangular, coloured).
- **HH-derived requirements auto-update** when HH line items change — no manual re-entry needed.
- **Mismatch flagging:** If HH changes after staff has acted (e.g. marked "done"), surface a warning rather than silently overwriting.
- **Dashboard** (`/dashboard`) is the global overview — aggregates all outstanding items across all jobs, including prep time estimates.
- **Freelancer portal integration** — crew assignments, delivery jobs, studio sitter assignments all need to be readable/writable from the freelancer portal (currently reads from Monday.com, needs repointing to OP).

##### Stream 1: Core Requirements System (FOUNDATION — MOSTLY COMPLETE)
- [x] `job_requirements` table + migration (migration 021)
- [x] Requirements API: CRUD, non-linear status changes, templates
- [x] Wire Prep Checklist to real data (replace dummy prototype)
- [x] Replace Overview tab with Prep Checklist as default job tab (now called "Job Requirements")
- [x] Non-linear status badges (styled like pipeline status dropdowns)
- [x] Progress indicators on Jobs list page + Pipeline kanban cards (real data via bulk endpoint)
- [x] Likelihood badge hidden for confirmed+ jobs (no longer relevant post-booking)
- [x] Full Details tab removed — details/notes now editable inline on Overview tab
- [ ] Deposit/payment progress bar on Prep Checklist (visual: deposit taken vs full fee)
- [x] **HH-Derived Requirements Engine** (see dedicated section below) — auto-create/update requirements from HH line items
  - [x] Migration 041: seat_layout on fleet_vehicles, hh_derived_flags/line_items_synced_at on jobs, mismatch tracking on job_requirements, is_van_and_driver override
  - [x] Line items sync fixed: kind:3 selected prompts preserved (were being filtered out), richer field set stored (kind, AUTOPULL, VIRTUAL, LFT/RGT, TYPE_CUSTOM_FIELDS)
  - [x] Derivation service (`hh-requirement-derivation.ts`): detects vehicles, seats, backline, rehearsals, crew; extracts prep time; auto-creates requirements; respects manual status; flags mismatches
  - [x] On-demand sync endpoint: `POST /api/hirehop/jobs/:jobId/sync` (fresh item fetch + derivation)
  - [x] Derived flags endpoint: `GET /api/hirehop/jobs/:jobId/derived-flags`
  - [x] Van & Driver toggle: `PATCH /api/hirehop/jobs/:jobId/van-and-driver`
  - [x] Wired into 30-min scheduled sync + HH webhook handler (job.updated)
  - [x] Frontend: "Sync now" button on Job Detail + auto-sync on page load
  - [x] Frontend: Seat config display on Prep Checklist + Drivers & Vehicles tab
  - [x] Frontend: `seat_layout` field on vehicle detail page (Premium vans)
  - [x] Frontend: Van & Driver toggle button on Job Detail
  - [x] Reusable `RequirementCard` component (`frontend/src/components/RequirementCard.tsx`)
  - [x] Vehicle card with nested hire_forms + excess (indented under vehicle)
  - [x] Hire form "Send" button with contact picker (email/name checkboxes, send/chase modes)
  - [x] Hire form card status enrichment: sent date badge, received count, referral count
  - [x] Hire form email endpoint: `POST /api/hire-forms/send-email` + `GET /api/hire-forms/email-contacts/:jobId` (contacts from 5 sources: client org, org people, job_organisations, org emails, HH contact name match)
  - [x] Hire form sent badge persists on refresh (derivation engine preserves user-appended notes, send sets status to in_progress)
  - [x] Info badges (Sent, Received, Referral) visually distinct from action buttons (pills vs solid filled buttons)
  - [x] Hire form auto-email scheduler (daily 09:00). Initial fires 8-11 days before hire start (self-healing window), chase fires 4-5 days before. Missed-initial backstop in the 4-5 day window catches jobs that slipped past the initial window for any reason. On-confirmation hook fires from `pipeline.ts`, `money.ts` payment-event, AND `webhooks.ts` HH webhook (no entry-point gaps). Single canonical contact resolver in `services/hire-form-contacts.ts` used by both the auto-emailer and the manual `/email-contacts/:jobId` picker — same 5 sources (client org email, client-org people, `job_organisations` linked entities' people, org-level emails, HH contact-name match). 0-contact resolution fires a `sendConfirmationSilentSkipAlert` to info@ rather than logging-and-moving-on. **May 2026 history:** all five of these were silent gaps until the 15175 incident exposed them — exact `= 10` day match (no recovery if missed), narrow contact lookup (only `client_id` org + people, missed `job_organisations` linked management/promoter contacts), no missed-initial backstop (chase WHERE clause required `notes LIKE 'Hire form email sent'`, so a missed initial meant no chase either — total black hole), HH-webhook-driven confirmations didn't call the on-confirmation hook, 0-contacts silently logged "0/0 sent". 14 jobs in the next 14 days had to be backfilled via `scripts/send-missing-hire-form-emails.ts`. See commit `a3c65c8`.
  - [x] Hire form on confirmation: auto-sends when job confirmed with ≤10 days to start (covers all three confirmation entry points — manual pipeline transition, payment-portal payment-event, inbound HH webhook)
  - [x] Van & Driver toggle: soft-suspends hire_forms/excess requirements AND cascade-waives the matching job-level `job_excess` record (May 2026: status='waived', required=0, `[Suspended: Van & Driver]` marker in notes — only when `amount_taken=0` and status in `('needed','pending')`; records with money attached are skipped). Marker-gated restore on toggle-back. Without the cascade, Money tab + ExcessGateBanner kept showing "£1,200 required" on V&D-only jobs because they read from `job_excess` directly. Mixed-job calc (1 SDH + 1 V&D) was already correct — derivation engine + hire-form top-N-drivers both read `flags.self_drive_count`, not total `vehicle_count`.
  - [x] Requirement deletion: confirmation dialog with required reason for hire_forms/excess, logged to activity timeline
  - [x] Stale requirement cleanup: removes auto-requirements not on HH, flags manual ones
- [x] On-demand job sync ("Sync now" button + auto-sync on Job Detail page open)
- [x] Mismatch flagging (HH changed since requirement was last updated/marked done)

##### Stream 2: Global Operations Dashboard
Aggregate views on the Dashboard page — click through to individual jobs from each widget.
- [ ] Transport overview widget: all jobs with transport needs, who's driving, when, where
- [ ] Crew overview widget: who's assigned where this week, availability gaps
- [x] Backline overview widget: jobs with backline, prep status (going out + returning, item counts, prep times)
- [ ] **Prep time estimates:** "4 vehicles need prepping today, est. 5 hours" (from `preptimemins` custom field on HH items, split by category)
- [ ] Incoming deliveries widget: what's arriving today across all jobs
- [ ] Carnet overview widget: outstanding carnets, return tracking
- [ ] Lost property widget: uncollected items with age
- [ ] Studio/rehearsal schedule widget: upcoming rehearsals, studio sitter assignments
- [ ] Payment summary widget: deposits pending, balances outstanding
- [ ] Hook into freelancer portal (repoint from Monday.com read/write to OP API)

##### Stream 3: Backline Module
Backline detection is HH-derived (items in backline categories auto-create the requirement). Backline *management* (prep status, issues, de-prep) lives in OP.

**"Backline" in Ooosh context = ALL warehouse-prepped equipment** — instruments, PA/sound, DJ, lighting, power, staging, video, accessories. Everything except vehicles (370-371), rehearsal rooms (450), and storage (449).

- [x] Backline requirement auto-detected from HH line items (all equipment categories 372-453 except vehicles/rehearsal/storage)
- [x] Backline status labels: Not Started / Working On It / Done / Problem (type-specific overrides on shared status values)
- [x] Backline prep/de-prep time estimates from `preptimemins` custom field (includes virtual parent items)
- [x] Global backline overview page at `/operations/backline` — going out + returning stats, per-job rows with item counts and prep times
- [x] Backline overview API (`GET /api/backline/overview?days=N`) — configurable period, HH status as primary filter
- [x] Dashboard backline widget — headline summary with progress bar and click-through to backline page
- [x] Period filters: Today & Tomorrow / Next 7 Days / Next 14 Days
- [x] Direction filter: Both / Going Out / Coming Back
- [x] Status filter pills with colour-coded status breakdown
- [x] Inline status editing from overview (click status badge → dropdown, viewport-aware positioning)
- [x] HH job number clickable link to HireHop
- [x] HH status intelligence: jobs with HH status >= Prepped(3) treated as effectively done even if backline card not updated. "HH: Prepped" badge shown.
- [x] Last-minute item changes: amber "Items changed" badge + highlight when HH items modified after prep was actioned
- [x] Prep time rounding: per-job rows round up to 5-minute chunks, overview/dashboard rounds to 15-minute chunks
- [x] Remaining prep time excludes effectively-done jobs (backline Done OR HH Prepped+)
- [x] Returning section only shows dispatched+ jobs (no overlap with going-out for jobs whose return date is in the window)
- [x] RBAC: accessible to all non-freelancer roles (admin, manager, staff, general_assistant, weekend_manager)
- [x] Responsive filter bar (wraps on small screens)
- [x] Sync button triggers full HH job sync + re-derive
- [ ] Backline detail section on job (item list from HH, prep status per item in OP)
- [ ] Backline issues tracking (missing items, damage — similar pattern to vehicle issues)

**Pre-hire / Post-hire Phase System** ✅ COMPLETE (migration 042)
- [x] `phase` column on `job_requirements` (`pre_hire` | `post_hire`, defaults to `pre_hire`)
- [x] Pre-Hire / Post-Hire toggle on Job Detail > Job Requirements section
- [x] Each phase has independent requirement cards with independent statuses
- [x] Auto-generation of post_hire requirements when job reaches dispatched/returned status (backline de-prep, vehicle check-in)
- [x] Derivation engine respects phase — creates/updates pre_hire only, doesn't touch post_hire
- [x] Backline overview: "Going Out" reads pre_hire cards, "Coming Back" prefers post_hire (falls back to pre_hire)

**Threshold convention (May 2026) — read before changing post-hire gating logic:**
Post-hire backline + vehicle requirement creation (`hh-requirement-derivation.ts:529`) and the frontend Pre/Post toggle default (`JobDetailPage.tsx`) both gate on **OP `pipeline_status` ∈ {`dispatched`, `returned_incomplete`, `returned`, `completed`}** — not HH status. HH jumps to 4/5 the moment items get checked out, but OP holds at `prepped` until staff explicitly mark the job dispatched. Earlier code used `hhStatus >= 4` with a "more reliable than pipeline_status which can lag behind" comment — that reasoning is real but the trade-off was wrong here: surfacing post-hire cards before staff are meant to be working post-hire led to misclicks (job 15738 had pre-hire backline at `in_progress` and post-hire backline at `done` 5 seconds apart, classic toggle-confusion). The frontend toggle default also includes `cancelled` (cancelled jobs land on post-hire view for close-out work). The closeout-specific requirements (`invoice`, `payment_reconcile`, `client_followup`, `excess_resolve`, `freelancer_followup`, `damage_review`) keep their **HH-status gate** (`isReturnPhase = hhStatus >= 6`, `isFullyReturned = hhStatus >= 7`) — they're about physical return + auto-resolve on Returned, not the toggle. Don't conflate the two.

**Van & Driver suspension convention (May 2026):**
Requirements with `[Suspended: Van & Driver]` in `notes` (auto-derived `hire_forms` / `excess` rows soft-suspended when every van slot is V&D — see `suspendRequirement` in `hh-requirement-derivation.ts`, reason-parameterised since the Jun 2026 internal-job work) carry `status='blocked'` in the DB but are **not actually blocked** — they're "not required" on this job. Filter them out of any count/aggregate over `job_requirements`:
- Pre-Hire progress counter (`JobDetailPage.tsx`) — drops them from `totalCount` / `doneCount` / `blockedCount` so the bar/meter doesn't go red.
- Dashboard Today strip SQL (`routes/dashboard.ts`) — `WHERE notes IS NULL OR notes NOT LIKE '%[Suspended: Van & Driver]%'` so they don't render as red `prob` pips.
- Jobs page + Returns page progress bars (`routes/requirements.ts` `/bulk` and `/closeout-progress` endpoints) — same SQL filter on the bulk count queries that feed the per-row mini progress bars.

The cards still render in the requirements list as greyed "Not required — Van & Driver mode" stubs (`RequirementCard.tsx` already detects via `isSuspendedByVD`), they just don't move meters or fire alerts. Match this filter when adding any new count/aggregate or pip rendering over `job_requirements` — otherwise V&D-only jobs will look like they have unresolved problems on whatever surface you're building.

**Internal job convention (Jun 2026):**
Staff book vans onto HH jobs for garage visits / MOTs / our own vehicle movements — keeps HH stock accurate for last-minute quoting and gives a planning record, but everything client-shaped is noise on those jobs. `jobs.is_internal` (column existed since migration 002, activated Jun 2026 — no migration needed) is the one flag that mutes the client-facing chain. Set via the **"🔧 Mark Internal" toggle** on the Job Detail header (`PATCH /api/hirehop/jobs/:jobId/internal`, STAFF_ROLES, logs a timeline interaction, re-derives inline so cards suspend/restore immediately).

What `is_internal = true` mutes:
- **Derivation engine** (`hh-requirement-derivation.ts`): hire_forms + excess requirements soft-suspended with `[Suspended: Internal]` marker (same mechanism as V&D — restore on toggle-off is marker-gated, previous status preserved); derivation-created `job_excess` records cascade-waived (only when no money attached); close-out cards `invoice` / `payment_reconcile` / `client_followup` / `excess_resolve` NOT created on return (and the HH billing auto-detect fetch is skipped).
- **Hire-form auto-emailer** (`hire-form-auto-email.ts` both windows) + the on-confirmation hook (`confirmation-hooks.ts`, reason code `'internal'` — intentional skip, no silent-skip alert).
- **Money overview** (`routes/money.ts` `/overview`): excluded from Balances Outstanding, Deposits Pending and Excess Held lists + headline totals.
- **Last-minute booking alert** (`money-emails.ts` `sendLastMinuteAlert`).
- **Stale-enquiry auto-loser** (`config/scheduler.ts`).
- **Scheduled pre-hire review emails** (`pre-hire-briefing.ts` `findEligibleJobs` — the T-5/T-3/T-1 cron sends). The manual "Pre-Hire Review" button on Job Detail still works on internal jobs — explicit staff action, occasionally useful for a crewed garage run.
- **"No client email" amber banner** on Job Detail (frontend gate).
- **Quick-assign excess** (`routes/hire-forms.ts` `/quick-assign`): on internal jobs the per-driver record is created as `not_required` £0 — no orphan absorption, no top-N charge. (Same fix also added `'waived'` to the orphan-absorption exclusion list so quick-assign can never silently un-waive a staff-waived / V&D-waived / internal-waived record on ANY job.)

What it deliberately KEEPS (jon's call, Jun 2026): **Crew & Transport — everything** (quotes, arranging chaser, freelancer assignments, completion chasers — getting the van to the garage is often a local D&C run); vehicle requirement card + allocation + Turnaround Schedule; post-hire vehicle check-in / backline de-prep / `freelancer_followup` / `damage_review` cards; Going Out / Returning Today dashboard visibility; org hire history; the HH booking itself (stock accuracy). Grey "Internal" badge renders next to the status pill on Job Detail.

**The suspension marker filters are now generic:** every count/aggregate filter matches `notes NOT LIKE '%[Suspended:%'` (covers both `[Suspended: Van & Driver]` and `[Suspended: Internal]`) — `routes/dashboard.ts` strip SQL, `routes/requirements.ts` `/bulk` + `/closeout-progress`, `pre-hire-briefing.ts`, `JobDetailPage.tsx` counter, `RequirementCard.tsx` (which renders "Not required — Internal job" vs "— Van & Driver mode" per the reason). Use the generic form in any new filter. When adding a new client-facing scanner/aggregate, gate on `COALESCE(j.is_internal, false) = false` alongside the usual lost/cancelled gates. The suspend/restore helpers in `hh-requirement-derivation.ts` are now `suspendRequirement(client, jobId, type, reason)` / `suspendJobExcess(client, jobId, reason)` / `restoreJobExcessFromSuspension` — reason-parameterised, restore matches either marker.

**Known issue — OP ↔ HH status sync gap:**
Many jobs confirmed in HH before webhook integration went live (Mar 2026) have stale `pipeline_status` in OP. The backline page works around this by using `jobs.status` (HH integer) as primary filter. Potential fixes for the broader platform:
1. One-time reconciliation script: update `pipeline_status` based on `jobs.status` for all mismatched jobs
2. Add status reconciliation to the 30-min job sync (currently only updates `jobs.status` integer, not `pipeline_status`)
3. HH webhook handler already catches future changes — only historical pre-webhook jobs are affected

##### Stream 3b: Sub-Hires Module (OP-Only)
Sub-hire tracking lives entirely in OP. HH's PO/shortage method is too clumsy (custom items always show short).
- [ ] `job_subhires` table (what, supplier, status, cost, po_ref, due_date, received)
- [ ] Sub-hire tracking: need → sourcing → ordered → received → returned
- [ ] Per-job section + global sub-hire view

##### Stream 4: Incoming Deliveries + Lost Property (OP-Only)
These originate outside HH entirely — client sends stuff to us, or items found post-hire.
- [ ] `incoming_deliveries` table (job_id, description, expected_date, box_count, received_count, status, sender_name)
- [ ] Support for "mystery boxes" — record arrival with unknown association, link to job/client later
- [ ] Merch receiving: request sent → some received → all received → notified client → given to client
- [ ] `lost_property` table (job_id, description, found_date, found_location, photo, client_notified, collected, dispose_after)
- [ ] Auto-reminder: chase client to collect, flag for disposal after X weeks
- [ ] Global pages for both: `/operations/deliveries`, `/operations/lost-property`

##### Stream 5: Rehearsals / Studio Sitter Module ← A–E SHIPPED (Jul 2026); tasks + calendar + submit-chaser PENDING
**Full spec: `docs/REHEARSALS-SPEC.md`** — read it before touching rehearsal code.

**What's built (staff-side complete):**
- **Phase A — detection** (`services/rehearsal-plan.ts`): classifies rooms + flavour from HH line
  items, applies the base-room double-count rule + the finish-on-the-day timing rule, derives
  per-day sitter-needed evenings. `deriveRequirementsForJob` persists the result on
  `hh_derived_flags.rehearsal_detail` + sets the rehearsal requirement notes to a live summary.
- **Phase B — roster + assignment** (migration **153**: `studio_sitter_shifts` [one per date,
  UNIQUE = two-rooms-same-night jobs share one shift] + `studio_sitter_shift_assignments` [partial
  unique index = one live sitter per shift]). `services/studio-sitter.ts` (roster derivation,
  per-job coverage, assign/reassign/unassign, date-selectable bulk, manual-override cover,
  remove-cover, approved-freelancer list Studio-Sitter-tag-first, **coverage-driven requirement
  status** — winds Not Started→In Progress→Done, `blocked`/Problem left manual, synced from
  assign/unassign/remove + the derivation engine, default per-night fee from `system_settings`).
  `routes/studio-sitters.ts` (`/api/studio-sitters/*`, STAFF_ROLES). Frontend `StudioSittersPage`
  (Operations → Studio Sitters): roster with 7/14/All range + All/Unassigned/Assigned filter
  (localStorage-persisted), assign/reassign/clear, tick-nights bulk assign, manual "＋ Add cover" +
  Remove, manager-editable default fee. `RequirementCard`: evening chips are click-to-assign
  (inline picker) + "Manage on Studio Sitters roster →" link; shows the assigned sitter per chip.
- **Phase C — surfacing:** dashboard NeedsAttention "Evenings without a sitter" bucket
  (`sitter_gap_count`/`sitter_gaps` on `/dashboard/operations`, derived via `getRoster`); Job Detail
  amber pre-hire banner ("Rehearsal starts in N days — X evenings without a studio sitter", 7-day
  window hardcoded — promote to `system_settings` if it needs tuning); per-card daytime "＋ Call a
  sitter for a day →" link.

**What's left (the spec's Phase C portal / D / E / F):**
- **Phase D — freelancer portal surface for sitters** (IN PROGRESS): sitters see their assigned
  shifts in the Next.js portal (`src/app/`), shift detail = who's in each room that night (derived)
  + session times + shared specs/stage-plots (`share_with_freelancer` files) + the day-to-day
  handover thread. The sitter's `person_id` → `studio_sitter_shift_assignments`. The **default fee**
  captured on assignments is meant to display here.
  - **Slice 1 SHIPPED (backend, read-only):** `services/studio-sitter.ts` `getSitterShifts` /
    `getSitterShiftDetail` / `isSitterAssignedTo`; portal endpoints `GET /api/portal/studio-sitter/shifts`
    (own rostered nights, −3..+60d) + `GET /api/portal/studio-sitter/shifts/:date` (who's-in +
    shared job files, presigned; access-gated to the rostered sitter or the shared staff account).
  - **Slice 2 SHIPPED (portal UI, read-only):** the sitter's rostered evenings surface on the
    Next.js portal dashboard (`src/app/dashboard/page.tsx`) as a "🎸 Studio Shifts" section that
    sits alongside their driving jobs (hidden when they have none — most freelancers aren't
    sitters), plus a shift detail page (`src/app/shift/[date]/page.tsx`): envelope times, per-night
    fee, who's in each room, and each job's shared specs (`share_with_freelancer` files, presigned).
    Wiring: `getSitterShiftsFromOP` / `getSitterShiftDetailFromOP` + `Sitter*` types in
    `src/lib/op-api.ts`; OP-only Next.js API routes `src/app/api/studio-sitter/shifts/route.ts` +
    `.../shifts/[date]/route.ts` (empty list outside `DATA_BACKEND=op` — no Monday fallback, sitters
    are OP-native). Backend `getSitterShiftDetail(date, personId?)` was enriched to also return the
    shift envelope + the requesting sitter's fee/assignment status so the detail page is
    self-sufficient on a direct load/refresh (portal route now passes `req.portalUser.id`).
  - **Slice 3 SHIPPED (handover thread, two-way):** migration **164** adds `interactions.shift_id`
    (FK → `studio_sitter_shifts`, `ON DELETE SET NULL`) + `interactions.author_name` (display name for
    non-user authors). Freelancer-authored notes store `created_by = NULL` + `author_name` (sitters are
    people, not `users`); the read layer prefers `author_name`, else the `users → people` name. The
    `shift_id IS NULL` scoping guard was added to the person/org/job/venue reads in `routes/interactions.ts`
    (mirrors `issue_id`), plus a `?shift_id=` filter + INSERT/parent-inherit/entity-wiring support.
    **Portal:** `GET`/`POST /api/portal/studio-sitter/shifts/:date/thread` (`routes/portal.ts`) — flat
    chronological log, access-gated (rostered sitter or shared staff account); a sitter post fires a
    **low-priority bell (no email)** to prior staff participants of that thread. Portal UI: a "Handover
    notes" section on `src/app/shift/[date]/page.tsx` (read + composer). **Staff:** a per-row "💬 Notes"
    panel (`ShiftNotes`) on `StudioSittersPage` reading/posting `/api/interactions?shift_id=`.
    *Deferred:* @mention autocomplete in the staff composer (plain textarea for now — mentions still
    work via the generic API), file attachments on shift notes, and notifying staff of a sitter's
    *first* note before any staff have engaged the thread (staff see it via the roster Notes panel).
  - **Slice 3 refinements SHIPPED:** (a) **enquiries default-off** — `loadRehearsalJobs`/`getRoster`
    gained an `includeSpeculative` arg (default false → excludes `new_enquiry`/`quoting`/`paused`/
    `provisional`); the roster route reads `?speculative=1`, the staff page has an "Include enquiries"
    toggle + a blue "enquiry" row badge (`row.speculative`). Dashboard sitter-gap + bulk-assign inherit
    the confirmed-only default; the **portal** enrichment passes `includeSpeculative=true` so a sitter
    always sees every band booked that night. (b) **Roster look-back** — the staff page adds From/To
    date inputs (backend already accepted arbitrary `from`/`to`) alongside the 7/14/All quick-sets, so
    staff can scroll back through history; persisted in the `ooosh_studio_sitters_prefs` localStorage.
    (c) **Portal window** widened from +60d to **−14d…+365d** so far-future assignments surface.
    (d) **Job Detail handover card** — `StudioHandoverCard` on the Overview tab (self-hides on
    non-rehearsal jobs) lists the job's evenings and shows the shared per-evening thread; the roster's
    `ShiftNotes` was extracted to `components/StudioShiftNotes.tsx` (shared by both, now URL-linkified);
    reuses the existing `/studio-sitters/job/:jobId/coverage` endpoint (no new backend endpoint). URLs
    are auto-linkified on the portal thread too. *Still deferred:* image/PDF attachments on the thread.
    (e) **Notes-present indicators** — `getJobCoverage` + the roster's `loadShifts` now return a
    per-shift `note_count`; the roster "💬 Notes (N)" button highlights when a thread exists, and the
    Job Detail handover card shows a "💬 N" badge per evening + auto-opens evenings that already have a
    conversation. Removed the "One sitter per evening…" subtitle. **Notes are shift-anchored, so they
    survive reassign/clear** (the shift row stays; only removing a manual-cover shift hides its notes).
    A "Notes" button only appears once a shift exists (i.e. once assigned / manual cover) — unassigned
    future nights have no shift row yet, so no thread anchor.
  - **Slice 3 attachments SHIPPED:** images/PDFs on the handover thread, both surfaces. Stored on
    `interactions.files` in the staff attachment shape (`{r2_key, filename, content_type, size_bytes}`)
    under the `files/attachments/…` R2 prefix, so staff- and sitter-posted files render alike. **Staff**
    (`StudioShiftNotes`) reuse the `messaging/Attachments` stack (`useAttachments` + file input +
    paste + `PendingAttachmentStrip`, render via `AttachmentList`). **Portal:** the thread POST now
    accepts `multipart/form-data` (multer, 8MB×6, image/PDF only) → uploads to R2 → stores on the
    interaction; the Next.js route forwards multipart, `op-api` gained `postSitterThreadWithFilesOP`,
    and the shift page composer has a 📎 attach + inline image render. The thread GET's file mapper
    (`mapThreadFile` in `routes/portal.ts`) handles BOTH the `r2_key` (staff/sitter) and legacy `url`
    (shared-file) shapes + presigns `files/` keys. Attachment-only notes store `content='(attachment)'`
    (NOT NULL guard) and hide the placeholder on render. Deferred: thumbnail generation (images render
    full-size via presigned URL / auth blob), and per-message read receipts.
    **Two post-launch attach fixes (Jul 2026):** (1) the portal `onChange` read `Array.from(e.target.files)`
    INSIDE the deferred setState updater while `e.target.value=''` ran synchronously first and emptied the
    FileList → no chip. Capture the array BEFORE the reset (staff `useAttachments` + completion `PhotoCapture`
    both read synchronously — the pattern to follow). Portal chips now show an image thumbnail (objectURL,
    revoked on remove/post). (2) The multipart forward used `f instanceof File`, but **`File` is not a global
    in Netlify's Node runtime** (only `Blob` is) → `ReferenceError` → 502. Iterate `formData` entries as
    `string | Blob`, treat non-string as a file, materialise each to a fresh `Blob` before re-forwarding.
    **Convention: never reference the `File` global in a Next.js route handler — use `Blob` / duck-type.**
    The 3 OP-native sitter Next.js routes also had their `reportFallback` (Monday-fallback telemetry) calls
    removed — sitters never had a Monday board, so a 5xx firing a "fell back to Monday" alert was wrong.
  - **Slice 4 SHIPPED (end-of-day lock-up report — Phase E, migration 168):** the
    **"🔒 Finish for the night"** flow. Port of Jotform `203154178314046`, configurable, soft, no PDF.
    - **Storage:** migration 168 adds the 4 `report_*` columns to `studio_sitter_shifts`
      (`report_answers JSONB`, `report_template_version INT`, `report_submitted_by` → `people(id)` since
      sitters are freelancers not OP users, `report_submitted_at`); submit sets the existing `closed`
      status (roster/portal/coverage reads all already tolerate `closed`, so no regression to coverage
      sync or the sitter's own view). **Template + reference photos** live in `system_settings` (category
      `studio_sitter`, seeded by 168): `studio_sitter_lockup_template` (JSON string) +
      `studio_sitter_lockup_reference_photos` (JSON array). `services/studio-sitter-lockup.ts` owns
      parse/read with a hardcoded `DEFAULT_TEMPLATE` fallback (mirrors the seed) so the portal never
      breaks if the row is missing/corrupt.
    - **"Continuing tomorrow?" is DERIVED, not asked** — `isStudioInUseOn(nextDay)` queries whether ANY
      rehearsal job's `[first_session_date, last_session_date]` window (daytime OR evening; excl.
      lost/cancelled/internal, incl. speculative) spans the next day. Pre-filled + overridable (Yes/No
      buttons on the form); a `true` value hides the `end_of_booking_only` deep-clean items.
    - **Expected-answer flagging** — each template item carries an `expected` value; `computeExceptions`
      flags off-expected `yesno` answers (treats **`na`/`n/a` as non-exception** — not applicable = fine;
      unanswered ≠ exception). Submit shows "N items need attention"; the staff read-only view highlights
      ONLY the exceptions (amber), the rest a quiet green/red/grey recap. `report_template_version`
      records which template version was answered against (bumped on every Settings save).
    - **On submit** (`submitLockupReport`, one transaction, `FOR UPDATE` on the shift): store answers,
      set `status='closed'`, and post the free-text note + an exceptions summary line into the shift
      handover thread (`interactions` with `shift_id`, `created_by=NULL`, `author_name`) so it's
      **replyable — the Jotform-dead-end fix**. Then fire a staff bell (admins/managers, `email_sent_at`
      stamped so the escalator doesn't double-email) + an `info@` email (`studio_lockup_submitted`
      internal template) — both best-effort, never fail the submit. Lost-property prompt deep-links to
      `/holding/lost-property`.
    - **Portal:** `/shift/[date]/lockup` sub-page (`src/app/shift/[date]/lockup/page.tsx`), reached from a
      "🔒 Finish for the night" button at the bottom of the shift page. Reference photos, derived
      continuing toggle, yesno/text/number items, notes, sticky submit bar, success screen. Endpoints
      `GET`/`POST /api/portal/studio-sitter/shifts/:date/lockup` (access-gated: rostered sitter or shared
      staff account); Next.js route `src/app/api/studio-sitter/shifts/[date]/lockup/route.ts`; op-api
      `getLockupContextFromOP`/`submitLockupReportOP`.
    - **Staff read-only view:** `GET /api/studio-sitters/report/:date` → `getShiftReport` (full answers +
      exceptions). Reusable `StudioLockupReport.tsx` mounted on the Studio Sitters roster (🔒 button with
      green ✓ / amber ⚠N pip, from a `report` summary now on `getRoster`'s shift shape) and the Job Detail
      `StudioHandoverCard` (🔒 ✓ per-evening badge from `report_submitted_at` on `getJobCoverage`, expands
      the report inline). **Settings editor** `StudioSitterSettingsSection` (admin/manager, on SettingsPage
      next to Carnet) edits intro / notes prompt / lost-property prompt / checklist items (label, type,
      expected, end-of-booking flag, reorder, add/remove) + uploads/removes reference photos.
    - **Not-submitted accountability chaser: SHIPPED** (Slice 5, migration 173 — see below).
  - **Slice 4 follow-up SHIPPED (real Jotform port + why-boxes + photos + reply-email, migration 169):**
    two rounds of jon feedback after a live trial. Template model + submit shape changed:
    - **Real Jotform port (`203154178314046`), "flat + section label + per-item ref" model.** The first
      cut was an admitted guess; the DEFAULT_TEMPLATE in `services/studio-sitter-lockup.ts` now carries the
      30 real checklist items with an optional `section` label (rendered as group headers — "Upstairs" /
      "Downstairs") and an optional per-item `reference` (`{text?, photos: string[]}` = "what it should look
      like"). **"Front door locked" is the LAST item**; "Alarm set" removed. 3 `end_of_booking_only`
      deep-clean items (vacuum/bins, hired kit boxed, backline stored). **Migration 169** is a data-only
      re-seed of `studio_sitter_lockup_template` generated from the compiled DEFAULT_TEMPLATE so seed ==
      code fallback exactly (overwrites unconditionally — 168's seed was the guess). `LockupItem` gained
      `section` + `reference`; the global reference-photos block was REMOVED (photos are per-item now).
    - **Off-expected "why?" capture** — any yes/no answer that trips `computeExceptions` opens an inline
      "why?" text box + optional photos; stored on `report_answers.exception_notes[id] = {text, photos[]}`,
      surfaced in the finishing summary and highlighted (amber) in the staff read-only view.
    - **Photos throughout via multipart.** The portal submit is now `multipart/form-data` (multer `.any()`
      on `POST /shifts/:date/lockup`): a `payload` JSON part + `notes_photo` / `why_<id>` file parts, routed
      by fieldname, uploaded to R2 (`files/attachments/…`), stored as blob refs on the report. Notes field
      supports photos too. The Next.js route re-forwards multipart with the `Blob` duck-type pattern (never
      the `File` global). `getShiftReport` + `getLockupContext` presign every stored blob + external
      reference URL for read (`ReadPhoto {url, filename, content_type}`).
    - **Lost property pushes to the Holding module** (the earlier `/holding/lost-property` deep-link was a
      bug — that's a staff-only OP route a freelancer can't reach). New portal `POST /shifts/:date/lost-property`
      + `logShiftLostPropertyOP` → `logShiftLostProperty` creates a `held_items` row (`kind='lost_property'`,
      `status='stored'`, `owner_unknown=true`, `created_by=SYSTEM_USER_ID`) with description / found location /
      photos, from an inline capture form on the lockup page.
    - **Reply-to-sitter email (the other half of "not a dead-end").** The handover thread is date-scoped, so
      a staff reply the *next* sitter never sees vanished. `routes/interactions.ts` now fires
      `notifySitterOfStaffReply(shift_id, content, staffUserId)` after any staff post on a `shift_id` thread
      — resolves the report submitter, emails them via the new `studio_shift_reply` template (link to
      `/shift/:date`), resolves the staff author name via `users LEFT JOIN people`.
    - **Status shows "Completed" once submitted** — the shift's existing `closed` status surfaces as
      "Completed" on both the portal shift card + OP roster once `report_submitted_at` is set. Portal dashboard
      shift card gets a **"🔒 Lock up" quick action** (like "Start delivery"), gated to tonight + not-yet-completed.
      No sitter tap-to-confirm surface (dropped per jon — too many surfaces).
    - **Staff read-only view + settings** rewritten to match: `StudioLockupReport.tsx` groups by section,
      shows exception whys + their photos, notes with photos; `StudioSitterSettingsSection` gains per-item
      `section` input + a per-item `reference` editor (caption + photo upload/remove via `/files/upload`),
      global photos block removed.
  - **Slice 4 second feedback round SHIPPED (migration 172):** post-trial tweaks.
    - **`note_prompt` — always-on note box (`item_notes` channel).** A `LockupItem.note_prompt?: string`
      shows an optional note+photo box REGARDLESS of the yes/no answer (distinct from the off-expected
      "why?" box, which it replaces for that item). Seeded on **"clients paid"** ("how did they pay /
      what's outstanding") + **"kitchen replenished"** ("anything running low"). Stored in a new
      `report_answers.item_notes[id] = {text, photos[]}` map, kept only for template items that carry a
      `note_prompt`; the off-expected "why?" box stays `exception_notes`. Portal routes its photos as
      `item_<id>` multipart fields (alongside `why_<id>` / `notes_photo`). The thread summary surfaces
      note_prompt notes (even on an expected answer), and an exception on a note_prompt item falls back to
      its `item_notes` text. Staff read view + Settings editor (per-item "Always-ask note" input) both
      handle it.
    - **Lights moved to a final "Lights off & lock up" section** (all lights-off items + front door LAST) —
      do the substantive work first, sweep the lights on the way out.
    - **Reference photos: thumbnails + in-page lightbox.** Portal renders reference photos as lazy-loaded
      `grid-cols-3` thumbnails; tapping opens a full-screen `<img>` lightbox overlay (tap to close) INSTEAD
      of the old `<a href download>` (which just downloaded the presigned R2 object). Fixes both "slow to
      load" and "clicking downloads instead of enlarging". Server-side thumbnail generation still deferred
      (thumbnails are CSS-sized full images for now).
    - **Bigger section headers** on the portal + staff read view.
    - Migration 172 re-seeds the template from the updated `DEFAULT_TEMPLATE` (169/170 taken on main, 171 =
      first real port, 172 = this round). **Lost property already lands in the Holding module** as a
      `held_items` `kind='lost_property'` row (`logShiftLostProperty` → the `/holding/lost-property` list).
  - **Slice 4 third round SHIPPED (dedup + submit UX + reference downscale):**
    - **Re-submit dedup (server-authoritative).** `submitLockupReport` throws `LockupAlreadySubmittedError`
      (→ portal 409) when the shift is already submitted and the caller didn't pass `allow_resubmit`. The
      portal catches the 409 and shows a "already submitted at HH:MM — re-submit and overwrite?" confirm;
      confirming re-POSTs with `allow_resubmit=true`. Stops a stale tab left open between shifts from
      silently overwriting the report + re-spamming the office, while still allowing a deliberate amend.
    - **Confirm-on-unanswered.** Submitting with any visible item still blank flags "N items unanswered —
      tap again to submit anyway" (button becomes "Submit anyway (N left)"); a second tap proceeds. Any
      answer change re-arms the check. (Deliberately NO scroll-to-first-issue — the amber card highlight
      already marks them.)
    - **Reference photos downscaled at upload.** `StudioSitterSettingsSection.uploadItemPhoto` runs the
      shared `compressImage(file, 1400, 0.8)` before the R2 upload, so new reference photos land ~150-250KB
      instead of a raw ~3MB phone photo — the actual fix for "slow to load on 4G". Legacy/external seed
      photos (the Jotform URLs) are unaffected; re-upload via Settings to shrink them. True server-side
      thumbnail variants remain deferred (not needed once uploads are small).
  - **Slice 5 SHIPPED (handover carry-forward + not-submitted chaser, migration 173):**
    - **Recent-handover carry-forward (the day-1-doesn't-carry-to-day-2 fix).** The per-night thread
      anchor (`shift_id`) is kept, but the portal shift page now surfaces the **last few nights' handover
      notes read-only** above tonight's composer — so a sitter arriving fresh sees prior context. Endpoint
      `GET /api/portal/studio-sitter/shifts/:date/recent-handover` (`routes/portal.ts`): premises-wide (one
      studio), most-recent-first, capped at 4 nights within a 21-day lookback, presigned files, access-gated
      like the thread. `getSitterRecentHandoverFromOP` + Next route `.../recent-handover/route.ts`; a
      collapsible "Recent handover · last N nights" section on `src/app/shift/[date]/page.tsx`. **Chosen over
      job-scoped / per-sitter threads** because the assignment unit is a SITE-EVENING (one sitter, whole
      building, can span two bands/jobs a night) — a premises-wide recent strip respects that and needs no
      data migration. Staff already see a job's full evening history on the Job Detail `StudioHandoverCard`,
      so no change needed there. The reply-to-sitter email stays for "someone replied to YOUR note".
    - **Not-submitted lock-up chaser (the deferred fast-follow, now shipped).** `runLockupChase()` (daily
      08:45 Europe/London in `scheduler.ts`): for any shift that closed without a lock-up report, reminds
      the rostered sitter (`studio_lockup_reminder` email — freelancers have no portal bell) + alerts the
      office (admins/managers bell + `studio_lockup_missing` info@ email). Once per shift, dedup on
      `studio_sitter_shifts.lockup_chase_sent_at` (migration 173, stamped FIRST so a send failure can't
      re-fire), only the last 7 days (no ancient-backlog spam), only shifts with an assigned sitter.
- **General Tasks system** (build with/after D): `tasks` table (anchor to shift/job/nothing),
  visibility everyone/assignee-only, notify-on-done + notify-if-not-done-after-X-days, **staff via
  bell/email, freelancers portal-only (no bell/email)**; dashboard top-right card + "On Today" +
  sitter portal; Today/Tomorrow/Upcoming/Overdue views.
- **Handover thread**: `interactions` anchored to `shift_id` — SHIPPED (Slice 3), with **recent-handover
  carry-forward** across nights added in Slice 5 (see above). The `IS NULL` scoping guard keeps it off
  other timelines.
- **End-of-day report** (Phase E): ✅ SHIPPED (migration 168) — see the **"Slice 4 SHIPPED"** bullet
  above. The not-submitted accountability chaser is now SHIPPED too (Slice 5, migration 173).
- **Calendar endpoint** (Phase F): `GET /api/studio-sitters/calendar?from&to` for the future
  calendar project (roster row shape already close).
- **Monday.com teardown (DONE, Jul 2026 — Monday fully retired):** the Monday machinery has been
  stripped from the freelancer portal (PRs #1036 + follow-up). Removed: `src/lib/monday.ts`, the
  `isOpMode` / `mondayFallbackAllowed` / `reportFallback` helpers + the `DATA_BACKEND` /
  `PORTAL_MONDAY_FALLBACK_ENABLED` / `PORTAL_TELEMETRY_SECRET` flags (`src/lib/op-api.ts`), the 3 Monday
  webhook routes, the 3 Monday file-asset routes (`files/[assetId]`/`asset-url`/`qh` — OP serves
  presigned urls now), the 2 orphaned Monday Netlify functions (`completion-background` /
  `completion-reminders` — superseded by `services/completion-chaser.ts`), the orphaned Monday-era libs
  `src/lib/email.ts` + `src/lib/pdf.ts`, the redundant Monday-Q&H `QHFiles` job-page component, and the
  **PIN-gated portal staff crew-transport calculator** (`src/app/staff/*` + `/api/staff/*` — the old
  Monday-backed transport cost calculator, fully superseded by the OP-native Crew & Transport calculator
  at `/operations/transport`). All portal routes are OP-only (auth / jobs / settings-notifications /
  resources / studio-sitter — the `if (!isOpMode())` guards are gone). The `DATA_BACKEND` /
  `PORTAL_MONDAY_FALLBACK_ENABLED` / `PORTAL_TELEMETRY_SECRET` / `STAFF_PIN` / `MONDAY_*` env vars on
  Netlify are now unused. **The portal (`src/`) has NO Monday API code left** — only a couple of
  historical comments, `'Monday'` weekday strings, and the `MONDAY_WEBHOOK_SECRET` env-var *name* kept as
  a shared-secret fallback in `api/hirehop/items/[jobId]` (rename with an env update if ever tidying).
- **Shop sales**: deferred, out of scope (substantial, cross-cutting).
- **Rehearsal job info beyond sitters (TODO — jon flagged Jul 2026):** the Rehearsals module
  should grow past studio-sitter cover to be the single place for everything about a studio job.
  Capture + surface, on an **expanded rehearsal card on the Job Detail view** (the natural home):
  what **PA setup** the band wants; whether they need **backline from us** and how much; how many
  **cars** the band is bringing (parking/space planning); any **lorry / truck / van drop-off or
  pickup** arrangements (who's dropping/collecting, when). Some of this is HH-derivable (backline
  line items already detected), some is free-form intake. Likely a mix of derived flags + a
  structured "studio job details" record (new columns or a `rehearsal_job_details` table) rendered
  as a richer rehearsal requirement/overview card. Scope + model this once the studio-sitter side
  (portal + tasks + end-of-day report) is wrapped. Keep it card-on-Job-Detail, not a new nav.

Headlines (design invariants — still apply):

- **Load-bearing model:** the assignment unit is a **SITE-EVENING**, not a job-room-day. One
  premises, **one sitter per evening** even if both rooms are busy — the sitter looks after the
  band(s) in Room 1/2 AND closes up the whole building (the end-of-day lock-up). So you assign a
  freelancer to a `studio_sitter_shift` (one per calendar evening), NOT to a job or a room. The
  per-job rehearsal card just *reflects* the shared shift's coverage + raises the amber warning.
- **Detection** (existing `has_rehearsal` path): classify room + flavour by `CATEGORY_ID===450 AND
  LIST_ID IN (...)`. EVENING (854/857) + LOCKOUT (851/855) ⇒ sitter needed; DAYTIME (853/856) ⇒
  not. Base room (834/835) is a nested child of the variant — informational, **don't double-count**;
  bare base room = `needs_review`. Daytime "not needed" can be manually overridden (a subtle
  "＋ Call a sitter" affordance → shift with `manual_override=true`) for short-staffed weekends.
- **Timing gotcha:** rehearsals do NOT run 9am→9am like vehicles/backline — they finish on the day
  they finish. HH's `job_end` carries the phantom 9am-next-morning rollover (Numan "10–16 Jul" is
  really 10am 10th → 10pm 15th), so the last session evening = `job_end_date − 1` when `job_end`
  time is an early-morning rollover. Sibling to the `return_date +1 buffer` gotcha. The SAME
  finish-on-the-day nature also broke the OP→HH charge-period push (rehearsals under-counted by a
  day because the push floored elapsed hours) — fixed Jul 2026 by ceiling, see the "Charge period =
  `ceil(elapsed_hours / 24)`" note under the "Create in HireHop" button in Stream A.
- **Tasks** (general ad-hoc/building jobs, built here but entity-general): visibility
  everyone/assignee-only, notify-on-done + notify-if-not-done-after-X-days, default notify the
  assignee — **staff via bell/email, freelancers portal-only (no bell/email)**. Staff input/surface
  on the dashboard top-right (NeedsAttention zone) + "On Today" + sitter portal; Today/Tomorrow/
  Upcoming/Overdue views.
- **Portal**, **handover thread** (interactions anchored to shift, scoped out of other timelines),
  **end-of-day report** (configurable in `system_settings`, ported from the Jotform, no PDF, notes
  → thread so staff can reply), **shared specs/files** via `share_with_freelancer`, lost-property /
  held-items via the Holding module. **Shop sales = deferred** (out of scope for now).
- **Build order / status:** staff-side (detection + roster/assign + dashboard/banner surfacing) is
  DONE (migration 153). Remaining = portal surface + tasks + handover thread + end-of-day report +
  calendar endpoint (see "What's left" above). New migrations: take the next free at build time
  (check `run.ts`).

##### Stream 6: Payment Tracking (pre-Xero)
*Merged into Step 3 (Money System).* `job_payments` table, per-job financial summary, payment recording, and client payment terms are all part of the unified Money tab on Job Detail. See Step 3 Phases C-F for full spec.

##### Stream 7: Transport & Crew Operations ← FOUNDATION COMPLETE
Global operational view for what's currently happening / about to happen with transport and crew.
**Full spec:** `docs/TRANSPORT-CREW-OPS-SPEC.md` — covers Monday.com board replacement, freelancer portal repointing, completion flow, and implementation plan.
- [x] Migration 024: ops_status, completion tracking, arranging details, run grouping, local delivery on quotes; freelancer confirmation, expense/invoice tracking on quote_assignments
- [x] Backend ops endpoints: PATCH ops-status, PUT ops-details, POST /quotes/local, PUT run-group, POST assignments/ooosh-crew, GET /quotes/ops/overview
- [x] Portal API route (`/api/portal/*`): auth/login, jobs list, job detail, equipment via HireHop broker, completion submission, venue detail
- [x] Cookie-parser middleware for portal session cookies
- [x] Transport operations page (`/operations/transport`): table view grouped by ops_status + calendar view, filter D&C/crewed, expandable rows, inline status dropdown
- [x] Local delivery/collection button + form on Job Detail Crew & Transport tab
- [x] Operations nav menu with "Crew & Transport" child
- [x] Operational status on quotes (`ops_status`: todo → arranging → arranged → dispatched → arrived → completed)
- [x] Completion tracking (signature, photos, notes, customer present toggle)
- [x] Arranging details (key points, client introductions, tolls/accommodation/flight booking status)
- [x] Freelancer portal repointing: feature-flagged DATA_BACKEND=op (auth, jobs, completion, equipment) with Monday.com fallback
- [x] **Freelancer portal go-live repointing (17 Apr 2026)** — see `docs/FREELANCER-PORTAL-REPOINTING.md`. Migration 052 adds portal_verification_codes + portal_password_reset_tokens + portal_fallback_events + completion_reminder_level. New OP endpoints: `/portal/auth/register/start|verify|complete`, `/portal/auth/forgot-password`, `/portal/auth/reset-password`, `/portal/telemetry/monday-fallback`, `/portal/jobs/:id/files`. Completion flow now uploads photos/signature to R2 under `completion/{quote_id}/`, generates delivery-note PDF (port of `src/lib/pdf.ts` → `backend/src/services/delivery-note-pdf.ts`), emails client + staff alert. Completion chaser scheduler every 30 min (2h/6h/14h + staff escalation). `freelancer_assignment` email now fires on new crew assignment + on draft→confirmed transition.
- [ ] **Portal shared files not reaching portal UI (known gap, 17 Apr 2026)** — Flag `share_with_freelancer` persists correctly on `jobs.files` + `venues.files`, and `/api/portal/jobs/:quoteId/files` returns both filtered correctly. The portal Next.js page (`src/app/job/[id]/page.tsx`) expects `venue.files` on the single-job response (Monday-era shape), but OP's `/api/portal/jobs/:quoteId` only exposes job-file `sharedFiles` — venue files are completely missing, and even the job ones are in the wrong shape for `VenueFiles` to render. Fix requires (a) OP single-job response: include `venue.files` + `job.files` filtered + shaped as `{ assetId|null, name, url, fileType }`, and serve content via either presigned R2 URLs or a portal-auth download proxy; (b) portal page: wire OP's shared files into existing `VenueFiles` component or add a dedicated "Job Files" section. Not yet scheduled.
- [x] **Portal reset-password "Invalid or expired link" fix (17 Apr 2026)** — `src/app/api/auth/verify-reset-token/route.ts` only checked the in-memory Monday-era Map. OP-issued tokens live in `portal_password_reset_tokens` so every verify returned `valid: false` → user saw "Invalid or expired link" and couldn't set a password. Added `GET /api/portal/auth/verify-reset-token` on OP + `verifyResetTokenOP()` helper + OP-mode branch in the Next.js route. Monday path preserved as fallback.
- [x] **Portal shared files fix (18 Apr 2026)** — resolves the 17 Apr gap above. OP's `/api/portal/jobs/:quoteId` response now includes `venue.files` and `job.files`, filtered by `share_with_freelancer=true`, shaped as `{ assetId:null, name, url, fileType }` matching the portal's existing `VenueFile` interface. R2 keys get 1h presigned URLs via new `getPresignedDownloadUrl()` helper in `backend/src/config/r2.ts` (added `@aws-sdk/s3-request-presigner` dep); external URLs pass through. Portal `src/app/job/[id]/page.tsx` reuses `VenueFiles` component with a new optional `title` prop — renders separate "Venue Files" and "Job Files" sections.
- [x] **Staff-shared portal account (18 Apr 2026)** — Migration 053 adds `is_portal_shared_account` on people; `info@oooshtours.co.uk` flagged true. Portal auth middleware re-reads the flag on every request (no re-mint needed). Jobs-list query widens for shared accounts to include every `is_ooosh_crew=true` assignment (`WHERE qa.person_id = $1 OR qa.is_ooosh_crew = true`) so local D&C / in-house runs show up in the shared inbox. Per-quote access checks also widened on job detail / equipment / completion / files endpoints. Accountability preserved via the existing `staffName` field on the completion form (shown whenever the logged-in email is `@oooshtours.co.uk`).
- [x] **PORTAL_MONDAY_FALLBACK_ENABLED env flag (18 Apr 2026)** — 10 portal routes (auth/jobs/completion) now gate their Monday fallback behind this env var. Default `true` keeps the silent safety net; setting `false` on Netlify makes failures return a clean 502 (or 401 for credential-rejected login) instead of serving Monday data. `mondayFallbackAllowed()` helper in `src/lib/op-api.ts`. Telemetry (`reportFallback`) still fires in every case so we can measure breakage before the flip.
- [x] **Non-UUID 404 guard on portal quote endpoints (18 Apr 2026)** — Stale portal state sometimes hands the 4 `:quoteId` routes a Monday item ID (11-digit int). Postgres's UUID cast threw, endpoint 500'd, portal silently fell back to Monday with a telemetry alert. Added shared `isUuidLike()` regex guard at the top of the 4 routes (job detail, equipment, complete, files) — legacy IDs now 404 cleanly without touching Postgres.
- [x] **Completion flow — equipment PDF + R2 photos + lightbox (18 Apr 2026)** — (a) Delivery-note PDF was rendering an empty equipment table because completion code called `/api/job_data.php` and read non-existent `DESCRIPTION`/`QUANTITY` fields; now uses `/frames/items_to_supply_list.php` with `title`/`qty` and filters kind:2 non-virtual items. (b) Completion photos + signature moved from base64-in-DB to R2 keys under `completion/{quoteId}/`, with legacy data-URL fallback if R2 is unavailable. `/api/files/download` allowlist extended to `completion/` + `delivery-notes/` prefixes. (c) TransportOpsPage `CompletionImageThumb` component fetches R2 keys authenticated and renders in a portal-rendered lightbox modal with a Download button (Escape + backdrop close). (d) Download filenames now `{hhJob}-{YYYY-MM-DD}-{1|signature}.{ext}` instead of raw UUIDs.
- [x] **Monday → OP data migration scripts (18 Apr 2026)** — `backend/src/scripts/migrate-monday-upcoming.ts` pulls upcoming items from the D&C + Crew Jobs boards and creates `quotes` + `quote_assignments` against existing OP jobs matched by HH number. Never creates new jobs. Idempotent on D&C via Monday tracking column `text_mm2krnzm` (`"yes"` = migrated, `"fail: <reason>"` = blocked). Flags: `--commit`, `--only-dc`, `--only-crew`, `--since YYYY-MM-DD`, `--refresh-venues` (backfills venue_id on already-migrated quotes). Items in D&C group `new_group` ("upcoming / to be arranged") bypass date + status filters and land as unassigned quotes. `backend/src/scripts/migrate-monday-venues.ts` pulls the Venues board (~464 venues), upserts into OP `venues` via external_id_map + name-match, stashes contact info (Contact 1/2, Phone 1/2, Email) into `general_notes` as a clearly-marked idempotent block, populates `default_miles_from_base` / `default_drive_time_mins` / `default_tolls_amount`. Migration 054 adds `default_tolls_amount` column. First live run: 196 upcoming items migrated (148 D&C assigned + 48 unassigned from the "to be arranged" group), 464 venues imported.
- [ ] **D&C venue connect-column parser broken (18 Apr 2026)** — the `--refresh-venues` pass reported `no Monday venue link: 155/155`, but Jon confirms every one of those items actually has its venue linked on Monday via the `connect_boards6` column. The JSON parsing in `migrate-monday-upcoming.ts` (both create-path and refresh-venues path) for `connect_boards6` isn't extracting `linkedPulseIds[0].linkedPulseId`. First task next session: dump one known-linked item's raw column value and fix the parser. Affects both migration of new items and the ~196 already-migrated "No venue" rows on Transport Ops.
- [x] Inline crew assignment on Transport Ops page (same picker as Job Detail, bidirectional)
- [x] Local D/C form improvements: venue address book lookup, smart date defaults, amber warning on change
- [x] **Freelancer notes portal visibility (Jul 2026, PR #966).** Two gaps hid `quotes.freelancer_notes` from freelancers — the notes were always saved and the portal API always returned them (as `keyNotes`, a Monday-era field name): (a) the portal's **crewed-job layout** (`CrewJobDetail` in `src/app/job/[id]/page.tsx`) never rendered the "📋 Key Notes" card the two D&C layouts (single + multi-stop) both had; (b) the **Local D/C form's** single "Notes" field saved to `internal_notes` (portal-invisible by design) — a straight local collection created with driver notes in that box showed the freelancer nothing. Now: crew layout renders the card, and the local form has TWO fields matching the calculator convention (Freelancer Notes → `freelancer_notes`, Internal Notes → `internal_notes`; `POST /quotes/local` accepts `freelancerNotes`). **Conventions:** any new portal job layout must render `job.keyNotes`; any new quote-creation surface with a notes box must be explicit about which of the two columns it writes (a bare "Notes" label reads as "the driver will see this" to staff). NB the `/start` wizard and dashboard cards deliberately don't show notes — the job detail page is the canonical surface. No backfill of historical local-form notes (intent can't be inferred); staff copy driver-relevant ones across via the Transport Ops inline edit.
- [x] Quote editing: Edit Quote modal on Transport Ops page + Job Detail page (venue, date, time, fees, notes)
- [x] Inline-editable arranging details: client intro status picker, key points, tolls/accom/flights clickable pills, notes
- [x] Run grouping UI: letter-based display (Run A/B/C), coloured side bands, join/create run buttons per job
- [x] Colour-matched status dropdown (replaces plain select)
- [x] Completion details view: photos, signature, timestamp, customer present, notes
- [x] Separate completed/cancelled toggles
- [x] Reminder system (unassigned deliveries approaching, overdue completions) — overdue-completion chaser live 17 Apr 2026 (every 30 min, 2h/6h/14h + staff escalation). **Arranging chaser** live for "Needs arranging" reminders on quotes still in `ops_status='todo'` as the job date nears: `services/arranging-chaser.ts`, ladder fires at 5/3/1 days out via `arranging_reminder_level` (idempotent — bumped before send, capped at 3). Business hours only (07:00-22:00 London). Gated on operational `pipeline_status` — never chases enquiries / provisional / lost / cancelled (May 2026 fix; mirrors the Crew & Transport page default).
- [x] Change notifications to freelancers (date/time/venue changes → email alert) — fires from `quotes.ts` PUT via `job_change_notification` template
- [ ] Issues on road reporting (breakdowns, delays, problems)
- [x] PDF delivery note generation (migrate from Netlify function to OP backend) — `backend/src/services/delivery-note-pdf.ts` (17 Apr 2026)
- [x] Client delivery note emails via OP email service — `delivery_note` template, fires on completion of `job_type = 'delivery'` quotes
- [x] **Last-mover auto-dispatch on portal completion (5 May 2026)** — when a freelancer marks the FINAL outstanding delivery quote on a job complete via the portal, OP flips `jobs.pipeline_status = 'dispatched'` + writes back HH status 5. Mirrors the warehouse module's auto-dispatch but at quote-aggregate level. Only fires for `job_type='delivery'` (collections + crewed bypass). Only fires when current `pipeline_status IN ('confirmed', 'prepped', 'prepping')` — never regresses a job past dispatch. Adding a new delivery later (e.g. mid-tour bass amp swap) won't un-dispatch: the pipeline_status whitelist + HH writeback's "skip if already at target" guard make this idempotent. Lives in `routes/portal.ts` completion handler's background IIFE; logs a `🚚 Job dispatched — final delivery completed by ...` interaction on the timeline with `created_by = SYSTEM_USER_ID`. Removes a chronically-forgotten manual step (was Monday, now OP).
- [ ] Invoice comparison (freelancer invoice vs expected cost, overcharge flagging) — nice-to-have, post go-live
- [ ] **Arrangement pills → dashboard integration**: Surface arrangement statuses on Dashboard and Job Requirements
  - [x] **Transport Introductions dashboard bucket (May 2026)** — quotes in next 7 days where `client_introduction IN ('todo', 'working_on_it')` AND linked job is `pipeline_status IN ('confirmed', 'prepping', 'prepped')`. Click-through to `/operations/transport?needs_intro=1`. See "Transport Introductions bucket + chase-date clearing" section under Dashboard for full detail.
  - Dashboard widget: "X jobs with outstanding tolls/accommodation/flights" (query `*_status = 'todo'` on active quotes)
  - Job Requirements integration: arrangement items auto-create as requirements on prep checklist
  - Freelancer portal: show arrangement status in job details (e.g. "accommodation: booked")
  - Notifications: auto-alert when job approaching and arrangements still outstanding
- [x] **Run group pricing (23 Apr 2026)**: Migration 062 promotes `run_groups` to a first-class table with `combined_freelancer_fee` + `combined_client_fee` + `notes` + `run_date`. `quotes.run_group` is now an FK with `ON DELETE SET NULL` = non-destructive ungroup. Individual `quotes.freelancer_fee` is never touched — grouping/ungrouping is purely metadata. Backend CRUD on `/api/quotes/runs` (POST create with quote_ids, PATCH fees, DELETE to ungroup, GET with standalone-total reference). Transport Ops expanded panel has inline combined-fee editors with placeholder showing the standalone sum. Job Detail "Crew & Transport" cards show a "🔗 Part of a run" badge + combined fee with the individual fee struck through. Legacy `quotes.run_group_fee` kept for now, unused by new code.
- [x] **Run group → freelancer portal alignment (23 Apr 2026)**: Portal's `/api/jobs/route.ts` `groupJobs()` prefers `runCombinedFreelancerFee` over summing `driverPay` when set, exposes `hasCombinedFee` + `standaloneTotalFee` + `runNotes` on the grouped run payload. Portal Next.js dashboard card shows combined fee with standalone struck through + "combined run fee" label. `/api/jobs/run` has an OP mode that filters by run_group UUID + date, fetches venue details via `getJobDetailFromOP`, returns combined fee + standalone total. Job detail page shows combined fee prominently with standalone reference. Monday path preserved behind `PORTAL_MONDAY_FALLBACK_ENABLED` for the transition window.
- [x] **Freelancer book-out token repoint (23 Apr 2026, foundation)**: Portal's `/api/jobs/:id/bookout-token` now mints an HMAC token in OP format (`{expiry}.op.{quoteId}.{email}.{sig}`) and redirects to OP's `/vehicles/book-out` when `DATA_BACKEND=op`. OP exposes `POST /api/vehicles/freelancer-bookout/resolve` (public, HMAC-authenticated) which verifies the token, confirms the freelancer is on a `quote_assignments` row for the quote, locates the staff-allocated `vehicle_hire_assignments` row, and mints a narrow-scoped `freelancer_bookout` session JWT (4h TTL, scoped to one assignment). New middleware `authenticateFreelancerBookout` validates that JWT on protected routes. The embedded VM's existing `exchangeFreelancerToken` (in `useAuth.tsx`) was repointed from the legacy `/validate-freelancer-token` Netlify function to the new OP endpoint; returns `hhJobNumber` as `jobId` so downstream `BookOutPage` flow (which expects an integer) keeps working. Monday `VEHICLE_APP_URL` redirect preserved behind `PORTAL_MONDAY_FALLBACK_ENABLED` for the transition window.
  **Known gap — D&C allocation-to-freelancer linkage:** The resolve endpoint's assignment lookup is permissive (matches by `drivers.person_id` OR any NULL-driver D&C assignment on the job). D&C freelancers don't usually have a `drivers` row, and `vehicle_hire_assignments` was designed for client self-drive hires. A proper freelancer→vehicle linkage (so the resolve picks the right van when multiple D&C allocations exist on a job) still needs firming up. For single-allocation D&C jobs the current logic works; for multi-crew runs it may need refinement.
- [x] **Freelancer book-out Round 4 — hire-form integration + smart resolve + email fallback (30 Apr 2026):**
  - **Smart resolve** in `POST /api/vehicles/freelancer-bookout/resolve`: a D&C self-drive job typically lands two `vehicle_hire_assignments` rows on arrival — Row A from the staff Allocations page (`vehicle_id` set, `driver_id` NULL, "this van's going to this delivery"), and Row B from `POST /api/hire-forms` when the customer signs (`driver_id` set, `vehicle_id` NULL, "this is who'll drive once it lands"). They're the same logical hire and need merging before book-out so the condition PDF carries the customer name and the post-book-out hire-agreement PDF chain can fire. The resolve endpoint now atomically (a) copies `vehicle_id` from Row A onto Row B, (b) cancels Row A with an `[Auto-merged] …` audit note in `notes`, (c) mints the freelancer's session against Row B (the merged row). Idempotent — second call finds the merged row directly and returns it. Replaces the manual SQL we hand-ran for jobs 15378 / 15793 / 15819 / 15820. Multi-van scope deferred (covered by the D&C allocation linkage gap above) — for now the merge picks one allocation × one customer (lowest `van_requirement_index`) per resolve and leaves siblings alone.
  - **Hire-forms routes accept freelancer JWT.** `GET /api/hire-forms/by-job/:hirehopJobId`, `PATCH /api/hire-forms/:id`, and `POST /api/hire-forms/:id/generate-pdf` swapped from `authenticate` (staff-only) to `authenticateVehicleFlexible` (staff OR freelancer-bookout session). Each handler checks `isFreelancerBookout(req)`, looks up `getBookoutScope(req)`, and confirms the target hire form sits on the freelancer's own job (`scope.jobId` or `scope.hhJobNumber` match). Without these, the freelancer's `BookOutPage` couldn't load the customer's hire form to populate the condition PDF, write back vehicle reg + status='booked_out', or trigger the auto-PDF chain.
  - **`getBookoutScope` extracted.** Moved out of `routes/vehicles.ts` into `middleware/freelancer-bookout-auth.ts` so the hire-forms routes can import it. Same shape, also returns `jobId` now.
  - **Freelancer PATCH whitelist (silent-strip).** `PATCH /api/hire-forms/:id` clamps freelancer payloads to `{vehicle_id, hire_end, start_time, end_time, return_overnight, status, ve103b_ref}` — anything else (notes, client_email) gets dropped silently rather than 403'd. `vehicle_id` is also clamped to `scope.vehicleId` (if a freelancer's client tries to send a different one we override + warn). `status` is locked to `'booked_out'`. Empty post-strip payloads return 200 idempotent rather than 400 — Round 4 design rule per jon: never block a freelancer mid-handover with a "you can't change that" error. If the writeback's `updateDriverHireForm` ever ships a new field, the silent-strip is the safety net while the whitelist catches up.
  - **Frontend re-enables hire forms in freelancer mode.** `BookOutPage`'s `useDriverHireForms({ enabled: !isFreelancer })` guard is gone — freelancers now load the customer's hire form, see the customer's name + email pre-filled on the Driver & Hire step, and the writeback loop fires for every customer hire form on the job (multi-driver-on-one-van case). A new `canAdvance` branch blocks the Driver & Hire step in freelancer mode unless at least one customer hire form exists, with copy "Customer hire form not received yet — please contact the Ooosh office before continuing." Cross-job driver fallback is hidden in freelancer mode (irrelevant + their session is scoped). The post-book-out hire-agreement PDF chain happens server-side via the existing `setImmediate` in the PATCH handler — no frontend change needed.
  - **Email fallback wired into 2 endpoints.** `POST /api/vehicles/send-email` (condition report) and `POST /api/hire-forms/:id/generate-pdf?send_email=true` (hire agreement PDF) now route through `resolveClientEmailTarget` when no driver/customer email is on file. Recipient chain: hire-form driver email → job-level client contacts → `info@oooshtours.co.uk` with amber "no client email on file" banner + `email`-type interaction logged on the job timeline. Frontend (`sendConditionReportEmail`) now passes `to` as nullable + always includes `hireHopJob` so the backend has the lookup key for the fallback. Stops condition reports being silently dropped on HH-synced sole-trader jobs (e.g. RX22SWU class incidents) and aligns the freelancer flow with the existing `money-emails.ts` safety net.
  - **Tidy.** `GET /get-checklist-settings` and `GET /get-events` added to `FREELANCER_BOOKOUT_ALLOW`. `/get-events` gains a scope check that clamps the query to the session's allocated reg (no fleet-wide enumeration). Kills the 403 console noise the freelancer was hitting on every walkaround load.
  - **Still TODO (Round 6+):** Vehicle swap mid-hire (Phase D3 — UI; soft check-in primitive shipped May 2026, see `docs/VAN-SWAP-AND-SOFT-CHECKIN-SPEC.md`). Multi-van D&C (drivers × vans expansion of the resolve merge).

- [x] **Freelancer Vehicle Flow — Round 5 (collection flow + leg-based completion + hardening, Jul 2026).** Spec: `docs/FREELANCER-VEHICLE-FLOW-SPEC.md`. Four merged PRs (#918, #920, #922, #923) + a robustness tail, driven by two live incidents on 2 Jul: **Tobi** (HH 15669 — freelancer book-out didn't email the hire agreement) and **Lewis** (HH 15933 — freelancer collecting a van was mis-routed through book-out and stranded).
  - **Task 0 — hire agreement misfire (#918, migration 155).** A freelancer book-out fires `POST /api/vehicles/save-event` ONLY; it never ran the `PATCH /api/hire-forms/:id → booked_out` loop that is the *sole* place `generateAndEmailHireFormPdf` is scheduled — so no driver got their agreement (`hire_form_emailed_at` stayed NULL). Fix: the `save-event` book-out branch now fires `firePostBookOutHooks` (exported from `hire-forms.ts`) for each flipped assignment with a van — cascading the own-van agreement + `fanOutVanHireForms` to every other driver ("everyone drives everything", jon's decision (a)). Staff PATCH path still fires the same hooks; the double-fire is made safe by an **atomic claim** (`vehicle_hire_assignments.hire_form_email_claimed_at`) inside `generateAndEmailHireFormPdf` — a conditional UPDATE claims the send before the PDF+email, releases it on any non-success exit (so retries re-claim, concurrent duplicates skip). `generateAndEmailHireFormPdf` now THROWS on email-send failure so `runHookWithRecovery` retries + alerts instead of silently dropping.
  - **Step 1 — leg-based completion (#920, migration 156).** A van-only delivery quote used to close only when the freelancer's browser returned across the OP↔portal domain to `/complete`; when it didn't (Tobi), the quote sat open and the completion chaser nagged all night. New model: the `/start` wizard DECLARES which legs a job has (`quotes.requires_van_leg` / `requires_equipment_leg`), each leg stamps `van_leg_done_at` / `equipment_leg_done_at` server-side as it happens, and **`services/quote-completion.ts` `maybeCloseQuote()`** closes the quote when the last required leg lands — independent of browser navigation. It owns the last-mover auto-dispatch (moved out of the portal `/complete` handler). Legacy undeclared quotes preserve old behaviour (equipment `/complete` closes them; a van book-out doesn't). A physically-out van on the job satisfies the van leg as a belt-and-braces (staff-desk book-out that never stamped). The completion chaser already gates on `ops_status NOT IN (completed,cancelled)`, so closing the quote stops the nag for free. **Any new leg-completion path MUST call `maybeCloseQuote`.** Portal: `/start` persists legs via `POST /api/portal/jobs/:quoteId/legs` (best-effort, non-blocking).
  - **Step 2 — linkage hardening + dead-end fallback (#922).** The resolve endpoints required the login email's `people` row to equal `quote_assignments.person_id`; freelancers accumulate duplicate people records / multiple emails (Lewis logged in as `hoadleyguitartech@live.com`, the crew row pointed elsewhere) → strict match 403'd a legitimate crew member. Extracted **`authoriseFreelancerOnQuote()`** (shared by both resolvers): resolve the job from the QUOTE (all crew share it), then authorise against the quote's crew by **id → email → unique-name**. The HMAC token is the auth; name-widening only picks WHICH crew row. Frontend: reusable **`FreelancerLinkError`** friendly screen (reason + Try again + Back to portal + office number) — the freelancer shells render it on any resolve failure instead of a blank/login dead-end.
  - **Steps 3-5 — collection flow (#923, migration 158).** A collection is a check-in, not a book-out. `CollectionPage` already existed (freelancer-aware) but had no public entry and its `/save-collection` / `/get-collection` backend endpoints didn't exist. Added: **`POST /api/vehicles/freelancer-checkin/resolve`** (mirror of book-out; targets the van currently OUT on the job; mints a `mode:'checkin'` session — same HMAC token format, distinguished by ENDPOINT not a discriminator). Session gained `mode: 'bookout' | 'checkin'`. The `save-event` freelancer gate is now mode-aware — a checkin session may fire ONLY soft/interim check-in events (never a full `check-in` that flips to `returned`; the warehouse owns the final check-in). The `save-event` soft-check-in branch now matches `interim-check-in` (what CollectionPage fires) and, for a checkin session, stamps `vehicle_hire_assignments.soft_checked_in_at` (marks "collected, awaiting warehouse final check-in", NO status flip) + closes the collection quote's van leg via `maybeCloseQuote`. `/save-collection` + `/get-collection` R2 endpoints added (pre-fill the staff final check-in). OP frontend: `FreelancerCheckinShell` + a public `CheckInEntry` route at `/vehicles/check-in` (mirror of `BookOutEntry`) → renders `CollectionPage` in freelancer mode via the existing session→`useAuth` bridge; CollectionPage's staff-only data hooks gated off for freelancers. Portal: `checkin-token` route + `/start` routes collection jobs through it. Both shells route through `FreelancerLinkError`.
  - **Robustness tail (§7.3-7.5, migration 159).** §7.3 "started but not completed" alert: both resolvers stamp `quotes.van_leg_started_at`; **`runFreelancerLegStalledScan`** (in `sanity-check-scanner.ts`, wired into the 15-min sanity cron) alerts info@ ONCE per quote (deduped via `van_leg_alert_sent_at`, business hours only, 3h grace) when a started van leg never completes — so staff learn before the client chases. info@-only, matching the sibling scanners. §7.4: `fetchWithTimeout` (AbortController) on the portal's POST paths (`opFetch`, login, completion=60s, register/reset) so a hung OP surfaces "try again" instead of an indefinite spinner. §7.5: reset-password page auto-redirects to `/dashboard` once the reset logs the freelancer in (stops the Lewis double-reset loop).
  - **Conventions worth remembering:** (a) `save-event` is a source of truth for book-out — it drives the hire-forms cascade, not just the vehicle side. (b) The own-van agreement email is serialised by the atomic claim; the cross-van fan-out by the `hire_form_documents` UNIQUE. (c) A freelancer collection is a SOFT check-in — `soft_checked_in_at` stamped, `status` NOT flipped to `returned` (enforced server-side: a checkin session can't fire a returning event). (d) The book-out and check-in tokens share ONE HMAC format; the resolve ENDPOINT sets the session `mode`. (e) Any new leg-completion path calls `maybeCloseQuote`. (f) The two freelancer entrypoints are `/vehicles/book-out` (`BookOutEntry` → `FreelancerBookoutShell` → `BookOutPage`) and `/vehicles/check-in` (`CheckInEntry` → `FreelancerCheckinShell` → `CollectionPage`); both decide freelancer-vs-staff on `?freelancerToken=` / an active freelancer session.
  - **Still TODO (deferred):** freelancer-led interim check-in for the van-swap case (reuses the same soft check-in primitive); multi-van D&C (drivers × vans). CollectionPage's full walkaround UI (photos, PDF recipients) wants a live collection to shake out — the critical lifecycle path is verified but was never exercised end-to-end before this round.
  - **First live collection shakeout (13 Jul 2026, Jack Looker / HH 15669):** caught exactly the class of gap the round-5 caveat predicted. The checkin resolve + session + auth all worked, but `CollectionPage` never READ the vehicle from the freelancer session — its only vehicle-selection path was the `useAllocations` auto-select effect, which is deliberately gated off for freelancers, so `form.vehicleId` stayed null and the freelancer sat on the amber "Waiting for vehicle allocation…" box forever despite the van being booked out and in `freelancerContext`. Fixed by porting BookOutPage's freelancer pre-fill effect (seed `vehicleId`/`vehicleReg`/`hireHopJob`/`driverName` from `freelancerContext` once the vehicles list loads; driver = `customerDriverName` fallback freelancer's own name, editable). **Convention: any vehicle-module page that runs in freelancer mode MUST seed its form from `freelancerContext`** — the staff data hooks (`useAllocations`, `useDriverHireForms`, `useVehicleIssues`) are 403-gated for freelancer sessions, so gating a hook off without adding the context pre-fill silently strands the flow. The walkaround remainder (photos, PDF recipients) is still not live-proven — watch the next real collection past Step 1.

##### Carnets ✅ COMPLETE (Jun 2026) — see `docs/CARNET-SPEC.md`
Full ATA Carnet module replacing the Monday board + Jotform request form. Dedicated `job_carnets` + `carnet_gmrs` tables (NOT just a requirement card — promoted to a module like job_issues/storage because of the GMR children, custody chain, client form + signed authority, and document storage). Two modes on one record: `we_supply` (HH-detected via sale item **575** "Arrangement fee - provision of ATA Carnet", £750 — mirrors VE103B detection exactly) and `client_arranges` (manual lightweight "thing to do"). Per-job scope. Money stays in HireHop (item 575 → Money tab). GMRs tracked requested → made → sent, with number + uploaded QR image for forwarding to clients.
- [x] **Slice 1 (migration 135 + HH detection):** `job_carnets` + `carnet_gmrs` tables; derivation engine detects item 575 → auto-creates `carnet` requirement card + `job_carnets` (we_supply/detected); read-only `/api/carnets`. Stale-cleanup wired (`carnet` added to DETECTABLE_TYPES, + untouched `job_carnets` rows self-delete when no longer detected). **Detection MUST match `LIST_ID === 575 AND CATEGORY_ID === 355` (Misc Sale)** — HireHop's asset & sale-item stock-ID spaces are separate, so a rental asset can also be stock 575; LIST_ID alone false-fired the carnet on jobs 16142/16007/15828 (Jun 2026). Same latent risk applies to VE103B (item 1023) — left as-is for now since no collision reported.
- [x] **Slice 3 (staff backend + cockpit component):** backend write endpoints on `/api/carnets` (POST create, PATCH with status→custody/timestamp side-effects + timeline interaction, cancel, GMR CRUD, files JSONB). `CarnetSection` rich cockpit built (lifecycle stepper, custody, detail edit, GMR mgmt incl. QR upload, documents, soft cancel). **Job View keeps only the thin `carnet` requirement-card tracker** — the rich card was briefly on Job Detail then pulled (too heavy + duplicated the tracker). `CarnetSection` retained unmounted, reused for the Operations tab.
- [x] **Slice 4 (auto-send + email routing):** `services/carnet-auto-email.ts` (daily 09:15) — initial send at T-28 days of needed-by on confirmed jobs (mints token + emails the form), chase at T-14 if not back (`form_reminder_sent_at` dedup); gated on lost/cancelled + internal. New **`carnet` email-routing bucket** (`carnet_request`/`carnet_request_chase` mapped) so the Job-View "who gets emails" picker controls the carnet send.
- [x] **Slice 5 (Operations tab + cohesion):** `/operations/carnets` list page + dedicated `/operations/carnets/:id` detail page (one carnet per page — `CarnetDetailPage` renders the rich `CarnetSection` cockpit; list rows + the Job-View link both navigate there) + Operations nav. Job-View `carnet` requirement card is now a read-only reflection — generic dropdown + 6-step bar suppressed, replaced by a live lifecycle stepper + "Manage carnet in Operations →" link (deep-links to the carnet's detail page). `syncCarnetRequirementStatus` maps `job_carnets.status → carnet` requirement status on PATCH/cancel (keeps the prep counter honest). Overview + detail surface **Needed by** (`COALESCE(carnet_start_date, out_date, job_date)`) + **Return by** (`carnet_expiry_date + 7 days` — discharge deadline = 7 days after validity ends, we_supply only; NOT the job end date) with colour-coded countdowns (`CarnetCountdown`).
- [x] **Slice 2 — Letter of Authorisation PDF + signature + public client form:** `services/carnet-authority-pdf.ts` (pdf-lib, two-signature letter; logo via `fetchLogo`; Ooosh signature + name/role/address from `system_settings` category `carnets`, migration 141). `POST /:id/generate-authority` (staff, on-demand). **Settings → Carnet** (`CarnetSettingsSection`) uploads the signature (→ R2, key into `carnet_ooosh_signature_url`) + edits signatory details. **Public client request form** (`CarnetFormPage` at `/carnet-form/:token`, no Layout — port of the Jotform: length/start/EU+non-EU countries/lead+additional names/GMR crossings/T&Cs/signature pad): public `GET /carnets/form/:token` + `POST /carnets/form/:token/submit` (before the auth gate) — on submit stores fields, computes expiry+18mo liability, seeds GMRs from crossings, flips to `info_received`, generates the final two-signature PDF (client sig + Ooosh sig), emails the signed copy to the client + `info@`. Staff `POST /:id/send-form` mints the token + "Send request form to client" / "Copy form link" on the cockpit. Templates: `carnet_request`, `carnet_request_chase`, `carnet_authority_copy`, `carnet_authority_received_internal`.
- [x] **Final polish (Jun 2026):** client form — all fields required (front+back), start date defaults to the job's outgoing date, must scroll the terms before accepting. Cockpit + Job-View card — **letter-of-authority tracking** ("✓ Received" = `form_submitted_at` set, i.e. client signed via the form), **soft gate** (advancing to `applied`+ without a signed authority pops an amber "OK to continue?" confirm — warning, not a block), **phase-coloured stepper** (`STEP_PHASE` in `CarnetSection`, shared with `RequirementCard`). Manual `client_arranges` create on `/operations/carnets` (job-search modal). Dashboard **"Carnets" NeedsAttention bucket** (amber, secondary row): we_supply open carnets approaching/overdue + not obtained, out-with-client past discharge deadline, or returned-not-discharged.

**Conventions worth remembering:**
- **Detection** must match `LIST_ID === 575 AND CATEGORY_ID === 355` (asset/sale stock-ID namespaces overlap — see Slice 1).
- **"We have the letter of authority"** = `job_carnets.form_submitted_at` is set (client signed). A staff-generated draft via `/generate-authority` sets `signed_authority_url` but is NOT the same as a received authority — the soft gate keys off `form_submitted_at`.
- **Email routing:** carnet client emails go through `resolveClientEmailTarget(jobId, 'carnet_request')` → the `carnet` bucket in `email-routing.ts`. Any new carnet client template should be mapped to that bucket so the Job-View picker controls it.
- **Return-by** = `carnet_expiry_date + 7 days` (discharge deadline), NOT the job end date. **Needed-by** = `COALESCE(carnet_start_date, out_date, job_date)`.
- **GMR forward-to-client:** `POST /api/carnets/:id/gmrs/:gmrId/email` (`carnet_gmr_details` template) emails the GMR number + attaches the QR image (from R2) then marks the GMR sent. Recipient = carnet `lead_email`, else `resolveClientEmailTarget(jobId)`. "✉ Email to client" per-GMR button on the cockpit.
- **Instant on-confirmation send:** `triggerCarnetFormOnConfirmation(jobId)` (confirmation-hooks.ts) fires from the same 3 confirmation entry points as the hire-form hook (pipeline.ts, money.ts, webhooks.ts) — sends the request form immediately if a we-supply carnet is `detected` within 28 days (derives once if the 30-min sync hasn't created the record yet). Shares `sendCarnetFormForJob` with the daily scheduler; the `form_sent_at` gate makes the two paths idempotent.
- Lifecycle (we_supply): detected → form_sent → info_received → applied → received → with_client → returned → discharged → closed. `format='digital'` carnets skip physical custody/discharge steps. Warnings-not-gates throughout.

**Parallelisation notes:** Streams 2-7 can all run simultaneously — they touch different tables, routes, and pages. Stream 1 + the HH-Derived Requirements Engine are the foundation and should complete first, as all other streams plug into it.

##### HH-Derived Requirements Engine ← NEW (Apr 2026)

**Core concept:** HireHop is the source of truth for *what's on a job*. The OP reads HH line items and automatically derives operational requirements — what prep is needed, what configuration changes are required, what workflows to trigger. This eliminates the "same thing twice in two places" problem and ensures OP stays in sync when HH changes.

**Proven via API testing (9 Apr 2026):** The `items_to_supply_list.php` endpoint returns all items on a job including:
- Standard items (`kind: 2`) with category, stock ID, quantity
- **Selected prompt items (`kind: 3`)** — only the chosen option appears (e.g. if "forward-facing" is selected, only that prompt shows; "round a table" is absent)
- **Custom fields** including `TYPE_CUSTOM_FIELDS.preptimemins` — prep time in minutes per item (same figure for de-prep)
- Parent-child relationships via `LFT`/`RGT` nested set values and `▶` prefix on parent items
- `AUTOPULL` as stable identifier for prompt options (e.g. 2822 = round-a-table, 2823 = forward-facing for rear seats)

**Three-tier detection model:**

| Tier | Detection Method | Examples |
|---|---|---|
| **Category check** | Items in specific HH categories | Backline (backline cat), Rehearsal (cat 450), Vehicle (cat 370), Vehicle accessories (cat 371) |
| **Category + keyword** | Category match + item name parsing | "Premium LWB" → Premium van, "manual gearbox" / "auto gearbox" → transmission type |
| **Prompt parsing** | `kind:3` selected prompts under parent items | Seat configuration (AUTOPULL 2822/2823), other accessory options |

**HH-derived requirement types:**

| Requirement | HH Signal | Detection | OP Action |
|---|---|---|---|
| **Vehicle (Self-Drive)** | Item in category 370 (Vehicles) | Category check | Auto-create vehicle requirement. Default is self-drive; "Van & Driver" button overrides (flips off hire-forms/excess chain) |
| **Seat configuration** | `kind:3` child of "Rear seats:" parent (LIST_ID 1645) | Prompt parse + AUTOPULL ID | Flag on prep checklist. Cross-ref `fleet_vehicles.seat_layout` to show which vans need turning |
| **Backline** | Items in backline category | Category check | Auto-create backline requirement with item list + prep time |
| **Rehearsal** | Items in category 450 | Category check | Auto-create rehearsal requirement |
| **Hire forms** | Derived: self-drive vehicle detected (no "van & driver" override) | Chained from vehicle | Auto-create hire forms requirement |
| **Insurance excess** | Derived: hire forms requirement exists | Chained from hire forms | Auto-create excess requirement |
| **Carnet** | International venue + equipment on job | Venue location + items exist | Auto-create carnet requirement (multi-step workflow in OP) |
| **Prep time totals** | `TYPE_CUSTOM_FIELDS.preptimemins` summed across all items | Custom field read | Dashboard: "4 vehicles need prepping today, est. 5 hours". Split by category (vehicles, backline, rehearsals). Same figure for de-prep |

**Sanity-check flags (OP is source of truth, HH used for cross-check):**

| Check | Logic | Surface |
|---|---|---|
| **Crew mismatch** | `kind:4` crew items on HH but no crew quote in OP (or vice versa) | Amber warning on prep checklist |
| **Transport mismatch** | Delivery quote in OP but no corresponding HH item (or vice versa) | Amber warning: "delivery quote exists but not on HH" / "delivery on HH but no OP quote" |
| **Van & driver vs self-drive** | Van + crew detected but marked as self-drive (or vice versa) | Edge case flag |
| **HH changed after action** | HH line items changed since staff marked requirement as "done" | Warning: "HH has changed since you marked this done" — does NOT overwrite status |

**OP-only requirement types (no HH equivalent):**

| Type | Notes |
|---|---|
| Incoming deliveries / merch receiving | Client sends stuff — nothing in HH |
| Lost property | Post-hire discovery |
| Sub-hire | Migrated fully to OP (HH PO/shortage method too clumsy for custom items) |
| On-road issues | Real-time operational — breakdowns, delays |
| Post-hire problems | Damage, missing items — after HH lifecycle |
| General tasks / reminders | Not job-specific |
| Custom requirements | Free-text, user-defined |

**Removed requirement types (were speculative, not needed):**
- ~~Stage Plot / Tech Spec~~ — lives in job files if needed
- ~~Special Permits~~ — not part of day-to-day process

**Sync triggers:**
1. **Background sync** (every 30 min) — existing job sync, now also processes line items for requirement derivation
2. **Webhook** — `job.updated` webhook from HH triggers immediate line item re-fetch for that job
3. **On-demand** — "Sync now" button on Job Detail page, fetches fresh items from HH
4. **Auto on page load** — navigating to Job Detail triggers background item refresh (non-blocking, updates reactively when data arrives)

**Requirement lifecycle with HH sync:**
1. HH item detected → OP auto-creates requirement with `is_auto: true`, `source: 'hirehop_sync'`
2. Staff works the requirement (changes status, adds notes, marks done)
3. Next sync: if HH items unchanged, requirement untouched. If HH items changed, flag mismatch for staff review
4. If HH item removed: requirement flagged "HH item removed — review needed" (not silently deleted, in case staff already did prep work)

**Vehicle seat configuration — end-to-end example:**
1. Sales adds Premium Van to job in HH, selects "Rear seats all forward-facing" prompt
2. Sync detects: category 370 item + `kind:3` "forward-facing" prompt (AUTOPULL 2823)
3. OP auto-creates vehicle requirement + sets `seat_config: 'forward_facing'`
4. OP cross-refs `fleet_vehicles` WHERE `simple_type = 'Premium'` AND `is_active = true`: checks `seat_layout` field on each
5. Prep checklist shows: "Seats: Forward-facing. GX17DHN already forward-facing, others need turning"
6. Client changes mind → sales updates HH prompt to "round a table"
7. Next sync: OP detects change, updates requirement, flags if staff already prepped

**Fleet vehicle seat tracking:**
- New field `seat_layout` on `fleet_vehicles` table: `'round_table'` | `'forward_facing'`
- Populated via vehicle prep forms — by the time each van has been prepped once in OP, we'll have the data
- Displayed on vehicle detail page (quick reference for van team)
- Cross-referenced during job prep to identify which vans need seat changes

**Van & Driver toggle:**
- Default assumption: self-drive (most common case)
- "Van & Driver" button on Job Detail / Drivers & Vehicles tab — overrides self-drive assumption
- When toggled: hire forms + excess requirements are NOT auto-created
- Persisted on job or quote level

**Requirement type redesign (Apr 2026):**

The Prep Checklist merges HH-derived detection with OP workflow tracking. Each requirement card shows HH context inline — no separate "Detected from HireHop" panel needed long-term.

| Type | Source | Steps | Card content |
|---|---|---|---|
| **vehicle** | HH-derived (cat 370) | Not started → Prepping → Prepped → De-prepped | Van type, count, prep time (from `preptimemins`), seat config + fleet availability. Nested: hire_forms + excess chain for self-drive |
| **hire_forms** | Derived from vehicle (self-drive) | Not started → Sent → Signed → Complete | Auto-email 10 days before hire start (or on confirmation if <10 days). Reminder at 5 days if no response. On-demand email to choosable contacts. Hire form URL construction. Shows which drivers have submitted |
| **excess** | Derived from hire_forms | Needed → Taken → Held → Resolved | Links to Money tab. Shows if excess already held for client/driver. Top-N-drivers calculation |
| **transport** | OP-only (from quotes) | Mirrors ops_status from Crew & Transport tab | Overview card shows quote summary + progress. No duplicate steps — reads from quotes.ops_status |
| **crew** | Sanity flag (HH kind:4 vs OP) | N/A — flag only | Amber warning if crew on HH but no OP quote, or vice versa |
| **backline** | HH-derived (cats 372-410) | Not started → Working on → Finished | Item count + prep/de-prep time from `preptimemins` |
| **rehearsal** | HH-derived (cat 450) | Detected → Booked → Sitter assigned → Setup complete | Prep time from `preptimemins` |
| **carnet** | HH-derived (international + equipment) | Applied → Received → Items listed → Stamped out → Returned → Closed | Multi-step workflow, OP-managed |
| **merch** | OP-only | Request sent → Some received → All received → Notified → Given to client | Incoming deliveries from bands/clients |
| **sub_hire** | OP-only | Need identified → Sourcing → Ordered → Received → Returned | OP-only, HH PO method too clumsy |
| **custom** | Manual | N/A | Free-text one-offs |

**Removed types:** accommodation (→ arranging details pills), permits, stage_plot (→ files)

**Hire form auto-email logic:**
- 10 days before `job_date`: send hire form email to client contacts (self-drive jobs only)
- If confirmed with <10 days to go: send on confirmation
- 5 days before `job_date` (or 4 days if last sent <24h ago): reminder email if no forms received
- On-demand: "Send hire form" button on requirement card with contact picker
- Hire form URL constructed from job data + driver verification flow

**Vehicle requirement card layout (target):**
```
🚐 Vehicle (Self-Drive)                    [Status: Not started ▾]
   1x Premium LWB (M) — manual gearbox
   ⬆️ Forward-facing seats
   Est. prep: 1h 15m
   Fleet: 3 Premium available (GX17DHN forward-facing, 2 others need turning)
   ────────────────────
   ↳ 📋 Hire forms: Not started    [Send ✉]
   ↳ 💰 Excess: Needed
```

**Fleet availability:** Mirrors existing vehicle module allocation logic (what's available vs what's on the job). Read from same source to avoid duplicate API calls.
