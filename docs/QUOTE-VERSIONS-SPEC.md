# QUOTE VERSIONS SPEC — alternative quotes for one enquiry, as a group of jobs

**Status:** 📋 PLANNED (9 Oct 2026) — jon + Claude, designed over mockups. Nothing built. The
build happens in a fresh session that ALSO has the **payment portal repo** in context (Phase 4
touches both sides). §1 is the settled decisions; §13 is the handover note for that session.

**Mockups (approved by jon, "wording to tighten, otherwise great"):**
https://claude.ai/artifact/RaKVKF9jE4vnUVfgxRUeQB — boards: Main (single version, the subtle
"+ Add a version" link), Versions (the tab bar), Compare (slide-over), AddVersion (modal),
Confirm (one version confirmed → tick siblings → Mark lost), Kanban (one collapsed group card),
Portal (state A "you're paying for v2 — we sent you 4", state B dead link). Private to jon —
ask him to open it if the build session can't.

**Read first:** `.claude/rules/jobs-pipeline-dashboard.md`, `.claude/rules/hirehop.md`,
`docs/reference/PIPELINE-AND-ORGS.md`, `docs/reference/RETURNS-AND-CANCELLATIONS.md` (the
Combine Bookings section — the closest existing sibling of this feature),
`routes/pipeline.ts` (status PATCH at ~463, combine at ~1930), `routes/cancellations.ts`
(~615–665, the HireHop `job_duplicate.php` call this reuses), `services/requirement-close-sweep.ts`,
`services/job-close-cascade.ts`, `routes/money.ts` `job-lookup` (~778),
`services/payment-portal-link.ts`.

---

## 0. One-line summary

> One client, one enquiry, several alternative quotes (three date spans; van only vs van +
> driver; with or without a Fender Twin). Each alternative is **its own OP job AND its own
> HireHop job** — because every one has to go out to the client as a HireHop quote. OP adds a
> **thin group layer** on top so the versions read as one enquiry: a version tab bar on Job
> Detail, a Compare slide-over, one collapsed card on the Kanban, and — when the client confirms
> one — a prompt to mark the rest lost as *Confirmed Alternative Quote (from us)*. Nothing is
> amended in place; the "which one did they actually want" problem is solved by never having
> one job try to be several things.

## 1. Decisions (settled — don't re-litigate without jon)

