# TOUR-FINDER-SPEC.md — Leads module (Cold + Warm lead discovery)

> **Status (Oct 2026): LIVE under Jobs → Leads.** §1–13 are the original design; §14–19 are
> what was built on top of it, in order. **§20 is the current state and what's left — read
> that first.**

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

## 12. Out of scope / deferred (deliberate) — original list; superseded by §20

- Widening data sources beyond Ticketmaster + the 24 venues.
- Auto-creating address-book records from cold leads (staff-gated create instead).
- Outreach email drafting (Phase 7 — after v1 proves out).
- Dashboard/home surfacing (after v1).
- A dedicated `lead_contacts` table (jsonb on the lead until it earns a table).

## 13. Open items to confirm at build time — all resolved in the v1 build (historical)

- Exact column/endpoint for the org **AI Summary / AI Research** panels (they exist as
  placeholders — confirm the field names).
- Exact next free **migration number** and add to `run.ts`.
- Final **route path** under Jobs (`/jobs/leads` vs `/leads`) to match sibling routes.
- Whether `interactions` gets a `lead_id` anchor or lead-notes hang off the matched org.

## 14. Oct 2026 slice — act on leads, weigh history (BUILT)

Agreed with jon, Oct 2026. Migration 271. Detail in `docs/reference/INTEGRATIONS.md`
("Leads Module").

**Decisions**
- **Scheduled run: NOT wired** — keep it manual for now. `lead_auto_run_enabled` stays seeded and unused.
- **Outreach drafting (§6 Phase 7): parked** — it folds into the auto-chase "voice" work on the
  Enquiries pipeline rather than being a Leads-only build.
