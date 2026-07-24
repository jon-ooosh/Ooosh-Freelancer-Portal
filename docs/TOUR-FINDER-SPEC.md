# TOUR-FINDER-SPEC.md — Leads module (Cold + Warm lead discovery)

## 1. Motivation

Bring the standalone `ooosh-tour-finder` (a Python service on the Hetzner box, run
from the command line, pushing to a now-dead Monday.com board) into OP as a
first-class **Leads** module. Three intertwined jobs:

1. **Cold lead finding** — touring bands we've never worked with who fit the Ooosh
   profile (international acts flying in that need van + backline; local acts needing
   van hire). This is essentially what the current tool already does.
2. **Warm / remarketing** — bands we HAVE worked with who are touring again.
   Highest-conversion segment, entirely ignored by the current tool. Unlocked by
   matching detected tours against the OP address book.
3. **Longitudinal client-activity picture** — every detected tour is recorded against
   the matched band over time, INCLUDING tours they ran without us. Over months this
   becomes a win-back signal ("this band tours the UK twice a year; we did 1 of their
   last 4 tours").

**Design stance:** this is a marketing/outbound workflow, distinct from Operations
(fulfilment) and the Address Book (reference data). But per jon (Jul 2026) it mounts
under the existing **Jobs** submenu as "Leads" rather than a new top-level group —
we can promote it to its own group if marketing efforts scale up. Findings will also
surface on the dashboard/home at a later phase.

## 2. Current state (what exists in `ooosh-tour-finder`)

Standalone Python, SQLite, CLI-only (`python main.py [collect|detect|filter|research|push|status]`).
Five phases:

| Phase | File | What it does |
|---|---|---|
| Collect | `collector.py` | Ticketmaster Discovery API across **24 hardcoded UK venues**, fixed **4-month lookahead** (no lower bound), stores music events. Resolves TM website venue IDs → Discovery API IDs, caches them. |
| Detect | `tour_detector.py` | Groups events by artist, secondary lookup for ALL a band's UK dates, flags a "tour" at **≥3 UK dates within a 6-week window**. Heuristic bin: comedy / DJ / tribute / venues >2,500 cap. |
| Filter (AI) | `ai_filter.py` | Claude (`sonnet-4-5`) scores each artist 1–10 vs the ideal-client profile. **Tier 1** = international flying in (US/Can/Aus/NZ/distant EU — explicitly EXCLUDES FR/BE/NL/DE, who drive their own gear); **Tier 2** = within ~70mi of Shoreham; **Tier 3** = other plausible. Batches of 30. Fragile ```json``` fence-stripping. |
| Research | `contact_researcher.py` | Claude + `web_search` tool hunts management / booking-agent contacts for anything scoring ≥6. Cap 20/run. |
| Push | `main.py` + `output/monday_adapter.py` | Dumps leads to a **Monday.com "Cold Leads" board** (board 2431480012). Checks Monday for an existing client as a throwaway flag. |

Key config today (`config.py`): `EVENT_LOOKAHEAD_MONTHS=4`, `TOUR_MIN_DATES=3`,
`TOUR_WINDOW_WEEKS=6`, `MAX_VENUE_CAPACITY=2500`, `AI_MIN_RELEVANCE_FOR_RESEARCH=6`,
`CONTACT_RESEARCH_DAILY_CAP=20`. Venue list + tier definitions are hardcoded.

**The three gaps this rebuild closes:** no UI, dead destination (Monday), and a
lookahead with no lower bound (which is exactly why it surfaced tours already on the
road). Plus it has zero address-book awareness.

## 3. Target architecture

Port the pipeline into the OP backend as a TypeScript module (`services/leads/*`,
`routes/leads.ts`), Postgres-backed, reusing:
- `config/anthropic.ts` for AI calls (currently the Python tool instantiates its own client).
- The `services/document-extract.ts` **structured-output + prompt-caching** pattern for
  scoring and contact research — replaces the fragile fence-stripping.
- The OP address book (`organisations` / `people`) as both the match source and the
  persistence target.
- (Later) the Gmail auto-chase infra (`chase-draft.ts`, Gmail compose) for outreach drafts.

Ticketmaster stays a direct API (it's not HireHop, so not via the HH broker) — but a
small TS client should reuse the token-bucket rate-limit + daily-budget concept from
the Python `collector.py` (`4/sec`, `4500/day`).

## 4. Where it lives

- **Nav:** Jobs submenu → **"Leads"** (`/jobs/leads` or `/leads` — pick to match the
  existing Jobs child route style). One page, two streams via tabs: **Cold** and
  **Warm (Remarketing)**.
- **Config panel** on the same page (admin/manager) for the tunable knobs (§7) + a
  **"Run search now"** button (background job, returns instantly, results stream in).
- **Scheduled run** weekly via `config/scheduler.ts` so it works with nobody clicking.
- **Dashboard surfacing** (later phase) — a NeedsAttention-style bucket or a Marketing
  card summarising new/high-score leads. Not in v1.

## 5. Data model (new)

Migration number: take the next free at build time (≥163 — check `migrations/run.ts`).
Remember to add the file to the hardcoded list in `run.ts`.

- **`tf_events`** — internal working cache of raw Ticketmaster events (equivalent to the
  Python tool's `events` table). Dedup by `tm_event_id`. Lets detection dedup across runs
  and avoids re-collecting. Fields: `tm_event_id` (unique), `event_name`, `artist_name`,
  `tm_artist_id`, `venue_name`, `venue_city`, `event_date`, `genre`, `subgenre`,
  `discovered_at`. Purely internal — never surfaced to staff.

- **`leads`** — the surfaced, actionable tour-level record (the old `tours` table + a
  lifecycle). One row per detected tour per band per run-window. Fields:
  - Identity: `id` (uuid), `artist_name`, `tm_artist_id`
  - Tour shape: `uk_date_count`, `first_date`, `last_date`, `venues` (jsonb),
    `all_dates` (jsonb)
  - AI scoring: `relevance_score` (int), `client_tier` (1/2/3), `origin_country`,
    `is_international` (bool), `reasoning` (text), `ai_summary` (text — the generated
    band/tour profile)
  - **Match:** `matched_organisation_id` (uuid FK, nullable), `match_confidence`
    (`exact` | `partial` | `none`), `match_candidates` (jsonb — for partial: the
    top few "could this be X?" org suggestions with similarity scores)
  - **Stream:** `stream` (`cold` | `warm`) — derived from match (exact/partial→warm
    candidate, none→cold), but stored so it's filterable and overridable
  - Contacts: `contacts` (jsonb array — research output: type/name/email/phone/source/
    confidence). Promote to a real `lead_contacts` table only if it grows a lifecycle.
  - Lifecycle: `status` (`new` | `reviewing` | `contacted` | `converted` | `dismissed`
    | `not_relevant`), `status_reason`, `assigned_to` (uuid FK users), `converted_job_id`
    (uuid FK jobs, nullable)
  - Provenance: `lead_source` (default `ticketmaster`), `last_run_id`, `created_at`,
    `updated_at`
  - Dedup: a band re-detected on a later run updates its existing lead rather than
    duplicating (upsert on `tm_artist_id` + overlapping tour window). A genuinely new
    tour (new date window) for the same band is a new lead.

- **`lead_runs`** — one row per pipeline run for the UI "last run" stamp + audit.
  Fields: `id`, `triggered_by` (uuid FK users, null for scheduled), `trigger`
  (`manual` | `scheduled`), `started_at`, `finished_at`, `counts` (jsonb — events/tours/
  scored/matched/researched), `status` (`running`|`complete`|`failed`), `error`.

Reuse `interactions` (with a `lead_id`? or anchored to the matched org) + `audit_log`
for the human-action trail rather than a bespoke events table.

## 6. Pipeline (phases)

### Phase 1 — Collect (Ticketmaster)
Port `collector.py`. **Lookahead window fix (§7):** query events in the window
`[today + minLeadWeeks, today + maxHorizon]` — a *lower* bound as well as upper. Store
in `tf_events`.

### Phase 2 — Detect (with window fix)
Port `tour_detector.py`. Group by artist, secondary all-UK-dates lookup, flag tour at
`≥ tourMinDates within tourWindowWeeks`. **Then drop any tour whose FIRST UK date is
before `today + minLeadWeeks`** (already imminent / on the road = too late to sell) —
this is the core fix. Heuristic exclusions unchanged.

### Phase 3 — Score (AI)
Port `ai_filter.py`. Same ideal-client profile + tier logic. Upgrades:
- **Structured output** via json_schema (no fence-stripping).
- **Prompt caching** on the static system prompt (it's identical across every batch).
- Model bump to current (Sonnet 5).

### Phase 4 — Address-book match (NEW — the core rebuild)
For each scored tour, match `artist_name` against `organisations` (band-ish types):
- **Normalise** both sides (lowercase, strip punctuation/whitespace, drop leading "the").
- **Exact** normalised match → `match_confidence='exact'`, link `matched_organisation_id`.
- **Partial** — Postgres `pg_trgm` `similarity()` above a threshold → `match_confidence=
  'partial'`, store top candidates in `match_candidates` as **"could this be [Org]?"**
  suggestions for a human to confirm/reject in the UI. (Enable the `pg_trgm` extension.)
- **None** → `match_confidence='none'`, cold stream.

For exact/confirmed matches, **enrich** the AI summary with what OP already knows: hire
history (`/api/organisations/:id/hire-history`), last-contacted, working terms,
do-not-hire flag. Route to the **Warm** stream. Skip Phase 5 research (we already have
their contacts).

### Phase 5 — Contact research (skip if known)
Port `contact_researcher.py`. **Only runs for cold leads** (no exact/confirmed match) —
saves the web-search spend on bands we already hold contacts for. Structured output +
prompt caching as Phase 3.

### Phase 6 — Persist to OP (replaces Monday push)
- Write/update the `leads` row (always).
- **Warm (matched):** append the generated summary to the band org's **AI Summary /
  AI Research panel** (the placeholder panels already built on org detail — confirm the
  exact column/endpoint at build time). Write as a **dated, sourced block** (e.g.
  `[Lead Finder YYYY-MM-DD] …`) so repeated runs append rather than clobber. Also record
  the observed tour against the org for the longitudinal picture (§9).
- **Cold (new):** do NOT auto-create an organisation. Surface the lead for staff review;
  a "Create band + link" action promotes it into a real `organisations` row when staff
  choose to action it. (Auto-creating pollutes the address book with unvetted names —
  same reasoning as the HH-sync review-queue guard rails.)

### Phase 7 — Outreach draft (LATER, deferred)
Once v1 is proven: for a lead's contact, draft an intro email in Ooosh voice as a
**Gmail draft** (draft-not-send), reusing `chase-draft.ts` + Gmail compose. Turns "here's
a lead" into "here's a lead + a ready-to-send intro." Not in v1.

## 7. Config (staff-editable via `system_settings`, category `leads`)

| Key | Default | Meaning |
|---|---|---|
| `lead_lookahead_min_weeks` | 3 | First tour date must be ≥ this far out (kills already-running/too-imminent tours) |
| `lead_lookahead_max_weeks` | 17 (~4 months) | Upper horizon |
| `lead_tour_min_dates` | 3 | UK dates to count as a tour |
| `lead_tour_window_weeks` | 6 | Dates must fall within this window |
| `lead_min_relevance_score` | 6 | Threshold to surface / research |
| `lead_contact_research_cap` | 20 | Max cold leads researched per run |
| `lead_partial_match_threshold` | 0.4 | pg_trgm similarity floor for "could this be?" suggestions |
| `lead_auto_run_enabled` | true | Toggle the weekly scheduled run |

Monitored venues + tier definitions stay in code/seed for now (jon: won't widen the
net). Could move venues to a DB table later if that changes.

## 8. UI (Jobs → Leads)

- **Two tabs:** Cold / Warm (Remarketing). Each a sortable table: band, tour dates,
  #UK dates, score, tier, origin, match, status.
- **Partial-match affordance:** warm-candidate rows with `match_confidence='partial'`
  show "Possible match: [Org] — Confirm / Reject". Confirming links the org + pulls
  history + fires the enrichment; rejecting drops it to cold.
- **Lifecycle actions** per lead: assign, mark contacted, dismiss / not-relevant (with
  reason), **"Create enquiry from this lead"** (graduates into the existing pipeline as
  a lead source — pre-fills band, contacts, dates), **"Create band + link"** (cold →
  address book).
- **Config panel** (admin/manager) + **"Run search now"** button with a live run status
  (reads `lead_runs`), last-run stamp.
- RBAC: STAFF_ROLES to view/action; config + run trigger to admin/manager.

## 9. Longitudinal client-activity picture (jon's strategic ask)

Every detected tour is persisted against its matched band, so over time OP accumulates
an **observed touring history** per client — independent of whether we did the work.
Value:
- **Win-back detection:** a known band's tour that never converted to an OP/HH job = a
  tour they ran without us → surface as a win-back target.
- **Cadence intelligence:** "tours the UK ~twice a year" informs when to reach out.
- Cheap — it's a by-product of data we're already collecting. Store as the dated blocks
  in the org's AI panel (v1) and/or a light `org_observed_tours` view later if we want
  to report/aggregate on it.

## 10. Modernisation notes (what changed since the original, ~9–10 months ago)

- **Monday.com is gone** — Phase 5 destination moves entirely to OP (biggest change).
- **Structured outputs + prompt caching** replace fragile JSON-fence parsing (reuse
  `document-extract.ts`).
- **Match-before-research** — skip the web-search spend for bands we already know.
- **Model bump** off `sonnet-4-5` to current (Sonnet 5).
- **Close the loop** — `leads.converted_job_id` links a lead to the real HH job it
  became, making the tool measurable (recovered touring work per quarter) and giving a
  feedback signal to tune the profile.
- **Gmail outreach drafting** now possible (didn't exist before) — Phase 7.
- **Data-source widening (Songkick/Bandsintown/more venues)** — explicitly parked; jon
  doesn't expect to need it. Noted only so a future Claude knows it was a deliberate skip.

## 11. Build order

1. Migration (`tf_events`, `leads`, `lead_runs`) + `system_settings` seeds + enable
   `pg_trgm`. Add migration to `run.ts`.
2. Ticketmaster collector (TS port) + detection with the lookahead-window fix.
3. AI scoring (structured output, cached prompt, Sonnet 5).
4. Address-book matcher (exact + partial via pg_trgm) + cold/warm split + warm
   enrichment from hire history.
5. Contact research (cold-only), structured output.
6. Persist: `leads` rows + org AI-summary panel writes + observed-tour recording.
7. UI: Jobs → Leads page (Cold/Warm tabs, config panel, Run button, lifecycle actions,
   confirm-partial-match, graduate-to-enquiry).
8. Scheduled weekly run + `lead_runs` status.
9. *(Later)* Dashboard surfacing.
10. *(Later)* Phase 7 Gmail outreach drafts.

## 12. Out of scope / deferred (deliberate)

- Widening data sources beyond Ticketmaster + the 24 venues.
- Auto-creating address-book records from cold leads (staff-gated create instead).
- Outreach email drafting (Phase 7 — after v1 proves out).
- Dashboard/home surfacing (after v1).
- A dedicated `lead_contacts` table (jsonb on the lead until it earns a table).

## 13. Open items to confirm at build time

- Exact column/endpoint for the org **AI Summary / AI Research** panels (they exist as
  placeholders — confirm the field names).
- Exact next free **migration number** and add to `run.ts`.
- Final **route path** under Jobs (`/jobs/leads` vs `/leads`) to match sibling routes.
- Whether `interactions` gets a `lead_id` anchor or lead-notes hang off the matched org.
