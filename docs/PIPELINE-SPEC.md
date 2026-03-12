# Enquiry & Sales Pipeline — Implementation Spec

**Version 1.0 • March 2026**
**Module 3.3 from SPEC.md — detailed build spec**

---

## 1. Overview

The Enquiry & Sales Pipeline replaces the Monday.com Quotes board entirely. It is the **front door for every enquiry** — all potential work starts here, regardless of whether it ever reaches HireHop. HireHop remains the workshop for building quotes and managing equipment; this system manages the sales conversation, chase cycle, and progression tracking that HireHop cannot do.

### Core Principle

**Ooosh first, HireHop second.** Every enquiry is logged in Ooosh. When ready to quote, a job is pushed to HireHop. HireHop job data syncs back automatically. Status changes in Ooosh push to HireHop where applicable.

### Who Uses This

Staff only. No freelancer or client visibility into the pipeline.

---

## 2. Pipeline Statuses (Kanban Columns)

These are **Ooosh-owned statuses** representing the sales conversation lifecycle, distinct from HireHop's equipment statuses.

| # | Pipeline Status | Description | HireHop Action |
|---|----------------|-------------|----------------|
| 1 | **New Enquiry** | Just logged — not yet assessed or quoted. May or may not have a HireHop job. | None (HH job may not exist yet) |
| 2 | **Quoting** | Actively building or have sent a quote. HH job exists (or gets created at this point). | Create HH job if not exists |
| 3 | **Chasing** | Quote sent, awaiting client response. Active follow-up cycle. | None |
| 4 | **Paused Enquiry** | We want to keep this alive but can't progress right now. Reasons: under minimum terms (e.g. van < 4 days, > 2 weeks out), fully booked, client undecided, too early to confirm. | None |
| 5 | **Provisional** | Client wants to go ahead. We are holding/reserving assets in HireHop, awaiting deposit, PO, or payment to confirm. These MUST be chased — holds can't sit indefinitely. | Push status 1 (Provisional) to HH |
| 6 | **Confirmed** | Confirmed via deposit, full payment, PO, or manual override. | Push status 2 (Booked) to HH |
| 7 | **Lost** | Didn't go ahead. Reason captured (built out as separate feature — see Section 10). | Push status 9 (Cancelled) or 10 (Not Interested) to HH |

### Movement Rules

- **No enforced linear progression.** Any status can move to any other status.
- Moving backwards is expected and common (e.g. Provisional → Quoting when a client goes quiet and we release the hold).
- Every status transition is logged as an interaction on the job timeline, including who moved it and why.
- Transitions that map to HireHop statuses trigger an automatic push to HH.
- Provisional jobs that haven't been chased within X days should surface warnings (configurable).

---

## 3. Data Model

### 3.1 New Pipeline Fields on `jobs` Table

A new migration adds these columns to the existing `jobs` table. This keeps everything as one entity rather than creating a separate `opportunities` table — a job/enquiry is the same thing at different stages of life.

```sql
-- Pipeline status & tracking
pipeline_status      VARCHAR(30) DEFAULT 'new_enquiry'    -- Kanban column
pipeline_status_changed_at  TIMESTAMPTZ                   -- When status last changed
quote_status         VARCHAR(30)                          -- not_quoted / quoted / revised / accepted
likelihood           VARCHAR(10)                          -- hot / warm / cold

-- Chase tracking
chase_count          INTEGER DEFAULT 0                    -- Auto-incremented on chase interactions
last_chased_at       TIMESTAMPTZ                          -- Auto-set when chase logged
next_chase_date      DATE                                 -- When to follow up next
chase_interval_days  INTEGER DEFAULT 3                    -- Default chase frequency for this enquiry

-- Pause/hold context
hold_reason          VARCHAR(50)                          -- Preset reason for Paused Enquiry
hold_reason_detail   TEXT                                 -- Freeform detail

-- Confirmation
confirmed_method     VARCHAR(30)                          -- deposit / full_payment / po / manual
confirmed_at         TIMESTAMPTZ                          -- When confirmed

-- Financial
job_value            DECIMAL(12,2)                        -- From HireHop MONEY field or manual entry

-- Lost (basic — full win/loss system built separately)
lost_reason          VARCHAR(50)                          -- Brief reason code
lost_detail          TEXT                                 -- Freeform
lost_at              TIMESTAMPTZ

-- Source tracking
enquiry_source       VARCHAR(30)                          -- phone / email / web_form / referral / cold_lead / forum
```