- **Exact matching only for automatic links.** The website intake and Leads share one
  exact-email / exact-name resolver (`services/address-book-resolve.ts`). Fuzzy
  matches are only ever suggestions a human confirms ("it's a risk to link without an exact
  match" — jon).
- **Two actions, not one ("option c"):** *Add to address book* (band org + chosen contacts)
  and *Start enquiry* are separate, because most cold leads want saving for later rather than
  an immediate job.
- **Warm = start an enquiry against the known client**, and the AI weighs their history:
  "if we've quoted ten jobs and they've declined them all, not much point sending an 11th".

**Built**
1. Match before score; `history.ts` client history → scorer prompt + lead row. Outcome
   buckets shared with the org Hire History tab (`services/job-outcomes.ts`).
2. Deeper matching: jobs named after the band → their client org (management/agency) as a
   suggestion; researched contacts already in the book (exact email) as "known contacts".
3. Rejected suggestions remembered (`rejected_org_ids`).
4. Dismiss reasons + `lead_suppressions` ("not a fit" never comes back) + Dismissed tab
   with Restore + the previous tour's outcome on the next one.
5. Re-detection by overlapping dates (a dismissed tour stays dismissed when TM adds a date).
6. Per-run search window ("tours starting between X and Y").
7. Add to address book / Start enquiry (OP-native, never pushed to HireHop).

**After deploying:** run **✨ Match & research existing** once. It finds job-name
suggestions on existing leads, fills in client history, and re-scores existing warm leads
with that history (they were scored before matching existed).

## 15. Dashboard surfacing (BUILT, Oct 2026)

A **"Leads to look at"** card in the dashboard's Needs Attention section. It's blue
(informational: an opportunity, not a fault) and hides itself when empty, like the Holding
"Unidentified items" card. The definition is `services/leads/attention.ts`
`getLeadAttention()`, fed into `GET /api/dashboard/operations` as
`needs_attention.leads_to_review(_count)`. Migration 272.

**On the card:** leads still `status = 'new'` whose first UK date is beyond the
`lead_lookahead_min_weeks` floor (a lead ages off once it's too late to sell into), and
- **warm** leads at `lead_min_relevance_score` (the normal minimum — returning bands are the
  best leads), or
- **cold** leads at `lead_dashboard_min_score` (new setting, default 8), so a big search
  doesn't flood the dashboard.

Ordered warm first, then score, then soonest tour. The count is the full total.
Each item deep-links to `/jobs/leads?lead=<id>`, which opens the right tab, expands the lead
and scrolls to it. The param is then dropped from the URL.

**Off the card:** start an enquiry (→ `converted`), dismiss it, or **Mark contacted** (new
row action, `status = 'contacted'`). Mark contacted is for "I've emailed their manager
outside OP": the lead stays on the Leads page, it just stops asking for attention.

## 16. Log outreach, band emails, editable names (BUILT, Oct 2026)

From jon's first real cold reach-out. No migration.

1. **Log outreach** replaces "Mark contacted". It records a note on the lead
   (`status = 'contacted'`, `status_note`), which takes it off the dashboard card. By default it
   also opens a **Cold enquiry** (OP only, never HireHop) through the same
   `createEnquiryFromLead()` as Start enquiry: `enquiry_source = 'cold_lead'`,
   `likelihood = 'cold'`, first chase after 3–21 days (staff choose; default 7),
   `chase_interval_days` set to match, contacts chosen, and an outreach note on the job's
   timeline. So the existing chase model does the follow-up — no new reminder system.
   - The enquiry option needs the band in the address book. The dialog links to "Add them
     first"; without it, it's just a note.
   - The pipeline's existing **Cold** likelihood filter is where these outreach enquiries
     are tracked.
2. **Unanswered outreach is not a loss.** If nobody replies, the 09:00 stale-enquiry
   auto-loser closes the enquiry as "No Decision". In the band's client history
   (`history.ts` `OUTREACH_NO_REPLY_SQL`), a job WE started (`enquiry_source = 'cold_lead'`
   or `leads.converted_job_id` points at it) that was lost as "No Decision" counts as
   `outreach_no_reply`. It is shown, but not counted in `enquiries` or `lost`, and the
   scorer is told not to mark a band down for it. A lead-made enquiry lost for a real
   reason (Price, Competitor…) is still a loss, and so is a client's own enquiry lost as
   No Decision.
3. **Add to address book: editable names + band emails.**
   - Each chosen contact is added as a **person**, under a name staff can edit (required
     for a new person, so nobody ends up called "info"), or saved as the **band's email**.
   - Shared inboxes (`isGenericMailbox()` in `services/address-book-resolve.ts`: info@,
     bookings@, hello@, management@…) default to the band's email.
     `addOrganisationEmail()` sets `organisations.email` if it's empty, otherwise adds
     "Other email: …" to the org notes. It never overwrites an email staff entered.
   - Re-adding contacts to a band the lead itself created keeps `match_via = 'created'`, so
     it doesn't quietly become a warm match.

## 17. Layout for batch working (BUILT, Oct 2026)

jon uses Leads in batches (a search every few weeks, or before a quiet spell) and
wanted better visibility of what's been done and when, and less text at the top.
Migration 277.

- **Tabs by stage**, not cold/warm. The backend's `STAGE_SQL` in `routes/leads.ts` is the
  one definition; rows carry `stage`.
  - **To review:** new or reviewing.
  - **Contacted:** outreach logged, no enquiry.
  - **In pipeline:** an enquiry exists.
  - **Dismissed:** dismissed or not relevant.

  Warm is a filter plus a green badge. To review and Contacted hide tours that have already
  started, with a "show" link.
- **Filters**, kept in the URL and validated on read: search, which search found the lead,
  tour start month, score 6+ / 8+, warm or cold, contacts (has / none / known),
  international, and "no reply in 14+ days" on the Contacted tab.
- **Batches.** `leads.first_run_id` is the search that FOUND the lead; `last_run_id` still
  moves on every re-detection. `GET /leads/runs` lists the last 30 searches with
  `leads_found`. The Search history dialog and the strip's "N new" chip jump to a batch.
- **Activity.** `lead_events` records who did what and when (`services/leads/events.ts`
  `logLeadEvent()`, which never fails the action). Events: found, matched, confirmed,
  rejected, researched, address book, contact added/removed, outreach, enquiry, dismissed,
  restored. They show as the "Last activity" column and a timeline in the expanded row.
  The migration backfills found / enquiry / outreach / dismissed events from existing
  data. `leads.contacted_at` drives the 14-day filter.
- **Header.** One line plus "Run search…" and a ⋯ menu (Refresh, Search history,
  Match & research existing). The run paragraph became a one-line strip with chips. The
  tour rule moved into the Run search dialog. The old banner's "found contacts for N"
  actually meant N *researched*; the strip now says both.

## 18. Contact discovery (BUILT, Oct 2026)

**Who we want** (jon): management, the band directly, and their tour manager. Booking
agents and promoters are the lowest value: they rarely book a tour's worth of vans and
backline, and local promoters already come to Ooosh. The research prompt asks for those
three first and agents only as a last resort, and never returns promoters or venues.
Paid directories were ruled out for the same reason.

- **The band's own links.** `services/leads/links.ts` reads the Ticketmaster attraction's
  `externalLinks` (homepage, socials). When Ticketmaster gives a MusicBrainz id, it also
  reads MusicBrainz's URL relations (homepage, Bandcamp, socials). We never search
  MusicBrainz by name, because it could return the wrong act. MusicBrainz is limited to one
  call per second and sent an identifying User-Agent. The links are stored on
  `leads.external_links`, given to the researcher as starting points, and shown in the
  expanded row so staff can click through.
- **Research tracking.** Each attempt stamps `researched_at` and `research_status`
  (found / none / failed).
  - A lead that came back empty is no longer retried every run (it used to eat the cap). A
    run retries it after 30 days.
  - Runs only research tours that haven't started.
  - The per-run cap went 20 → 40 (20 was a testing number).
- **Research again** (`POST /:id/research`) runs one lead in the background. The page polls
  while `research_status = 'running'`; a mark older than 5 minutes is treated as stuck.
- **Add contacts by hand** (`POST /:id/contacts`, `DELETE /:id/contacts/:idx`). These are
  `manual: true` and survive any re-research; researched duplicates of them, matched by
  email, are dropped. Add to address book treats them like any other contact.

## 19. Jobs for this tour (BUILT, Oct 2026)

Many leads turned out to be tours we'd already quoted, booked or lost. Migration 279
adds `lead_tour_jobs`, and `services/leads/tour-jobs.ts` is the one definition.

- **Window:** a job belongs to the tour if its dates overlap the tour widened by
  **14 days either side**. jon: bands start or finish in the UK around EU legs, and
  rehearsals and collections come before the first date. A job's dates are its out/job date
  to its return/end date.
- **Auto-link:** when the lead is matched to the band's org (by name, confirmed, or created),
  any of that org's jobs in the window are linked. That uses the org Hire History set:
  client or any `job_organisations` role. If the match is via a management company
  (`match_via = 'job_name'`), only that company's jobs named after the band count.
- **Suggest:** a job that's only *named* after the band is suggested, with Yes / Not this one.
- **By hand:** a job can be linked by hand (the band's recent jobs, or a HireHop job number)
  and unlinked. An unlinked job is kept as `rejected`, so automation never re-links it.
- **Refresh:** links are re-synced after matching on every search and re-process, and on
  confirm-match, add-to-address-book and restore. The job's outcome is always read live
  (`TOUR_JOB_OUTCOME_SQL`: open / booked / lost / cancelled / dismissed — a dismissed
  enquiry is an overlay, checked first).
- **What a link does to the lead:**
  - An **open or booked** linked job (`liveTourJobSql()`) moves the lead to **In pipeline**
    (`STAGE_SQL`) and takes it off the dashboard card.
  - Start enquiry and Log outreach-with-enquiry refuse with a 409 ("already a job for this
    tour"), so the pipeline and the band's history never get a duplicate.
  - Only **lost / cancelled / dismissed** jobs leave it in To review with a one-click
    **Dismiss — already quoted**, which records reason `already_handled` and names the jobs.
- **Scoring:** unchanged. The job is already in the band's history once. A linked job isn't
  counted as a Lead Finder "win"; only enquiries made *from* a lead would be (jon, Oct 2026).
- **Dates:** `services/leads/dates.ts` `dateOnly()` reads DATE columns timezone-safely.
  node-postgres returns DATE as local midnight, so `toISOString()` moved summer dates back a
  day on a UK-time server.
- **The reverse link (migration 280):** each linked job gets a system note on its Activity
  Timeline — "🔭 Tour spotted by the Lead Finder: <band> — n UK date(s), <first> to <last> ·
  scored s/10", with a link back to the lead (`/jobs/leads?lead=<id>`). `noteLinkedJobs()`
  writes it once per link (`lead_tour_jobs.job_noted_at`, stamped before writing). Suggestions
  aren't noted until confirmed. Links that already existed are backfilled the next time the
  lead syncs. If a noted job leaves the tour (unlinked on the Leads page, or its dates or
  client no longer match), `noteUnlinkedJob()` adds a closing note and clears the stamp, so a
  re-link notes again. The lead's own enquiry (`converted_job_id`) isn't a tour job and
  already says "Found by the Lead Finder" in its notes.

### 19.1 Date audit (Oct 2026)

jon asked whether the Leads date bug existed elsewhere. Findings:

- **The production server runs in UTC** (Hetzner; noted in `scheduler.ts`, `shop-period.ts`).
  On UTC, a DATE column read by node-postgres is UTC midnight and round-trips through
  `toISOString()` correctly. So the platform-wide DATE parser isn't needed, and is NOT built —
  it would turn every DATE into a string across the codebase for no live gain. The Leads
  `dateOnly()` stays as defence. **Never set `TZ` on the server** without auditing DATE reads.
- **The real gap was "today".** `new Date().toISOString().slice(0, 10)` is the UTC date, which
  between 00:00 and 01:00 BST is still yesterday. That ran in ~65 backend places (late-night
  check-ins and book-outs, deposit and payment dates on HireHop, excess receipts, storage
  move-outs, staff calendar…) and ~45 frontend places (date pickers pre-filled with
  yesterday). All now use ONE helper: backend `services/uk-date.ts` (`ukToday()`,
  `ukDatePlus()`, `ukDateOf()`), frontend `lib/ukDate.ts` (the same three). The older
  copies (`shop-period.londonDate`, `staff-tasks.todayLondon`, `incident-claims.ukDatePlus`,
  `driver-validity.todayYmd`, claims `format.tsx`, `ForwardDateInput.ymdFromToday`) now
  delegate to it.
- **Not changed:** one-off scripts, and "N days ago" sums like
  `new Date(Date.now() - 30 * 86400000).toISOString()` (an hour's drift on a 30-day range is
  harmless). SQL `CURRENT_DATE` is also the database's UTC date. Making the DB session
  Europe/London would fix that, but it would also change `timestamp`-without-zone writes, so
  it needs its own look if it ever matters.

## 20. Current state and what's left (Oct 2026)

**Built and live (§14–19):**
- Ticketmaster search with a per-run window, AI scoring that weighs OOOSH history, and
  matching three ways: org name, jobs named after the band, known contacts.
- Stage tabs, filters and batches, Search history, and an activity log per lead.
- Contact research: management, band and tour manager first; the band's own links as
  starting points; dead ends tracked; Research again; contacts added by hand.
- Add to address book (editable names, shared inboxes saved as the band's email), Start
  enquiry, and Log outreach (a chased Cold enquiry).
- Unanswered outreach isn't counted as a loss.
- Dismiss reasons with suppression, a dashboard card, and jobs for this tour (with a note on
  each linked job's timeline).
- Platform date audit: "today" is the UK day everywhere (§19.1).

**Deliberately not built (decisions):**
- **Scheduled weekly run** — jon wants searches run by hand (batches before quiet spells).
  `lead_auto_run_enabled` is seeded but unwired. To build it: a node-cron entry calling
  `createRun(null, 'scheduled')` + `runPipeline()`, gated on the setting.
- **Promoters, booking agents and paid directories** as contact sources — the wrong people
  for touring work.
- **Agency grouping** — same reason.
- **Lead Finder "wins" reporting** — not asked for. If it's built, count only enquiries made
  FROM a lead (`converted_job_id`), never linked tour jobs.

**Open / next candidates:**
- **Outreach email drafting** (§6 Phase 7) — folds into the auto-chase "voice" work on the
  Enquiries pipeline (AUTO-CHASE-SPEC) rather than being built separately.
- **MusicBrainz value check** — jon expects little from it. Look at how often `external_links`
  carries MusicBrainz-only links; drop it if it adds nothing.
- **SQL `CURRENT_DATE` in UK terms** — only if a midnight–1am BST edge ever bites (§19.1).

