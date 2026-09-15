---
paths:
  - "backend/src/routes/{pipeline,requirements,dashboard,jobs,cancellations,fill-gap,search,backline,problems}.ts"
  - "backend/src/services/{hh-requirement-derivation,job-progress-strip,pipeline-enquiry,requirement-cleanup,*-requirement-sync,pre-hire-briefing,arranging-chaser,job-issues}.ts"
  - "frontend/src/pages/{JobsPage,JobDetailPage,PipelinePage,ReturnsPage,DashboardPage,LostCancelledPage}.tsx"
  - "frontend/src/components/dashboard/**"
  - "frontend/src/components/{RequirementCard,JobPrepChecklist,ChaseModal,JobAlertBanner}.tsx"
  - "frontend/src/lib/{jobOrgName,revisitDate}.ts"
---

# Jobs, pipeline, requirements & dashboard — load-bearing rules

Full detail: `docs/reference/PIPELINE-AND-ORGS.md`, `docs/reference/OPERATIONS-MODULES.md`,
`docs/reference/RETURNS-AND-CANCELLATIONS.md`.

## Chase model

- **"Chasing" is a DERIVED view, not a stored status.** `pipeline_status` never holds `'chasing'`. The Kanban column renders from a server-derived `is_chasing` flag (`next_chase_date <= CURRENT_DATE` AND a pre-confirmation stage). Setting a future date is enough to drop a card out — no status writes, no scheduler, no cleanup. **Don't re-add `'chasing'` as a stored value.**
- **The sacred-future rule: never shorten a future-dated chase.** A future date is a deliberate decision and must survive an unrelated email logged two days earlier. Every auto-bump uses:
  ```sql
  next_chase_date = CASE
    WHEN next_chase_date IS NULL OR next_chase_date <= CURRENT_DATE
      THEN (CURRENT_DATE + (COALESCE(chase_interval_days, 5) || ' days')::interval)::date
    ELSE next_chase_date END
  ```
  Wiring a new auto-bump source? Use this expression, not a plain UPDATE.
- Chase dates are **date-granular, not timestamps** — anything with intra-day precision ("chase me in 2 hours") isn't supported by the model.
- `next_chase_date` is auto-nulled on any transition out of an enquiry stage (`confirmed` / `lost` / `cancelled`), on both the API and inbound-webhook paths.

## Enquiry dismissal

- **Dismissal is an OVERLAY FLAG, not a status.** `dismissed_at` is stamped; `pipeline_status` is deliberately untouched. **The test everywhere is `dismissed_at IS NOT NULL`, never a `pipeline_status` check.** Any surface deriving display or eligibility from `pipeline_status` alone must also check it, or it mislabels a dud as a live enquiry (global search did exactly this).

## Requirements

- **Suspension markers must be filtered out of EVERY count / aggregate / pip.** Requirements carrying `[Suspended: …]` in `notes` sit at `status='blocked'` but are "not required on this job" (Van & Driver, internal jobs). Use the generic form `notes NOT LIKE '%[Suspended:%'`. Miss it and a V&D-only job looks like it has unresolved problems on whatever surface you're building.
- **Every background scanner reading `job_requirements` MUST gate on** `pipeline_status NOT IN ('lost','cancelled') OR keep_after_close = true`. Without it, requirements stranded on dead jobs email forever.
- **Post-hire requirement creation gates on OP `pipeline_status`, not HH status.** HH jumps to 4/5 the moment items are checked out, but OP holds at `prepped` until staff explicitly dispatch; surfacing post-hire cards early caused toggle-confusion misclicks. The closeout-specific cards keep their HH-status gate — they're about physical return, not the toggle.
- **`is_internal` mutes the client-facing chain only** (hire forms, excess, close-out cards, auto-emails, money overview, last-minute alert). It deliberately KEEPS crew & transport, vehicle allocation, post-hire vehicle/backline cards and dashboard visibility. Gate new client-facing scanners on `COALESCE(j.is_internal, false) = false`.
- Status-reactive cards (excess, merch, cost-resolve, carnet) are **recomputed from their source data on every mutation**, never hand-ticked. `syncExcessRequirementStatus` is three-way (`not_started` / `in_progress` / `done`) — a binary version reported amber "In progress" on excesses where nothing had happened.

## Dashboard

- **The canonical "operationally pre-dispatch" filter** — every surface answering "what's going out / overdue to go out" must use it, or the stat card, Today, Coming Up and Overdue Departures visibly disagree:
  ```
  (status IN (2,3,4) OR (status = 5 AND pipeline_status = 'prepped'))
  AND pipeline_status NOT IN ('lost','cancelled')
  ```
  Provisional (1) and Enquiry (0) are deliberately excluded — no warehouse work before a hire is booked.
- **Two distinct overdue concepts, kept narrow:** "Overdue returns" = should physically be back (`status IN (4,5)`); "Overdue completions" = came back but not closed out (`status IN (6,7,8)`). Prefer two narrow buckets over one wide ambiguous one.
- **Whitelist statuses in money-held buckets, never blacklist** — the status set grows over time and a blacklist silently includes every new one (41 `needed` rows once masqueraded as held money).
- **Headline counts must be the FULL total** (`COUNT(*) OVER ()`), not the LIMIT-ed row count.
- **⚠️ LIMIT lesson:** never split one LIMIT-ed query's rows into buckets client-side. Once the cap filled with one bucket, genuine small rows silently vanished. Use separate queries with their own limits.
- New "needs a human" signals become a **NeedsAttention bucket**; new per-job status pips extend `STRIP_MAPPING` (backend) *and* its frontend mirror. Don't build a parallel action surface on the dashboard.
- Progress bars are **phase-aware**: JobsPage reads `pre_hire` ("is this ready to go"), ReturnsPage reads `post_hire` ("is the close-out done"). Summing both was meaningless for either question.

## Job identity & display

- **`jobDisplayOrgName` vs `jobClientName` (`frontend/src/lib/jobOrgName.ts`) — the distinction is load-bearing.** `jobDisplayOrgName` honours the ★ lead org and answers "whose job is this" on a list row. `jobClientName` **ignores the ★** and answers "what is the CLIENT called" — use it anywhere the name sits beside `client_id`. Starring a band must never relabel the client. **Any new surface showing a job's org MUST call one of these** rather than hand-rolling the fallback chain; that chain is exactly what drifted.
- **The ★ lead org is display-only and is NOT pushed to HireHop.** Both push paths resolve `COMPANY` from `jobs.client_id`. Note there are two stars on Job Detail and only the CONTACTS one reaches HH (as the contact `NAME`).
- **`jobs.lost_reason` stores the display LABEL verbatim** (free text, filtered by exact string match). **Renaming an option REQUIRES a data migration** rewriting stored rows, or every historic job tagged with the old label vanishes from the filtered view. Same for `CANCELLATION_REASON_OPTIONS` and any other label-as-value picklist.

## Lost / cancelled cleanup

- When a job goes `lost` or `cancelled`, **every open requirement is auto-cancelled unless explicitly kept** (`keep_after_close`). Order matters: flag kept items → fire event-triggers → sweep the rest. Any new requirement type inherits this; default is cancel.