### 3.2 Pipeline Status Values

```
new_enquiry      — New Enquiry
quoting          — Quoting
chasing          — Chasing
paused           — Paused Enquiry
provisional      — Provisional
confirmed        — Confirmed
lost             — Lost
```

### 3.3 Quote Status Values

```
not_quoted       — Not Yet Quoted
quoted           — Quoted
revised          — Revised Quote
accepted         — Accepted
```

### 3.4 Hold Reason Presets

```
under_minimum    — Under minimum terms (e.g. < 4 days, too far out)
fully_booked     — Fully booked for requested dates
client_undecided — Client hasn't decided yet
too_early        — Too early to confirm
other            — Other (see detail)
```

### 3.5 Likelihood Values

```
hot              — Very likely to go ahead
warm             — Reasonable chance
cold             — Unlikely but worth keeping
```

### 3.6 Confirmed Method Values

```
deposit          — Deposit received
full_payment     — Full payment received
po               — Purchase order received
manual           — Manually confirmed (edge cases)
```

### 3.7 Enquiry Source Values

```
phone            — Phone call
email            — Email
web_form         — Website enquiry form
referral         — Referred by someone
cold_lead        — Cold outreach / Ticketmaster lead
forum            — Forum / social media
repeat           — Returning client
other            — Other
```

### 3.8 Allowing Ooosh-Native Enquiries

Currently `hh_job_number` has a UNIQUE constraint and jobs are only created via HireHop sync. To support enquiries that start in Ooosh before HireHop:

- `hh_job_number` becomes **nullable** (already INTEGER, just drop NOT NULL if present)
- Jobs with `hh_job_number = NULL` are Ooosh-native enquiries not yet pushed to HireHop
- Once pushed, the HH job number is stored and normal sync takes over
- The existing sync service skips jobs that already have a matching `hh_job_number` (no conflict)

---

## 4. Interaction Type: Chase

### 4.1 New Interaction Type

Add `'chase'` to the interaction types alongside existing `note`, `call`, `email`, `meeting`.

A chase is a specific, distinct action: **"I contacted the client to ask them to make a decision."** It is not a general discussion about job scope or requirements — those are calls/emails/notes.

When logging a chase, the user provides:
- **Chase method:** How they chased (phone, email, text, WhatsApp)
- **Content:** What was said / what happened
- **Response:** Did they get through? Any response? (optional quick field)
- **Next chase date:** Auto-populated from `chase_interval_days` but editable

### 4.2 Automatic Side Effects

When a chase interaction is created on a job:
1. `chase_count` increments by 1
2. `last_chased_at` set to now
3. `next_chase_date` set to `today + chase_interval_days` (unless manually overridden in the interaction)
4. The `job_status_at_creation` field captures current pipeline_status (already exists on interactions)

### 4.3 Chase on Provisional Jobs

Provisional holds MUST be chased. The system treats provisional jobs with overdue `next_chase_date` as high priority — these are tying up equipment that could be hired elsewhere.

---

## 5. Kanban Board UI

### 5.1 Layout

The Kanban board is the primary view of the pipeline. Accessed via main navigation as "Pipeline" or "Enquiries".

**Columns:** One per pipeline status (see Section 2), laid out left to right.

**Each column shows:**
- Column header with status name and count of cards
- Total pipeline value for that column (sum of `job_value`)
- Cards sorted by `next_chase_date` (soonest first), then by `created_at`

**Pipeline summary bar (top of page):**
- Total pipeline value across all active stages (excl. Confirmed and Lost)
- Count of jobs per stage
- "Due to chase today" count (highlighted)
- "Overdue chases" count (red)

### 5.2 Job Cards

Each card on the board shows at a glance:

```
┌──────────────────────────────┐
│ J-1234  ·  £2,400            │  ← HH job # (or "NEW") + value
│ Backline for Band X          │  ← Job name
│ Festival Productions Ltd     │  ← Client
│ 15–18 Jun 2026               │  ← Job dates
│                              │
│ 🔥 Hot  ·  Chased x3        │  ← Likelihood + chase count
│ Chase due: Tomorrow          │  ← Next chase date (amber/red if overdue)
│ JB                           │  ← Manager initials
└──────────────────────────────┘
```

- Cards with overdue chase dates have a red left border
- Cards due today have an amber left border
- Likelihood shown as coloured indicator (Hot = red/orange, Warm = amber, Cold = blue)
- Jobs without a HH job number show "NEW" instead of job number
- Chase count shown as badge (e.g. "x3")

### 5.3 Drag and Drop

Cards can be dragged between columns to change pipeline status.

**On drop:**
1. Update `pipeline_status` and `pipeline_status_changed_at`
2. Log a status transition interaction on the job timeline
3. If moving to Provisional → prompt for HH status push (status 1)
4. If moving to Confirmed → prompt for confirmed_method (deposit/payment/PO/manual), then push HH status 2
5. If moving to Lost → prompt for lost_reason (basic — full system later)
6. If moving to Paused Enquiry → prompt for hold_reason
7. If moving to Quoting and no HH job exists → offer to create one in HireHop

**Moving backwards:**
- Provisional → Quoting: "Release hold in HireHop?" → push HH status back to 0 (Enquiry)
- Any backward move logs the reason in the transition interaction

### 5.4 Filters

- **Manager:** Filter by assigned manager
- **Likelihood:** Hot / Warm / Cold
- **Date range:** Job dates within range
- **Chase status:** Overdue / Due today / Due this week / All
- **Has HH job:** Yes / No (to find Ooosh-only enquiries)

### 5.5 Alternative Views

- **Kanban** (default) — drag-and-drop board
- **List view** — table format with sorting, same as current JobsPage but filtered to pipeline
- Toggle between views, filters persist

---

## 6. New Enquiry Form

Quick-capture form for logging incoming enquiries. Designed to be fast — 10 seconds for the basics.

### 6.1 Required Fields

- **Client:** Pick from address book (search people/organisations) OR create new inline
- **What they want:** Free text (e.g. "3x sprinter vans + backline")
- **Job dates:** Start and end date

### 6.2 Optional Fields (expandable section)

- **Job name:** Auto-generated from client + dates if not provided
- **Venue:** Pick from venues or enter free text
- **Enquiry source:** Phone / Email / Web form / Referral / etc.
- **Estimated value:** Manual entry (before HH quote exists)
- **Likelihood:** Hot / Warm / Cold (default: Warm)
- **Notes:** Freeform
- **Manager:** Assign to team member (default: current user)

### 6.3 Post-Creation Actions

After saving, the user is offered:
- **"Quote Now"** → Creates job in HireHop, moves to Quoting, opens HH job link
- **"Save & Stay"** → Stays in New Enquiry for later action
- Card appears on Kanban immediately

---

## 7. Chase Dashboard / Alerts

### 7.1 Pipeline Dashboard Widgets

Shown on the main Dashboard page and/or as a dedicated Pipeline dashboard:

- **Due to chase today** — list of jobs with `next_chase_date = today`, sorted by value
- **Overdue chases** — `next_chase_date < today`, flagged red, sorted by how overdue
- **Provisional holds** — all Provisional jobs with days held and chase status
- **Pipeline value by stage** — bar or summary showing £ per column
- **Conversion funnel** — New → Quoting → Chasing → Confirmed (counts and rates)
- **Recently lost** — last 5 lost enquiries with reasons

### 7.2 Notification Triggers (for later)

- Chase is overdue by > 1 day → in-app notification
- Provisional hold > 7 days without chase → warning
- New enquiry not actioned within 24 hours → alert

---

## 8. HireHop Integration Points

### 8.1 Push: Ooosh → HireHop

| Trigger | HireHop Action | API |
|---------|---------------|-----|
| "Quote Now" / move to Quoting (no HH job) | Create new job in HireHop | `POST /api/job_save.php` |
| Move to Provisional | Set HH status to 1 (Provisional) | `POST /frames/status_save.php` |
| Move to Confirmed | Set HH status to 2 (Booked) | `POST /frames/status_save.php` |
| Move to Lost | Set HH status to 9 or 10 | `POST /frames/status_save.php` |
| Revert from Provisional | Set HH status to 0 (Enquiry) | `POST /frames/status_save.php` |