1. **One version = one OP job + one HireHop job.** Always. jon rejected "versions stay OP-only
   until they get serious": the root problem is *organising the HireHop jobs*, and a quote can
   only be sent from a HireHop job. "Add a version" therefore ALWAYS duplicates the HireHop job
   too (`job_duplicate.php`, the re-open path's mechanism — §5).
2. **Never amend a job in place to become a different alternative.** jon's view: letting a
   client confirm a quote that doesn't carry the things they want is the riskier way. A new
   alternative is a new version. Revisions *within* an alternative (drop a snare stand, change
   the price) are already tracked by the quote-PDF version diff on the Activity Timeline
   (`AUTO-CHASE-SPEC.md` §7.3) and are NOT what this spec means by "version".
3. **The group is a thin layer.** It adds a tab bar, a compare view, a Kanban collapse and a
   confirm-one-lose-others prompt. It does not own money, status, requirements or sync — every
   version keeps being an ordinary job that every existing surface already understands.
4. **Single-version jobs look exactly as they do today** — one job with no group shows no bar,
   no badge, nothing new except a subtle "+ Add a version" link in the header. jon: "no need to
   clutter up the view".
5. **Version numbers are the alternative's identity, not a revision counter.** v1 is the
   original, v2 the first alternative added, and so on. **They never auto-bump** when HireHop
   changes a job — a `v2` stays `v2` through ten price tweaks. jon considered auto-amending on
   every HireHop change and ruled it "feels complicated"; the PDF diff already answers "what
   changed on this quote, when".
6. **Confirm one → the others are marked lost, by a human.** The prompt pre-ticks the siblings;
   staff confirm. Never auto-lose on a portal payment or an inbound HireHop webhook —
   those fire a bell + the same prompt next time the job is opened (§7).
7. **The lost reason is the existing `'Confirmed Alternative Quote (from us)'`** (migration 191
   renamed it so "Competitor" keeps meaning the alternative came from someone else). Versions
   lost this way are NOT lost revenue and must be excluded from win/loss and Fill-a-Gap (§8).
8. **Lead version = most progressed, with a pin override.** Auto: the version furthest along
   the pipeline (confirmed beats provisional beats quoting…), tie → lowest version number. Staff
   can pin a different one. The lead is what the Kanban card and any roll-up read.
9. **Any staff can add a version and manage a group** (`STAFF_ROLES`). Marking siblings lost
   goes through the existing lost transition and inherits its permissions.
10. **"Items" not "Backline"** on the Compare view — an item count across everything on the
    HireHop job (the Twin counts, so does a splitter cable), because "Backline yes/no" hides the
    thing the versions actually differ on.
11. **Payment = choosing.** The portal link carries the HireHop job number, so three versions on
    the same dates get three different links — the client picks a version by paying its link.
    The hash is a lightweight tamper check (`buildPaymentPortalHash` = USER + DURATION_HRS +
    job number), not an identity. No per-document links.
12. **Festival-style grouping ("Main stage" + "Band A" + "Band B" are one thing) is Phase 2**
    (`kind = 'part_of'`), designed on the same table so it costs a flag, not a model. Roll-ups
    are the stretch goal there; "see that these belong together" is the core.

## 2. The problem, in jon's words

A client asks for a few quotes for what is really one enquiry: one self-drive van across three
sets of close-together dates; then one quote for the van across the whole stretch; then the same
with a driver; then one with a Fender Twin added. Today that's four unrelated HireHop jobs and
four unrelated OP enquiries. Nobody can see they belong together. The Kanban shows four cards.
Chasing happens four times or not at all. When the client confirms one, the other three sit in
Enquiries until someone notices, and when they're finally marked lost they pollute the loss
figures as if we'd lost £2k of business rather than moved it sideways. On Job Detail there is no
answer to "is this hire self-drive or with a driver? backline or not? when does it actually
start?" because the honest answer is "depends which one they pick".

The alternative — one job that staff keep amending as the client changes their mind — is how
clients end up confirming a quote that doesn't have the right things on it.

## 3. The model

```
job_groups (one row per enquiry-with-alternatives)
  └── jobs.group_id ──► v1  (original, OP job + HH job)
                        v2  (alternative, OP job + HH job)
                        v3  …
```

- A **group** exists only once a second version exists. Adding the first alternative to a
  lone job creates the group and makes the lone job v1 (its name gains " (v1)" — §5.3).
- A **version** is an ordinary `jobs` row. Status, money, requirements, contacts, sync,
  chase — all unchanged. `group_id`, `version_no`, `version_label` are the only additions.
- A version that goes **lost** stays in the group (struck-through in the bar — §6.1). A version
  that is **cancelled** after confirmation likewise stays. Nothing is ever removed from a group
  automatically; "Remove from group" is an explicit staff action that just nulls the columns.
- **One group, one `kind`.** `alternative` (this spec) or `part_of` (Phase 2). Mixing is refused.

## 4. Data model

Migration: take the next free number at build time (`run.ts` is at 281 as of 9 Oct 2026) and
**add it to the `migrations` array in `run.ts`**.

```sql
CREATE TABLE job_groups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            VARCHAR(20) NOT NULL DEFAULT 'alternative'
                  CHECK (kind IN ('alternative', 'part_of')),
  label           TEXT,                       -- optional: "Katatonia Nov options"; default = client name
  lead_job_id     UUID REFERENCES jobs(id),   -- NULL = auto (most progressed); set = pinned
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE jobs
  ADD COLUMN group_id       UUID REFERENCES job_groups(id) ON DELETE SET NULL,
  ADD COLUMN version_no     INTEGER,            -- 1, 2, 3… within the group; NULL when ungrouped
  ADD COLUMN version_label  TEXT;               -- the differentiator: "Van + driver", "whole stretch + Twin"

CREATE INDEX idx_jobs_group ON jobs(group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX uq_jobs_group_version ON jobs(group_id, version_no) WHERE group_id IS NOT NULL;
```

- `version_no` is assigned as `MAX(version_no) + 1` within the group at add time and **never
  reused or renumbered**, even if a middle version is removed. v4 after a removed v3 is still v4.
- `version_label` is staff-typed at add time (the modal's "What's different?" field — §5.2),
  editable later inline. It is the human name of the alternative; `version_no` is the handle.
- `lead_job_id` NULL means "derive it" (§6.3). Setting it is the pin.
- No `hh_group` anything — HireHop has no concept of this and we do not try to give it one
  beyond the " (vN)" in the job name.

**Shared types** (`shared/types/index.ts`): add `group_id`, `version_no`, `version_label` to
`Job`; add `JobGroup` + `JobGroupMember` (the Compare row shape, §6.2).

## 5. Add a version

### 5.1 Entry point

- Job Detail header, every job that is not lost/cancelled/completed: a subtle text link
  **"+ Add a version"** (mockup: Main). When the job is already in a group the same action lives
  at the right-hand end of the version bar as **"+"**.
- Also available from the Kanban group card's menu (Phase 1 if cheap, else PR 2).

### 5.2 The modal (mockup: AddVersion)

Fields:
- **What's different?** (required, becomes `version_label`) — free text, with quick-pick chips
  that pre-fill it: *Different dates* · *Van + driver* · *Self-drive* · *Add backline* ·
  *Whole stretch* · *Other*. Chips only fill the text; they change nothing on the job.
- **Dates** — pre-filled from the source version, editable (the four-date editor, same component
  as Job Detail). This is the one piece of job data the modal lets you change up front because
  "different dates" is the most common alternative and saves an immediate second edit.
- **Create the HireHop job now** — a checkbox, **ticked by default and normally left ticked**
  (decision 1). Unticked only when the source has no HireHop number yet (then the new version
  can't be duplicated from anything — it is created OP-only and gets the existing "Create in
  HireHop" button like any OP-native enquiry).
- Footer copy: "This creates a new job (vN) for the same client. Items, notes and contacts are
  copied; you then adjust them in HireHop as usual."

### 5.3 What `POST /api/pipeline/:id/add-version` does (one transaction for the OP part)

1. **Group:** if the source has no `group_id`, INSERT `job_groups` (`kind='alternative'`,
   `label = client name`), set the source's `group_id` and `version_no = 1`, and rename the
   source `"<name> (v1)"` (push the rename to HireHop with `no_webhook=1`, like the existing
   job-name edit path). If the source already has a group, reuse it; `version_no = MAX + 1`.
2. **OP copy:** INSERT a new `jobs` row copying from the source: client (`client_id`,
   `client_name`, `company_name`), venue, managers, `is_van_and_driver` and the other staff
   overrides, dates (from the modal), `likelihood`, `chase_interval_days`, `is_internal`,
   `job_organisations` rows (band, promoter…), `job_contacts` rows (incl. primary + the
   `email_routing` JSONB). **Not copied:** `pipeline_status` (new version starts `quoting`),
   `next_chase_date` (set to the source's so they chase together), `line_items` /
   `hh_derived_flags` / requirements (HireHop owns those — the next sync fills them in),
   anything money-related (`job_value`, excess, payments, `job_financials`), files, interactions,
   `dismissed_at`.
3. **HireHop copy** (after commit, when ticked and the source has `hh_job_number`): the exact
   `job_duplicate.php` call from `cancellations.ts` ~634 (`id, supplying:1, notes:1,
   transport:1, reserved:1, job_name: "<name> (vN)", local`), then `save_job.php` with the
   modal's dates (`out/start/end/to`, `duration_days` via `calcHHDuration`, `no_webhook:1`).
   Write the returned job number onto the new OP row. If HireHop fails, the OP version still
   exists (with `hh_job_number NULL`) and the response carries `hh_error` so the modal shows the
   amber "Created in OP — HireHop duplicate failed, use Create in HireHop" line. Never roll back
   the OP version for a HireHop failure.
4. **Timeline:** one `note` interaction on each side — on the source "Added version v2 (Van +
   driver) → #16412", on the new version "Created as v2 of this enquiry from #16398".
5. Response: `{ data: { job, group } }`; the frontend navigates to the new version.

### 5.4 Add an EXISTING job to a group

`POST /api/pipeline/:id/group-with` `{ other_job_id }` — for the case where staff already made
two separate enquiries by hand. Refused unless both are the same `client_id`, neither is
already in a different group, and neither is completed. Numbering: the older job (by
`created_at`) is v1 if a new group is being created. Names gain " (vN)" and the rename pushes
to HireHop. Surfaced as **"Link to another quote…"** in the "+ Add a version" dropdown
(search the client's other open jobs — reuse the Combine candidate picker shape).

### 5.5 Remove from group

`DELETE /api/pipeline/:id/group` — nulls the three columns, strips " (vN)" from the name (push
to HH). If the group drops to one member, that member is ungrouped too and the `job_groups`
row deleted. Timeline note both sides. Nothing else changes.

## 6. Reading a group

### 6.1 Version bar on Job Detail (mockup: Versions)

Rendered **only when the job's group has ≥ 2 members**, directly under the job header, above
the tabs. One pill per version, in `version_no` order:

```
[ v1 · 10–12 Nov · Self-drive ] [ v2 ★ · 10–12 Nov · Van + driver ] [ v3 · 10–17 Nov · + Twin ] [ v4 ~~lost~~ ] [ Compare ] [ + ]
```

- Pill = `vN` · short dates · `version_label`. Status colour on the pill border (the pipeline
  pill colours). The current page's version is solid; others are outlined links.
- ★ marks the lead (§6.3). Right-click / long-press → "Pin as lead" / "Unpin".
- Lost versions render struck-through and dimmed but stay in the bar — the record that the
  option existed is part of the story. Cancelled likewise.
- **Compare** opens the slide-over (§6.2). **+** opens Add a version (§5).
- Also show the group's label as a small caption ("Katatonia Nov options · 4 versions") and
  an inline edit for it.

### 6.2 Compare slide-over (mockup: Compare)

`GET /api/pipeline/groups/:groupId` returns the group + one row per member:

| Column | Source |
|---|---|
| Version | `version_no`, `version_label`, is-lead |
| Config | from `hh_derived_flags`: `self_drive_count` / `van_and_driver_count` → "Self-drive ×1" / "Van + driver ×1"; `has_rehearsal` → "+ rehearsal"; `crew_item_count` → "+ crew" |
| Dates | `job_date`–`job_end` (inside dates) + day count via the same ceil rule as the Job Detail header |
| Items | count of `kind = 2` non-virtual lines in `jobs.line_items` (decision 10) |
| Client £ | `job_value` (ex-VAT accrued, as the Money tab caches it) — "—" when unknown |
| Status | pipeline pill; `is_chasing` flag; `next_chase_date` |
| Portal link | from `getPaymentPortalLink(hh_job_number)` — shown as a copy icon (decision 11) |

Row actions: open · pin as lead · mark lost (opens the existing Lost modal) · remove from
group. The slide-over is also where "Mark the others lost" lives after a confirmation (§7).

### 6.3 Lead version

`lead = group.lead_job_id ?? most progressed member`. Progression order for the auto rule
(highest wins): `completed > returned > returned_incomplete > dispatched > prepped > prepping >
confirmed > provisional > quoting > new_enquiry > paused`; `lost`/`cancelled` never lead while a
live member exists. Tie → lowest `version_no`. Implement once, in a `services/job-groups.ts`
`resolveLeadJob(members)`, and use it from the list route, the Compare endpoint and the Kanban.

### 6.4 Kanban (mockup: Kanban)

`GET /api/pipeline` (the list route at ~48) returns `group_id`, `version_no`, `version_label`
and a per-group `group_summary { label, member_count, lead_job_id, statuses[] }` on each member.
`PipelinePage` collapses members **of the same group in the same column** into one card: the
lead's details, a "4 versions" badge, a chevron to expand in place into the individual cards.
Members in different columns (v2 confirmed, v1 still quoting) each render in their own column
— the badge on each says "1 of 4 · others: quoting ×2, lost ×1" so the split is visible.

Dedup everywhere a count is a headline: open-enquiry stat card, pipeline value totals and the
"Open enquiries" dashboard number count a **group once** (by lead) — a client asking for four
options is one enquiry, not four. Lists that are per-job (Jobs page, Returns) stay per-job.

### 6.5 Elsewhere

- **Global search:** a grouped job's result row shows "v2 of 4" after the name.
- **Client/org Hire History:** grouped versions render nested under the lead with the same
  "v2 of 4" tag; lost-as-alternative versions are shown but excluded from the stats cards.
- **Job header name:** the " (vN)" suffix lives in the real `job_name` (so HireHop and every
  email agree). The header renders it as a pill rather than literal text — `stripVersionSuffix`
  helper in `lib/jobOrgName.ts`'s neighbourhood, used for display only.

## 7. Confirm one, lose the others (mockup: Confirm)

The three confirmation entry points are `routes/pipeline.ts` status PATCH (~463),
`routes/money.ts` payment-event (~3314) and `routes/webhooks.ts` inbound HireHop status (~275).
Each already fires the confirmation hooks (`services/confirmation-hooks.ts`). Add one more
hook there: `noteAlternativeVersionsOnConfirm(jobId)`.

- **Staff-driven (pipeline PATCH):** the response carries `group_prompt { siblings: [...] }`
  when the newly-confirmed job has live siblings (`pipeline_status` in a pre-confirmed stage).
  The frontend opens the Confirm panel: "v2 is confirmed. These other versions are still open —
  mark them lost?" with each sibling pre-ticked and the reason fixed to **Confirmed Alternative
  Quote (from us)**. "Mark lost" → one call per sibling to the existing lost transition
  (`PATCH /:id/status` with `lost_reason`, `keep_requirement_ids: []`) so the Lost/Cancelled
  cleanup pattern (`closeJobRequirements`, `job-close-cascade`, chase-date clearing, HH status
  10 write-back) runs exactly as for any lost job. Untick to keep one open (the client is still
  deciding between v2 and a possible add-on).
- **Unattended (payment-event, webhook):** no UI to prompt, so: bell notification to the job's
  managers + the confirmer-of-record (`priority='normal'`, `action_url` = the confirmed job with
  `?group_prompt=1`), and the Job Detail page opens the same Confirm panel when it sees that
  param and live siblings still exist. The bell self-retires: it is acknowledged automatically
  when the siblings are no longer live.
- **Never auto-lose.** Decision 6. A second confirmation in the same group (client genuinely
  books two options) is legitimate and must not be fought — the panel simply doesn't offer the
  other confirmed one.
- The confirmed version's timeline gets "Confirmed — v1, v3 marked lost (Confirmed Alternative
  Quote) by <staff>"; each lost sibling gets the standard lost note plus "→ client took v2
  (#16412)".

## 8. Exclusions and guards

- **Win/loss, cancellation analytics, lost counts:** exclude `lost_reason = 'Confirmed
  Alternative Quote (from us)'` wherever a loss is counted as lost revenue. Same rule as
  `combined_into_job_id IS NOT NULL` in the Combine spec. The Lost & Cancelled page keeps
  showing them (filterable by that reason) — it's a list, not a metric.
- **Fill-a-Gap** (`routes/fill-gap.ts`): a version lost this way did not free a slot — the slot
  is being used by its sibling. Skip the "Find replacement booking →" banner when
  `lost_reason` is the alternative reason, and never surface sibling versions as *candidates*
  for each other's gaps.
- **Stale-enquiry auto-loser (09:00):** when it loses a version whose sibling is confirmed, use
  the alternative reason rather than the default — the data is already there, use it.
- **Combine Bookings:** refuse combining two members of the same `alternative` group (they are
  options, not two hires to merge). Members of a `part_of` group may combine as today.
- **Chase model:** nothing changes. Each version keeps its own `next_chase_date`; the Kanban
  group card is "chasing" if its lead is. Logging a contact-type interaction on ANY member bumps
  **every live member's** chase date (sacred-future rule intact) — one phone call covers the
  whole enquiry. This is the one place the group touches chase state; do it in
  `interactions.ts` next to the existing bump, keyed on `group_id`.
- **Auto-chase drafts (Gmail):** draft for the lead only; mention the other versions by number
  in the draft context so Claude doesn't write four "just checking in" emails for one client.
- **HireHop sync:** a webhook or sync renaming a job must preserve the " (vN)" suffix if HireHop
  dropped it (staff edited the name in HH). `stripProjectPrefix` lives in the same spot;
  add `ensureVersionSuffix`.
- **Dismissal (`dismissed_at`):** dismissing one version dismisses only that version.

## 9. Payment portal (Phase 4 — needs the portal repo)

OP side (`routes/money.ts`):
- `GET /job-lookup/:hhJobNumber` and `GET /:jobId/summary` gain:
  ```
  payable: boolean,
  not_payable_reason: 'lost' | 'cancelled' | 'completed' | 'confirmed_sibling' | null,
  confirmed_sibling: { hh_job_number, version_label } | null,
  version_group: { label, this: { version_no, version_label },
                   siblings: [{ hh_job_number, version_no, version_label, pipeline_status }] } | null
  ```
  `payable` is false for `lost` / `cancelled` / `completed`, and for a live version whose
  sibling is already confirmed (`confirmed_sibling` set) — the client has chosen, this link is
  stale. **Verify first** what the portal already does on a Lost/Cancelled job (jon is 99% sure
  it already locks); the OP flag makes that explicit and extends it to the sibling case.

Portal side (the other repo):
- **State A (mockup Portal-A):** a live version in a group shows a quiet banner above the
  amount: "This is **v2 — Van + driver** of the 4 options we sent you (10–12 Nov). Paying here
  books this option." with the sibling labels listed, no links (they have their own emails).
- **State B (mockup Portal-B):** `payable: false` → the existing "this link is no longer valid"
  screen, with the reason copy: lost/cancelled → as today; `confirmed_sibling` → "You've
  already booked **v2 — Van + driver** (#16412). Nothing more to pay on this option."
- A payment on a `payable: false` job must be refused server-side in the portal before the
  Stripe session is created, not just hidden in the UI.

## 10. Build order

**PR 1 — model + add a version + bar.** Migration; `services/job-groups.ts` (create, add
member, numbering, `resolveLeadJob`, suffix helpers); `POST /:id/add-version`,
`POST /:id/group-with`, `DELETE /:id/group`; HireHop duplicate + rename push; version bar on
Job Detail; "+ Add a version" link + modal; shared types. **Live check:** add a version to a
real enquiry → two OP jobs, two HH jobs named "(v1)"/"(v2)", items copied, dates as entered,
bar shows both, portal links differ.

**PR 2 — Compare + Kanban + lead.** `GET /groups/:id`; Compare slide-over; pin/unpin; Kanban
collapse + "N versions" badge + headline dedup; search/hire-history tags. **Live check:** four
versions in different columns render sensibly; open-enquiry count moves by one, not four.

**PR 3 — confirm-one-lose-others + guards.** The confirmation hook on all three entry points;
Confirm panel; bell for unattended confirmations; group-wide chase bump; exclusions (§8:
analytics, Fill-a-Gap, auto-loser reason, Combine refusal, suffix preservation on sync).
**Live check:** confirm v2 via the portal on a test group → bell arrives, opening the job
prompts, marking lost runs the full cleanup, Lost & Cancelled shows them under the reason,
win/loss unchanged.

**PR 4 — portal.** 4A OP flags (§9 OP side, with the "what does the portal do today on Lost"
verification written up in the PR); 4B portal repo banner + dead-link reason + server-side
refusal. **Live check:** pay v2 on test → v1's link shows state B naming v2.

**Phase 2 (not in this build) — `part_of` groups.** Same table, `kind='part_of'`: a festival's
"Main stage" + per-artist jobs. Differences from `alternative`: no confirm-one-lose-others, no
headline dedup (they are all real jobs), Compare becomes a **Group view** with roll-ups (total
value, vans, crew across members, dates span), Kanban shows a "part of <label>" chip rather
than collapsing. Add-a-version becomes "Add a related job" (duplicate OR link existing). Also
parked: swapping a confirmation from one version to another after payment (deposit moves via
the Combine deposit mechanics — `pushDepositToHH` + `reverseDepositOnHH`).

## 11. Things this deliberately does NOT do

- Does not try to represent a group in HireHop beyond the job name. No HH Projects.
- Does not merge versions into one job. Combine Bookings is for two real hires becoming one
  continuous hire; it is refused inside an alternative group.
- Does not track revisions of a quote (price change, item dropped) — the Activity Timeline's
  quote-PDF diff does.
- Does not auto-renumber, auto-bump or auto-lose anything.
- Does not create per-document payment links.
- Does not move money when a confirmation lands on the "wrong" version — a human swaps it.

## 12. Wording to tighten at build (jon's note)

The mockup copy is draft. Specific phrases jon will want to see: the modal title ("Add a
version" vs "Quote another option"), the bar's pill format, the Confirm panel's question, the
portal banner. Keep them short; the build session should put the final strings in one
`frontend/src/lib/versionCopy.ts` so jon can tweak them in one place.

## 13. Handover note for the build session

- Have **both repos** open: this one and the payment portal (Phase 4B is there; also verify
  §9's "already locks on Lost" assumption against its code, not memory).
- Start with `.claude/rules/jobs-pipeline-dashboard.md` and `hirehop.md` — the lost-cleanup,
  sacred-future and `no_webhook=1` rules all apply here.
- Reuse, don't re-implement: `job_duplicate.php` call (`cancellations.ts` ~634), the lost
  transition (`pipeline.ts` status PATCH), `closeJobRequirements`, `job-close-cascade`,
  `calcHHDuration`, `getPaymentPortalLink`, the Combine candidate picker, the four-date editor.
- Migration number: next free at build time; add to `run.ts`. Never edit 191.
- The mockups artifact is private to jon — ask him to open it or paste screenshots.
- Each PR: jon merges and deploys by hand; give deploy commands + the live checks in §10.
