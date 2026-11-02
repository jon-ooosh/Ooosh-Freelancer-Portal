<!--
Extracted verbatim from the root CLAUDE.md (Sep 2026 restructure).
CLAUDE.md was ~757KB / 5,746 lines and was consuming most of every session's
context window before a single turn of work. It now carries only the
always-applicable conventions; the detail lives here.

This file is the FULL record: design decisions, incident forensics, shipped-work
history. The distilled "never do X" rules that must reach every session live in
`.claude/rules/*.md` (auto-loaded when Claude opens a matching file).
-->

# Pipeline, Job Editing & Organisation Data Model — module reference

Job detail editing, band-centric model, lead org + client lock, HireHop data cleanup, address book.

#### Pipeline & Enquiry Cleanup ← IN PROGRESS

Two streams of work to improve the pipeline/enquiry/jobs experience:

**Stream A: Job Detail Editing** ✅ COMPLETE
The Job Detail page has inline editing for all key fields.
- [x] **HH Job Number** — Clickable/editable "NEW" badge. Accepts pasted HH URLs (`https://myhirehop.com/job.php?id=15564`) and extracts the number. Once linked, sync takes over.
- [x] **Dates** — Four-date linked editor (Outgoing↔Job Start, Returning↔Job Finish toggleable links, date constraints enforced)
- [x] **Client** — Editable with org search picker
- [x] **Job name** — Inline editable
- [x] **Pipeline fields** — Likelihood, next chase date, job value — all inline editable on Job Detail
- [x] **Create in HireHop** button — Push Ooosh-native enquiry to create HH job, write back the number. HH user/manager mapping via `hh_user_id` on users table (migration 028). Uses `/api/save_job.php` with confirmed field names: `out`/`start`/`end`/`to` for dates, `duration_days`/`duration_hrs` for charge period, `duration_locked: 0`. Default times 09:00 when DatePicker sends date-only. Details field is NOT pushed to HH job memo.
  - **⚠️ Charge period = `ceil(elapsed_hours / 24)`, computed from the INSIDE dates only — Job Start → Job End (NOT Outgoing/Returning). CEIL, never floor (Jul 2026 fix, PR #1033 — do not reintroduce floor).** `calcHHDuration(start, end)` in `routes/pipeline.ts` is the single source for all push paths (Create in HireHop / sync-dates / combine). HireHop's own charge-period rule counts any fraction of a day past a whole 24h block as a new chargeable day — confirmed live on job 16390: finish 22:00 (132h) → 6 days, finish 09:00 next morning (143h) → 6, finish 10:05 (145h) → 7 = `ceil(hours/24)` throughout. HH honours the `duration_days` we send on save, so pushing `floor` was actively overriding HH with the wrong figure. The bug only showed on hires NOT entered on a whole 24h (9am→9am) boundary — most visibly **rehearsals**, which finish on the actual last day (e.g. 10:00–22:00) with no morning rollover, so a genuine 6-day rehearsal (9–14 Nov, 132h) was pushed as 5. For 9am→9am van entries the hours are exact 24h multiples so `ceil == floor` — vans unchanged. `duration_hrs` is also ceiled to mirror HH exactly (144.08h → 145). The Job Detail date-editor "N days" label (`JobDetailPage.tsx`) uses the same times-aware ceil so OP and HH agree; the excess (`ExcessPaymentModal`) and transition-modal day-counts already ceiled the full timestamps. Outgoing/Returning (`out`/`to`) are pushed as their own fields (equipment reserved-from / available-again) and only sanity-clamped (`out` can't be after `start`) — they never feed the day count.

**Stream B: Band-Centric Data Model** ✅ COMPLETE
Organisation-to-organisation relationships and multi-org job links. Makes "bands" a first-class concept.
- [x] Migration: `organisation_relationships` table (org-to-org links with typed relationships: manages, books_for, does_accounts_for, promotes, supplies)
- [x] Migration: `job_organisations` junction table (band, client, promoter, venue_operator, supplier roles per job)
- [x] Backend: Org relationships CRUD endpoints
- [x] Backend: Job-organisation links CRUD endpoints
- [x] Frontend: "Relationships" section on Organisation Detail page (add/remove/view linked orgs with bidirectional display)
- [x] Frontend: Band/org links on Job Detail page (add band, client, promoter etc.)
- [x] Frontend: Band picker on New Enquiry form with org search
- [x] Frontend: Service type quick-select buttons on New Enquiry form (Self-drive van, Backline, Rehearsal) — auto-creates matching job requirements (vehicle+hire_forms+excess, backline, rehearsal), description optional when service types selected
- [x] Auto-generated job names in "Band - Client - Selection" format (e.g. "Arctic Monkeys - ATC Live - Van, Backline")
- [x] Person-to-org role picker (dropdown instead of free text) with standard roles
- [x] End role confirmation dialog with optional reason and repoint flow
- [x] Frontend: Person context surfacing in pickers (show org connections when selecting a person — crew picker shows "role at Org Name")
- [x] Frontend: Smart suggestions from org graph (select band → auto-suggest management company as client on Job Detail + auto-populate client on New Enquiry)
- [x] Org-to-org relationship types: manages↔managed_by, books_for↔booked_by, does_accounts_for↔accounts_done_by, promotes↔promoted_by, supplies↔supplied_by, represents↔represented_by
- [x] Person-to-org role types: Tour Manager, Manager, Production Manager, Engineer, Accountant, Promoter, Crew, Band Member, Driver, Agent, Site Contact, Owner, General Contact, Other

##### Lead organisation + client lock (migration 190, Aug 2026)

**Two parallel mechanisms attach an org to a job, and they stay separate on purpose:**

| Mechanism | What it is | Who owns it |
|---|---|---|
| `jobs.client_id` | The **accounting client** — single FK, HireHop-derived. Drives the excess ledger, Xero contact bucketing, cross-job credit's same-client boundary, `client_excess_ledger`. | HireHop sync, unless locked (below) |
| `job_organisations` | **Every other org on the hire** — band, promoter, management, label, etc. Many-to-many with a role picklist. | Staff, via the Job Detail Organisations row |

**The ORGANISATIONS row on Job Detail is the ONE place every org is shown and managed.** The header's summary line (under the job title) carries venue + dates only — **no organisation at all**. It used to repeat the client / lead org, so the same name appeared twice in the header, with two competing edit affordances. **Don't re-add an org to that line.**

| Chip in the row | Affordances | Why |
|---|---|---|
| **Client** (from `client_id`, always present; renders `+ Add client` when the job has none) | ★/☆ · ✏️ **change** | A single FK driving accounting — it's swapped, never unlinked, so it gets a pencil where the others get an ×. This is the ONLY client-edit affordance in the UI; the search dropdown is anchored to this chip (`clientSearchRef`). |
| Every `job_organisations` row | ★/☆ · × remove | × confirms first (`"Remove X from this job?"`) — it sits beside the ★ on a small chip, so a mis-tap would otherwise silently drop an org. Removing only unlinks it from the hire; the org itself is untouched. |

**The ★ is CHOSEN, not inferred, and its only job is list representation.** `job_organisations.is_primary` (dormant since migration 027) flags which org represents the hire wherever a list has room for one name — today that's `lead_org_name` on the pipeline/kanban query. No flagged row = the client represents it, so nothing needed backfilling. A partial unique index (`uq_job_org_primary`) keeps it to one per job, mirroring the `job_contacts.is_primary` convention.

**What this replaced:** the kanban card and the Job Detail header both used `jobOrgs.find(jo => jo.role === 'band')` — adding a band automatically stole the top slot and demoted the client to a grey "Billed to:" sub-line, asserting a billing split that often wasn't true (job 16352: adding "Motrik" as the band demoted sole contact "Rob Jones" to "Billed to"). **Do NOT reintroduce a role-inferred top slot or a "Billed to" line.**

Moving the ★ is a single flag flip — fully reversible, rewrites no attribution, and `client_id` stays authoritative for accounting whichever org is starred. That's the answer to "swap the names without ghost trails": don't rename the org and don't re-point the client, just move the star.

- **Endpoint:** `PUT /api/pipeline/:jobId/organisations/lead` — `{ organisation_id: uuid | null }`, null clears. Transactional (clear-then-set; the unique index means the old one must go first). Returns the full refreshed list.
- **Kanban:** the pipeline list query exposes `lead_org_name` (was `band_name`). Cards render one line: starred org → client → `—`.

**Client lock — `jobs.client_locked_at` / `client_locked_by`.** The HH job sync wrote `client_id = COALESCE($n, client_id)`, which only guards NULL — so an OP-side client change silently reverted within 30 minutes, because HireHop's `COMPANY` string won every pass. Changing the client via `PATCH /api/pipeline/:id/edit` now stamps the lock, and both sync paths guard with `client_id = CASE WHEN client_locked_at IS NOT NULL THEN client_id ELSE COALESCE($n, client_id) END`. When locked AND HireHop disagrees, the sync queues a **`client_mismatch`** review (Data Cleanup page) instead of reverting — visible disagreement beats silent revert. Staff resolve it by pushing OP's client to HH (`sync-client-to-hh`) or changing it back in OP.

**Display names: `jobDisplayOrgName` / `jobClientName` are THE definitions (Sep 2026).** The client lock protected `client_id`, but NOT the display strings — the sync still overwrote `client_name`/`company_name` unconditionally, and the list endpoints had no org join, so a changed client reverted to HireHop's old name on ~25 read sites while Job Detail (which has always joined) showed the new one. Three layers fix it, and all three matter:

1. **`client_name` is now gated on `client_locked_at`** in both sync UPDATEs, exactly like `client_id`. It is the string most surfaces fall back to and the only thing job search matched, so leaving it unguarded meant a deliberate rename reverted within 30 minutes and became unfindable by its new name. **`company_name` is deliberately NOT gated** — nothing in OP ever writes it (it is absent from the `PATCH /edit` allowlist), so freezing it would pin a stale value forever; leaving it live also means the search `OR` still finds the job under its old HireHop name.
2. **The three list endpoints join the client org** (`GET /api/hirehop/jobs`, `/api/cancellations/list`, the pipeline/kanban query) exposing `client_org_name`, and all three now also expose `lead_org_name` — before this the ★ only affected the kanban card despite claiming to represent the job on job lists. ⚠️ **`organisations` has an `is_deleted` column too**, so the jobs-list `whereClause` had to be qualified to `jobs.is_deleted` — a bare reference is ambiguous once the join is added, and it is shared with a join-free `COUNT` query, so qualification (not aliasing) is the fix. In the pipeline query the `linked_organisations` subquery was re-aliased `o` → `xo` to stop it shadowing the new outer join.
3. **Search matches the names actually displayed.** Both list searches gained `EXISTS` clauses over the client org and any linked org (incl. the ★ lead) — `EXISTS` rather than a join so the join-free `COUNT` queries keep agreeing. Without this the lists could show a name that search could not find.

**Two frontend helpers, and the distinction is load-bearing** (`frontend/src/lib/jobOrgName.ts`):

| Helper | Precedence | Use for |
|---|---|---|
| `jobDisplayOrgName` / `…Or` | `lead_org_name → client_org_name → company_name → client_name` | "Whose job is this" on a LIST row or pipeline card. Honours the ★. |
| `jobClientName` / `…Or` | `client_org_name → company_name → client_name` (**ignores the ★**) | "What is the CLIENT called" — anywhere the name sits beside `client_id`: the Client chip, the Client History panel, any `clientName`/`clientOrgName` passed to a child. |

Starring a band must **not** relabel the client in the second group — the ★ changes which org headlines a LIST, never who the hire is billed to. **Any new surface showing a job's org MUST call one of these** rather than hand-rolling the fallback chain; that chain is exactly what drifted (some sites read `client_name` first, some `company_name` first, so the same job showed different names on different pages).

**The ★ lead org is NOT pushed to HireHop.** Both push paths (`push-hirehop`, `sync-client-to-hh`) resolve `COMPANY` from `organisations WHERE id = jobs.client_id` — the Client chip. `job_organisations.is_primary` appears in neither. Note there are **two stars on Job Detail** and only one reaches HH: the ★ on the CONTACTS row (`job_contacts.is_primary`) becomes the HH contact `NAME`; the ★ on the ORGANISATIONS row is display-only.

**Renaming an org to "fix" a job is still the wrong move** — the sync matches the client org by NAME against HH `COMPANY`, so renaming means the next pass finds no match, creates a fresh duplicate shell, and (pre-lock) re-pointed `client_id` at the duplicate. Use the org **merge** tool for genuine duplicates, and the lead flag for "which name shows".

**Job-sync `possible_band` guard rail.** The contact sync has flagged suspicious org names since Stream C, but the JOB sync — which auto-creates one org per distinct HH `COMPANY` string — had none, so ~20 junk orgs (`WOH26 / ARTHUR VEROCAI`, `WOH26 / Lush Life / Aja Monet`, …) accumulated silently when a colleague used HireHop's company field as a notes field. Both syncs now share `services/sync-review.ts` (`flagForReview` + `looksLikeCompanyName`), and the job sync's shell-create path is a single shared helper (`resolveClientOrgFromCompany`) rather than two hand-copied blocks — which is exactly how the guard rail ended up on one sync and not the other. **Any new org-creating sync path must go through that helper.**

**Stream C: HireHop Data Cleanup** (depends on Stream A "Create in HireHop" button)
HireHop sync imported contacts literally — bands became people, management companies got typed as "client", etc.
The cleanup strategy is: OP becomes master for relationship data, HH gets what it needs via push.

*Step 1: OP→HH job creation* ✅ COMPLETE (part of Stream A)
- [x] `POST /api/pipeline/:id/push-hirehop` — create job in HH via `/api/save_job.php`
- [x] Map OP fields → HH: contact person → `name`, client org → `company`, dates → `out`/`start`/`end`/`to`, job name → `job_name`, charge period → `duration_days`/`duration_hrs` with `duration_locked: 0`
- [x] Date-only values default to 09:00 time; details field NOT pushed to HH memo
- [x] Write back HH job number to OP `jobs.hh_job_number`
- [x] Include `no_webhook=1` to prevent sync loops
- [x] Band stays in OP only (HH has no band field)
- [x] Frontend: "Create in HireHop" button on Job Detail + optional checkbox on New Enquiry form

*Step 2: Sync guard rails* ✅ COMPLETE
- [x] HH contact sync: when new person name matches existing *organisation*, flag as `name_conflict` → review queue
- [x] HH contact sync: when new org typed 'client' doesn't look like a company name, flag as `possible_band` → review queue
- [x] HH contact sync: type mismatches flagged as `type_mismatch` → review queue (preserves manually-set types, only overwrites HH-derived types: client/venue/supplier/unknown)
- [x] HH contact sync: tags merged (not replaced) on existing orgs
- [x] HH job sync: only updates HH-owned fields (status, dates, names), uses COALESCE for org links, never touches pipeline_status/org types/relationships/job_organisations
- [x] Surface "needs review" items on Data Cleanup page (Sync Review Queue tab with resolve/dismiss actions)

*Step 3: Data cleanup tools* ✅ MOSTLY COMPLETE
- [x] "Convert Person to Organisation" — transactional: creates org, copies external IDs, moves interactions + job links, soft-deletes person
- [x] **Organisation merge** (May 2026) — admin/manager-only "Merge" button on Org Detail header. `GET /api/organisations/:id/merge-preview?keep_id=…` returns counts of what will move (people, jobs, job-org links, venues, interactions, relationships, child orgs, job issues) + external ID conflicts. `POST /api/organisations/:id/merge` runs in a single transaction (BEGIN/COMMIT/ROLLBACK on failure): reassigns FK rows to keeper, dedups against unique constraints (`job_organisations(job_id, org, role)`, `organisation_relationships(from, to, type, status)`, `external_id_map(entity_type, entity_id, system)`), drops self-referencing relationship edges, fills keeper's null scalars from loser, unions tags + files, appends backref note both directions for audit (`[Merged from "X" on YYYY-MM-DD by user]` on keeper, `[Merged into "Y"]` on loser). Loser is soft-deleted (`is_deleted=true`); audit_log gets entries on both records. External ID conflicts (e.g. both orgs have a HireHop ID) are resolved keeper-wins; discarded IDs are recorded in keeper notes. Frontend modal: org search picker, count preview, type-the-loser-name confirmation guard, redirect to keeper on success. Stays on the same branch as the people merge (transactional was an upgrade — original people-merge in `routes/duplicates.ts` is NOT transactional, latent risk for that flow). **Companion display change:** the Job Detail sidebar Client History "Internal Notes" block (`JobDetailPage.tsx`) is now `line-clamp-2` with a Show more / Show less toggle when content exceeds 120 chars or 2 lines. Merge backref notes + external-ID-conflict logs accumulate on the keeper's `notes` field over time, so the always-fully-rendered display was visibly bloated post-first-merge.
- [ ] **Person+org merge** — for the case where one record is a person and the other is an org representing the same entity. Person→Org conversion exists already (`/api/data-cleanup/convert-person-to-org`); a true merge would be the conversion path + org-merge path stitched. Lower priority since converting first then merging works.
- [x] Bulk type correction — multi-select orgs by type, change type in bulk (auto-resolves pending type_mismatch reviews)
- [x] "Needs review" page — Data Cleanup page (`/data-cleanup`) with Sync Review Queue, Org Types, Convert Person tabs
- [x] Organisation type stats breakdown with click-through to orgs of each type

*Step 4: Smart relationship suggestions* ✅ COMPLETE
- [x] When viewing a "Contact" at a "client" org, system suggests: "Is this actually a Band?" (amber banner on Org Detail)
- [x] When new HH sync creates entities, surface for review before they pollute the graph (sync flagging → review queue)

#### Remaining Phase 2 work (no strict ordering)

- [x] **Address Book Enhancements** (24 Mar 2026)
  - [x] Do Not Hire flag on People + Organisations (red banner, admin set/lift, audit logged, non-blocking)
  - [x] Working Terms dropdown on People + Organisations (USUAL/FLEX BALANCE/NO DEPOSIT/CREDIT/CUSTOM + credit days)
  - [x] AI text panels on all address book entities: Internal Notes (always shown), AI Summary (placeholder), AI Research (placeholder)
  - [x] File sharing flag (`share_with_freelancer`) on venue files and job files (green Shared badge, hover toggle, persisted via `PATCH /api/files/update-metadata`)
  - [x] Google Maps link on venue addresses (map pin icon)
  - [x] Organisation picker on venue form + org display on venue detail
  - [x] Pagination on Organisations and Venues pages
  - [x] Missing org type "client" added to form dropdown + filter (was causing default-to-band bug)
  - [x] Multi-filter on People: has email, has phone, freelancers, approved
  - [x] Multi-filter on Organisations: has email, has people, type
  - [x] Multi-filter on Venues: linked to org
  - [x] Sort options on all list pages: name, recently added, recently updated, last contacted
  - [x] "Last Contact" column on People + Organisations (colour-coded: green <30d, amber 30-90d, red >90d). **"Last contacted" = broadest reachable genuine contact, NOT just the entity's own interactions (Jul 2026).** Client contact overwhelmingly lands on the JOB timeline, not the org's/person's own — so reading only `interactions WHERE organisation_id = o.id` (the original) read stale/empty. Both the org + people list columns AND their "last contacted" sort now compute `MAX(created_at)` over contact-type interactions (`type IN ('call','email','meeting')` — auto-chase-ingested client emails are `type='email'`, so they count; `note`/system rows deliberately excluded) reachable from the entity. Org (`routes/organisations.ts` `lastContactSubquery`): own timeline + jobs linked via `job_organisations`/`jobs.client_id` + people linked via active `person_organisation_roles`. Person (`routes/people.ts` `lastContactSubquery`): own timeline + jobs they're a `job_contacts` or crew (`quote_assignments`→`quotes`) contact on — kept person-focused, NOT the whole org's timeline (that lives on the org page; bubbling it would make every contact at a busy client look freshly contacted). One shared subquery drives both the SELECT and the sort so they can't drift. Any new "last contacted" surface should read from this broadened source, not the entity's own interactions alone.
  - [x] Smart suggestions on Org Detail (suggest band retype for misclassified clients)
  - [x] Data Cleanup page restricted to admin/manager roles in nav
  - [x] Client info surfacing on New Enquiry form + Job Detail sidebar: Do Not Hire warning (red banner), Working Terms, Internal Notes — via enhanced `/pipeline/client-history` endpoint returning `client_info` from organisations table
  - [x] Band trading history on New Enquiry form sidebar (shows band's job history alongside client history)
  - [x] Band trading history on Job Detail sidebar (when band linked via job_organisations)
  - [x] Separate stacked sections: client history above, band history below, each with 4-square stats grid
- [x] **Per-job Contact Linkage** (May 2026, rounds 1-6) — full spec under "Per-job contacts (`job_contacts`)" in Shared Utilities. Six PRs (#547, #549, #550, #551, #554, #559, #561) split into a data layer + routing graduation + management UI:
  - [x] Round 1 (#547): picklist tidy + cascade contact picker on New Enquiry form
  - [x] Round 2 (#549): tickable contacts + search-first add + `job_contacts` table (migration 086)
  - [x] Round 3 (#550): +1 button on Returning, auto-tick of default contact on cascade load
  - [x] Round 4 (#551, #554): dangling-form auto-save on submit failure + loud failure alerts, validation-error clear-on-recover
  - [x] Round 5 (#559): sender helpers (money-emails, hire-form-contacts, has_client_email banner) read `job_contacts` first; HH push enrichment uses primary contact's name as `NAME` + email/phone, org as `COMPANY`
  - [x] Round 6 (#561): `JobContactsCard` on Job Detail header — tickable chips with primary star, debounced autosave, "+ Add" with search-first / create-new fallback; opt-in promote-to-job-contacts checkbox on the hire-form picker; three new endpoints under `/api/pipeline/:jobId/contacts` (GET / PUT / POST add-person)
- [x] **Mobile Responsiveness & UX** (15 Apr 2026)
  - [x] Job Detail header: responsive job name (text-lg/text-2xl), stacked action buttons on mobile, flex-wrap badges
  - [x] Details & Notes collapsed into header card with truncated snippets, click-outside-to-close
  - [x] Tab bar horizontally scrollable on mobile with shorter labels (scrollbar-hide CSS utility)
  - [x] Activity timeline: fixed raw Date objects in change logs, human-readable field labels
  - [x] overflow-x-auto on all list page tables (People, Orgs, Drivers, Team, Excess, Org Detail, Driver Detail)
  - [x] "Open in HireHop" hidden on mobile (redundant with #number link)
  - [x] Header card padding reduced on mobile (p-4 sm:p-6)
- [x] **Hire History Tab** (15 Apr 2026)
  - [x] `GET /api/organisations/:id/hire-history` — paginated jobs via job_organisations, retro + lost reason parsing
  - [x] `GET /api/people/:id/hire-history` — jobs via org memberships UNION crew assignments
  - [x] Reusable `HireHistoryTab.tsx` component with stats cards (total, confirmed, value, retro breakdown). **Stats cards are filter-aware (Jul 2026):** the four cards (Total Jobs / Confirmed / Total Value / Retros) reflect the active outcome/role/year filters — the org + person hire-history stats + retro queries apply the same `filterSql` as the list/count (previously they always computed over the whole entity). `Total Value` sums whatever `job_value` is present across the visible filtered rows (the confirmed-only `SUM FILTER` was dropped — the Money tab owns the figure). A subtle "· filtered" hint renders on the cards when a filter is active (`filtersActive` in `HireHistoryTab.tsx`).
  - [x] Retro rating badge + notes + follow-up shown inline (not just hover)
  - [x] Lost reason shown for lost jobs (grey "Lost" badge + reason text)
  - [x] Person hire history shows "Crew" label for crew assignment links
  - [x] Organisation Detail: "Hire History" tab between Relationships and Activity Timeline
  - [x] Person Detail: "Hire History" tab after Activity Timeline
- [x] **Completion Retro** (15 Apr 2026)
  - [x] Retro modal on status transition to Completed (like Lost reason modal)
  - [x] Three-button rating: Great (default) / OK / Issues
  - [x] Notes + follow-up fields, stored as interaction on activity timeline
  - [x] Outstanding close-out items warning in modal (amber, non-blocking)
  - [x] Retro data surfaced in Hire History tabs with breakdown stats
- [x] **UX Polish** (15 Apr 2026)
  - [x] Date editor: End Time only shown for single-day hires, Job End Time for multi-day
  - [x] Jobs page: simplified status filter (removed Returned/Completed/Cancelled — they have dedicated pages)
  - [x] Do Not Hire button moved next to Edit/Delete on Person + Org detail pages (was standalone section)
  - [x] Invoice "Mark as Sent" cascades to auto-resolve client follow-up
  - [x] Activity Timeline interaction refresh triggers prep checklist update
- [ ] **Crew & Transport refinements**
  - [x] `is_freelancer` flag + freelancer filtering in crew assignment
  - [x] Tab badge count fix (show quote count on initial load)
  - [x] People page freelancer/approved filter
  - [x] Freelancer document management (DVLA check, licence front/back, passport)
  - [x] Freelancer joined date + next review date fields
  - [ ] Quote editing (currently create-only, no edit mode)
  - [ ] Quote status transition validation (prevent invalid transitions)
  - [ ] RBAC on calculator settings (currently any auth user can change)
- [ ] **Vehicle delivery reminders** — reminder system for upcoming deliveries (depends on vehicle module)
- [x] **HireHop webhooks** — bidirectional real-time sync via webhooks (live 16 Mar 2026)
  - [x] Inbound webhook receiver: `POST /api/webhooks/hirehop` with export_key verification
  - [x] Handles: `job.status.updated`, `job.updated`, `job.created`, `contact.*` events
  - [x] Webhook logging to `webhook_log` table (migration 018)
  - [x] Write-back service: pushes pipeline changes to HireHop with `no_webhook=1` loop prevention
  - [x] External status transition API with API key auth (`api_keys` table)
  - Polling sync still runs as fallback (every 30 min) for catch-up
- [x] **Jobs page improvements** (live 16 Mar 2026)
  - [x] "Happening Today" section split into Going Out / Out Now / Returning sub-sections
  - [x] Return window logic (midday day before through return_date)
  - [x] Time-based filter dropdown (Out Now / Next 2 Weeks / Over 2 Weeks)
  - [x] Prep Checklist prototype tab on Job Detail (dummy data, interactive demo)
- [x] **User profiles & nav redesign** (17 Mar 2026)
  - [x] Migration 023: avatar_url, force_password_change, password_changed_at on users
  - [x] Profile page (`/profile`): edit name, upload avatar photo, change password
  - [x] Nav bar redesign: user avatar + name as dropdown with My Profile / Settings / Sign out
  - [x] Settings link removed from main nav, now in user dropdown (admin/manager only)
  - [x] Admin force-password-reset from Settings page (sets temp password + force_password_change flag)
  - [x] Avatar stored in R2 under `avatars/{userId}/`, displayed in nav bar and user lists
- [ ] **Inbox & Notification System** — see dedicated section below (Step 7)
- [ ] Win/loss analysis dashboard (depends on pipeline — lost_reason basics included in pipeline)
- [ ] ~~Job close-out workflow~~ → See **Step 4b: Returns & Close-Out System** below
- [ ] Xero financial summary integration