All HH writes include `no_webhook=1` to prevent loops.

### 8.2 Pull: HireHop → Ooosh (existing sync, enhanced)

- Existing job sync continues to pull active HH jobs
- New/updated HH jobs that don't have pipeline fields get `pipeline_status = 'new_enquiry'`
- `job_value` populated from HireHop `MONEY` field
- Jobs already in Ooosh with pipeline data: HH sync updates equipment fields but **does not overwrite** pipeline fields

### 8.3 Sync Conflict Resolution

- **Pipeline fields are Ooosh-owned:** HH sync never overwrites pipeline_status, chase fields, likelihood, etc.
- **Equipment/status fields are HH-owned:** HH sync updates job_name, dates, HH status, client, venue, value
- **HH status vs pipeline_status coexist:** A job can be HH status 2 (Booked) and pipeline_status "confirmed" — they're tracking different things

---

## 9. API Endpoints (New)

### 9.1 Pipeline Endpoints

```
GET    /api/pipeline                    — List jobs with pipeline data, filterable
GET    /api/pipeline/stats              — Aggregated pipeline stats (values, counts, overdue)
GET    /api/pipeline/chase-due          — Jobs due for chasing today/overdue
POST   /api/pipeline/enquiry            — Create new Ooosh-native enquiry
PATCH  /api/pipeline/:id/status         — Update pipeline status (with transition logging)
PATCH  /api/pipeline/:id                — Update pipeline fields (likelihood, chase date, etc.)
POST   /api/pipeline/:id/push-hirehop   — Create/update job in HireHop from Ooosh data
```

### 9.2 Interaction Endpoint Update

```
POST   /api/interactions                — Existing, but now supports type: 'chase'
                                          with auto chase_count/date side effects
```

---

## 10. Lost Reason / Win-Loss Tracking

**Deferred to separate feature build.** For now, moving to "Lost" captures:
- `lost_reason` — simple preset: Price / Availability / Competitor / Timing / No Decision / Cancelled Event / Other
- `lost_detail` — freeform notes
- `lost_at` — timestamp

The full win/loss analysis dashboard, trend reporting, and structured loss workflows will be specced and built as a follow-on feature.

---

## 11. Build Order

### Phase A — Data Layer
1. Migration: Add pipeline fields to `jobs` table
2. Migration: Make `hh_job_number` nullable
3. Add `'chase'` to interaction types
4. Update HireHop job sync to pull `MONEY` → `job_value`
5. Set default `pipeline_status = 'new_enquiry'` for all existing jobs

### Phase B — Backend API
6. Pipeline list/filter endpoint with stats
7. Pipeline status update endpoint (with transition logging)
8. New enquiry creation endpoint (Ooosh-native jobs)
9. Chase interaction logic (auto-increment, auto-date)
10. Chase-due/overdue query endpoint

### Phase C — Frontend: Kanban Board
11. Kanban board component with columns and cards
12. Pipeline summary bar
13. Drag-and-drop between columns with status prompts
14. Card design (value, dates, chase count, likelihood, overdue indicators)
15. Filters (manager, likelihood, chase status, date range)

### Phase D — Frontend: Supporting UI
16. New Enquiry form (quick capture)
17. Chase logging UI (on job detail page and quick-action from card)
18. Pipeline dashboard widgets (chase due, overdue, value by stage)
19. Job detail page: add pipeline fields display and edit

### Phase E — HireHop Write-Back
20. Push status changes to HireHop (Provisional, Confirmed, Lost, revert)
21. Create new HH job from Ooosh enquiry ("Quote Now")
22. Ensure sync doesn't overwrite pipeline fields

---

## 12. Future Enhancements (Not In This Build)

- Auto-chase email system (automated follow-up emails on schedule)
- Website enquiry form integration (enquiries land directly into pipeline)
- Win/loss analysis dashboard
- Seasonal outreach campaigns
- Cold lead finder (Ticketmaster API)
- Quote versioning
- Payment portal integration (deposit → auto-confirm)
- Time-to-quote tracking and SLA alerts
