# Rehearsals / Studio Sitter Module — Spec

**Status:** Draft for build (Jun 2026). Supersedes the stub "Stream 5: Rehearsals Module"
in CLAUDE.md. Replaces the Monday-era studio-sitter workflow and the end-of-day Jotform
(form `203154178314046`).

**One-line:** OP detects a rehearsal on a HireHop job, works out which **evenings** need a
studio sitter, lets staff rota an approved freelancer onto each evening (one sitter per site
per night), flows that to the freelancer portal in the same way a driving job does, and gives
sitter ⇄ staff a shared notes/handover thread plus a configurable end-of-day lock-up report.

---

## 0. The load-bearing principle — the assignment unit is a SITE-EVENING, not a job-room-day

Ooosh runs **one rehearsal premises** (a single building: Room 1 + Room 2 upstairs, downstairs
desk/stockroom, vans, safe, gates). The studio sitter's job is twofold:

1. **Look after the band(s) in Room 1 and/or Room 2** for the evening, and
2. **Close up the whole building** at the end of the night (the end-of-day checklist).

Therefore **we only ever need one sitter per evening**, even if both rooms have a band in.

This reshapes the obvious "sub-cards under each job" model. The thing you assign a freelancer
to is a **`studio_sitter_shift` = one calendar evening that needs cover** (site-wide, singular
building). Gary Numan in Room 1 + another band in Room 2 on the same night = **one shift, one
sitter**. The end-of-day report is **per-shift (per-evening)**, not per-job.

The per-job rehearsal requirement card still shows *that job's* evening dates, but each date
only **reflects** the shared site-shift's coverage. Assigning from a job card assigns the
site-evening shift (and visibly covers the other room too). The primary rota surface is a
central **Studio Sitter roster** page.

The shift derives "who's in tonight" (Room 1: Gary Numan; Room 2: …) from the jobs whose
rehearsal occupancy overlaps that date — **derived at read-time, not stored** (HireHop stays the
source of truth for what's booked).

---

## 1. Scope

**In scope:**
- HH detection of rehearsal rooms + flavour (daytime / evening / lockout), per room.
- Deriving the evenings that need a sitter from the job's rehearsal date range (with the
  rehearsal-specific end-date rule in §3).
- `studio_sitter_shift` roster: one per evening, assignable to an approved freelancer with the
  Studio Sitter tag; reassignable; bulk-assignable.
- Freelancer portal surface for sitters (their shifts, who's in each room, shared specs/files,
  handover thread, their tasks, end-of-day report, lost-property / held-items deep links).
- Per-job rehearsal requirement card as a read-reflection + amber pre-hire warning.
- A general **Tasks** system (building/ad-hoc jobs, not only rehearsals) with visibility +
  notify-on-done / notify-if-not-done, surfaced on the dashboard + On Today + sitter portal.
- End-of-day lock-up report (configurable, soft, no PDF) ported from the Jotform, notes flowing
  into the shift thread.

**Out of scope (deferred, noted in §16):**
- **Shop / ad-hoc sales by sitters** (price lookup + add-to-bill + Worldpay) — substantial in its
  own right, crosses well beyond rehearsals. Manual for now ("have clients paid? card receipt in
  till" stays a note).
- Per-room "booking ended" granularity (v1 treats end-of-booking deep-clean at site level).
- Multi-site (only one premises today).
- Calendar view itself (a separate future project) — but we expose a clean endpoint for it (§14).

---

## 2. HireHop detection

Detection runs in `services/hh-requirement-derivation.ts`, extending the existing
`has_rehearsal` path. **Match on `CATEGORY_ID === 450 AND LIST_ID IN (known ids)`** (the carnet
stock-namespace lesson — never `LIST_ID` alone).

### Room + flavour classification (verified from stock export, Jun 2026)

| LIST_ID | Room | Flavour | Sitter needed? |
|---|---|---|---|
| 834 | Room 1 — base (day rate, prep 45m) | — (component) | n/a — see base-room rule |
| 853 | Room 1 — DAYTIME (hourly) | daytime, ≤17:00 | **No** (staff on site) |
| 854 | Room 1 — EVENING (hourly) | runs late | **Yes** |
| 851 | Room 1 — LOCKOUT (full day) | full day, runs late | **Yes** |
| 835 | Room 2 — base (day rate, prep 35m) | — (component) | n/a — see base-room rule |
| 856 | Room 2 — DAYTIME (hourly) | daytime, ≤17:00 | **No** |
| 857 | Room 2 — EVENING (5pm–10pm) | evening | **Yes** |
| 855 | Room 2 — LOCKOUT (full day) | full day, runs late | **Yes** |

**Sitter-needed flavour rule:** `EVENING` or `LOCKOUT` ⇒ evening cover needed. `DAYTIME` ⇒ no
sitter (staff here till 17:00).

**Manual daytime override.** Occasionally (short-staffed weekend, both rooms in) staff want a
sitter in for a **daytime** shift too. Neat, non-cluttered affordance, no new surface:
- On the job card, a daytime row shows a subtle text link **"＋ Call a sitter for this day"**.
- On the roster, any date carries a subtle **"＋ Add cover"**.
Either creates a `studio_sitter_shift` with `manual_override = true` (optional reason). Such a
shift behaves exactly like an auto one (assignable, reflected on the card, counts toward
coverage). Removing it cancels the manual shift. This is the ONE way `needs_sitter` gets forced
on — auto-detected evenings are never toggled off this way; genuinely-not-running days are handled
by **dismiss** (§3), so the two controls stay distinct and uncluttered.

**Base-room rule (avoids double-count):** the base room (834/835) appears as a **nested child**
of a chosen variant (e.g. on job 14996 the LOCKOUT parent has "Rehearsal Room 1" as its child —
the `▶` parent/child / `LFT`/`RGT` nesting). Classify off the **parent variant** and treat the
base room as an informational component, never its own session. A **bare base-room with no
variant** on the job = `needs_review` (amber on the card) for staff to classify the flavour
manually — don't guess sitter-need.

The derivation continues to populate `flags.has_rehearsal`, the rehearsal prep time
(`preptimemins`, used for room turnaround display), and creates/maintains the existing
`rehearsal` requirement card. New: it also records, per detected room, `{ room, flavour,
sitter_needed }` so the card and shift-derivation can act on it.

---

## 3. Rehearsal date / time model — **the timing gotcha**

> **Sibling to the `return_date +1 buffer` gotcha in CLAUDE.md. Read before touching
> rehearsal date logic.**

Vehicles + backline run **9am → 9am** (OP's default overnight/turnaround convention). **Rehearsals
do NOT** — a rehearsal *finishes on the day it finishes*. The HH job header still gets entered with
the 9am-next-morning convention, so the displayed end date is a **phantom day** for rehearsals.

**Worked example (job 14996, Gary Numan, Room 1 LOCKOUT):** HH shows `10 Jul 09:00 → 16 Jul 09:00`.
The *real* occupancy is **10:00 on the 10th → 22:00 on the 15th**. The 16th is the 9am-rollover
phantom — nobody rehearses then.

**Session-day derivation rule (rehearsal-specific — do NOT reuse the generic window):**
- **First session day** = `out_date` / `job_date` day (e.g. 10th). ✓ trustworthy.
- **Last session day** = if `job_end` time-of-day is an early-morning rollover (≤ ~12:00), then
  `job_end_date − 1`; otherwise `job_end_date`. (So `16 Jul 09:00` → last evening = 15th; a job
  genuinely entered as `15 Jul 22:00` → 15th directly.)
- **Default nightly window:** evening flavour ~17:00–22:00; lockout ~10:00–22:00; the sitter's
  shift **envelope** is the band's window (earliest start needed → latest end across rooms that
  night). Staff can adjust the envelope per shift.
- Expand `[first_session_day .. last_session_day]` into one candidate evening per day; drop
  daytime-only days; staff may **dismiss** any day that isn't really running (the unlikely
  Mon/Wed/Fri gap case). Each remaining evening that has at least one EVENING/LOCKOUT room ⇒ a
  `studio_sitter_shift` for that date.

Naive `job_date..job_end` expansion would create a dead shift on the phantom day — the `−1` rule
prevents it; manual dismiss is the safety net.

---

## 4. Data model

Migrations: **use the next free numbers at build time — check `backend/src/migrations/run.ts`
and the `migrations/` dir; do NOT assume a number.** Head was 149 at spec time and **150 is
already being taken by parallel work**, so this module will land at ~151+. All soft-state (status
flips, no hard deletes), consistent with the rest of the platform.

### 4.1 `studio_sitter_shifts` — the assignment unit (one per site-evening)
```
id                UUID PK
shift_date        DATE NOT NULL UNIQUE        -- one shift per calendar evening (single site)
planned_start     TIME                        -- envelope (earliest needed across rooms)
planned_end       TIME                        -- envelope (latest needed)
status            VARCHAR  -- 'needed' | 'assigned' | 'confirmed' | 'covered' | 'closed' | 'cancelled'
manual_override   BOOLEAN DEFAULT false        -- true = staff forced cover on an otherwise not-needed day (e.g. daytime)
override_reason   TEXT                          -- optional, for manual_override shifts
notes             TEXT                         -- staff planning notes (thread is separate)
report_answers    JSONB                        -- end-of-day report (snapshot of template + answers)
report_template_version INT                    -- which checklist template was answered
report_submitted_by UUID REFERENCES people(id)
report_submitted_at TIMESTAMPTZ
created_at / updated_at
```
`needed` = no sitter yet. `covered`/`closed` after the night. Room/band occupancy is **derived
at read-time** from jobs with rehearsal occupancy on `shift_date` — not stored.

### 4.2 `studio_sitter_shift_assignments` — mirrors `quote_assignments`
```
id                UUID PK
shift_id          UUID REFERENCES studio_sitter_shifts(id)
person_id         UUID REFERENCES people(id)   -- approved freelancer, Studio Sitter tag surfaced
status            VARCHAR  -- 'assigned' | 'confirmed' | 'declined' | 'cancelled'
assigned_by       UUID REFERENCES people(id)
confirmed_at      TIMESTAMPTZ
fee               NUMERIC                       -- optional; mirrors freelancer pay if we use it
created_at / updated_at
```
One active (`assigned`/`confirmed`) row per shift (one sitter). Reassignment = cancel the active
row + insert a new one (keeps decline/history audit, same as `quote_assignments`). Assignment
flows to the portal in the same way a driving job does.

### 4.3 `tasks` — general ad-hoc / building jobs (NOT only rehearsals)
```
id                UUID PK
title             TEXT NOT NULL
detail            TEXT
visibility        VARCHAR  -- 'everyone' | 'assignee_only'
created_by        UUID REFERENCES people(id)
assigned_to       UUID REFERENCES people(id)    -- nullable (unassigned / pool); self-task = creator
shift_id          UUID REFERENCES studio_sitter_shifts(id)  -- nullable anchor
job_id            UUID REFERENCES jobs(id)                   -- nullable anchor
due_date          DATE
notify_on_done    BOOLEAN DEFAULT false
notify_not_done_after_days INT                  -- nullable; daily scan nudges creator if still open
status            VARCHAR  -- 'todo' | 'done' | 'cancelled'
done_by           UUID REFERENCES people(id)
done_at           TIMESTAMPTZ
created_at / updated_at
```
See §10 for the full Tasks behaviour.

### 4.4 Interactions anchors (messaging / handover)
Add `shift_id UUID` (and, for task comments, reuse the existing polymorphic anchor or add
`task_id UUID`) to `interactions`, mirroring the `issue_id` / `held_item_id` pattern. Add the
**`issue_id IS NULL`-style scoping guard** so shift/task chatter does **not** bubble onto the
linked person / job / org timelines.

### 4.5 Configurable end-of-day checklist + reference images
Store in `system_settings` (category `studio_sitter`) as JSON — editable without a deploy (same
approach as the OOH-returns settings). `report_template_version` on the shift records which
version was answered; answers snapshot at submit. Includes the "how the rooms should look"
reference photos (R2 keys) shown to the sitter.

**No new per-job table** — the per-job rehearsal day breakdown is derived from line items + job
dates (§3) + the shift roster at read-time.

---

## 5. Per-job rehearsal requirement card (read-reflection + amber)

The existing `rehearsal` `job_requirements` card is enhanced to render:
- The job's rooms + flavour ("Room 1 — Lockout", prep 45m).
- A row per evening this job touches (from §3), each showing the **shared site-shift's**
  coverage: `Thu 10 Jul — sitter: Dave ✓` / `⚠ unassigned` / `Sam (awaiting confirm)`.
- Daytime-only jobs → green "Daytime only — no sitter required".
- `needs_review` (bare base room) → amber "Confirm rehearsal flavour".
- Status feeds the **pre-hire progress strip** (§ job-progress-strip): `done` only when every
  sitter-needed evening this job touches has a **confirmed** sitter; `in_progress`/amber
  otherwise.
- Clicking a date opens/assigns the site-evening shift; a "Manage on roster →" deep-link to the
  Studio Sitter roster (the carnet "manage in Operations" pattern).

**Amber pre-hire warning** (via the existing `JobAlertBanner`): "Rehearsal starts in 5 days — no
studio sitter for Thu 10 / Fri 11". Configurable lead days (`system_settings`).

---

## 6. Studio Sitter roster (operations surface)

New page (Operations nav → "Studio Sitters", or under a "Rehearsals" group). The rota.
- **List of upcoming evenings** (default next 14 days, range presets), one row per
  `studio_sitter_shift`.
- Per row: date, **rooms/bands in that night** (derived — "R1: Gary Numan · R2: Foo"), envelope
  times, **assigned sitter + status**, assign/reassign control.
- **Assign picker:** approved freelancers (`is_freelancer AND is_approved`), **Studio Sitter tag
  surfaced** at pick time (reuse existing freelancer tag + `GET /api/people/skills`); searchable.
- **Bulk-assign:** "assign all unassigned evenings in range to [person]" (your two-people-cover-
  the-week case).
- **＋ Add cover (manual):** on any date, force a shift for a day that wasn't auto-flagged (the
  daytime-override case, §2) — `manual_override=true`, optional reason.
- **Reassign:** person A → person B in one action (cancel + new assignment, audit-logged).
- Filter pills: needs-sitter / assigned / confirmed; range presets 7/14/28.
- Deep-links: band → Job Detail; date → shift detail.

---

## 7. Freelancer portal surface

A **new portal area** for studio sitters, on the same framework as the driving-job portal but
materially different content. Sitter assignments **union into the portal jobs list** so they
appear alongside any driving work the person also does.

**Shift detail (portal):**
- Date + envelope times; **who's in** (R1/R2 bands), with each band's session times.
- **Shared specs / stage plots / files** — reuse the existing `share_with_freelancer` flag; job
  files + venue files flagged shared surface here exactly as they do for drivers. No new
  mechanism.
- **Handover thread** (§11) — yesterday's sitter's notes + staff messages, replyable.
- **Their task list** for the shift (§10) — tickable.
- **End-of-day report** (§12).
- **Lost property + held items** deep-links into the Holding module (reuse `/quick` style entry,
  scoped to the shift/site).

Accountability/notifications respect `portal-notification-prefs` (informational vs accountability
classes) exactly as the driving flow does.

---

## 8. Tasks system (general — built as part of this module)

The ad-hoc "things to do" layer (cables need cleaning, drum carpets need de-taping, buy milk,
call recycling). Often these are the low-level jobs left to evening sitters, hence built here, but
the entity is **general** (anchorable to a shift, a job, or nothing).

**Behaviour:**
- **Visibility:** `everyone` (shows on shared task views) vs `assignee_only` (only creator +
  assignee). Self-tasks supported (assign to yourself).
- **Notify-on-done:** optional — when ticked, notify the creator (+ watchers).
- **Notify-if-not-done-after-X-days:** optional — a daily scan nudges the creator if still `todo`
  after X days. (Accountability.)
- **Default = notify the assignee**, with the **channel depending on recipient type**:
  - **Staff assignee** → bell notification (+ email escalation per their existing notification
    prefs / the inbox escalation rules).
  - **Freelancer assignee (e.g. a studio sitter)** → **no bell, no email** — it surfaces **only in
    their portal shift view**. (Freelancers have no bell; email is overkill for a "peel the tape
    off the carpets" task.)
- **Tick-when-done** with optional undo (toast), consistent with the inbox/notification UX.
- **Threaded comments** via interactions anchored to the task (§4.4) — so a task can carry a
  short conversation.

**Surfaces:**
- **Staff input lives on the dashboard, top-right** — a **"Tasks" card** in the NeedsAttention
  secondary row (same zone as Overdue Transport / Recharges to Resolve). Quick-add + my open
  tasks + things I'm watching.
- **Due-today tasks** flow into the existing **"On Today"** strip (its payload is already generic
  — union a `tasks` source in).
- **Views:** the dashboard Tasks card (and any later `/operations/tasks` list) offer
  **Today / Tomorrow / Upcoming / Overdue** views (bucketed by `due_date`, `status='todo'`).
- **Sitter portal** shift view shows that sitter's tasks for the night.
- (Optional later) a fuller `/operations/tasks` list view if volume warrants.

---

## 9. Messaging / handover

Reuse the `interactions` threading + `ThreadView` + `MentionComposer` stack, anchored to the
shift (`shift_id`). Purpose:
- **Day-to-day handover:** today's sitter sees the previous evening's notes (and the running
  thread for the booking), can add their own; staff can post a "jobs for tonight / things to be
  aware of" message.
- **Staff ⇄ sitter two-way:** replies notify prior participants (low-priority, per the messaging
  spec working agreements). Staff @-mentions work.
- **Scoping:** shift/task interactions carry `shift_id`/`task_id` and are filtered out of the
  person / job / org / venue timelines (the `issue_id IS NULL` guard pattern) so they don't
  pollute unrelated timelines. Anything genuinely a fault → log to the **Problems register**
  (already covered).

This is the explicit fix for the Jotform's dead-end: the end-of-day notes and any "money owed /
items taken / not done" land in a thread staff can **reply to and follow from day 1 into day 3**,
instead of an unanswerable email.

---

## 10. End-of-day lock-up report

Port of the Jotform (`203154178314046`), but **configurable, soft, no PDF**, anchored to the
**shift** (per-evening, site-wide — matching the form's whole-building scope).

**Structure (from the current form, to be tweaked):**
- Header: name of staff locking up (defaults to the assigned sitter), date (the shift date),
  **"Is the booking continuing tomorrow?"** toggle.
- Client section: were clients out on time? (note if late); **have clients paid? — how + receipt
  in till** (manual note for now; shop-sales is deferred).
- Upstairs checklist (PA/amps powered down; **[if booking ended]** mics/cables coiled & taped
  away, Ooosh backline packed to storage, rooms cleaned/vacuumed/bins, crockery washed,
  kitchen replenished; doors bolted, foyer light, AC off, room lights, windows, toilets, fire
  exits, etc.).
- Downstairs checklist (lift returned + off, **all vans locked / van keys in safe & locked**,
  dishwasher on, containers locked, rear fire exit, stockroom lights, thermostat to 10,
  computer/stereo/printer off, front desk tidy, lights off, front door padlocked, outdoor
  cupboard + gates locked).
- Reference photos ("how the rooms should look when empty").
- **"Anything not done / money owed / items taken / anything we need to know"** free-text →
  **posted into the shift thread** (not a dead email).
- **Lost property logged** → deep-link to the Holding module's lost-property entry (replaces the
  Jotform lost-property widget).

**Mechanics:**
- Checklist template + reference images live in `system_settings` (category `studio_sitter`),
  editable in Settings. Each submit snapshots `report_template_version` + answers onto the shift.
- **"Continuing tomorrow?" gates the end-of-booking deep-clean items** (only show the
  "if booking ended" items when it's the last night). v1 treats this at site level — per-room
  "this room's booking ended but the other continues" is a noted future refinement (§16).
- On submit: shift → `closed`, notes → thread, staff get a **bell + email** (so they can reply /
  follow up — the core improvement). Anything flagged routes to Problems.
- **Accountability chaser** (Phase E): if a shift's report isn't submitted by ~end of evening,
  nudge staff (always-fires, like the completion-chaser — not subject to mute).

---

## 11. Notifications summary

| Event | Recipient | Channel |
|---|---|---|
| Sitter assigned / reassigned to a shift | the freelancer | portal (informational; portal-notification-prefs) |
| Evening approaching with no/declined sitter | staff | `JobAlertBanner` amber on job + **dashboard NeedsAttention bucket "Evenings without a sitter"** |
| Task assigned | staff assignee | bell (+ email escalation per prefs) |
| Task assigned | freelancer assignee | portal shift view only (no bell/email) |
| Task done (if notify_on_done) | creator (+ watchers) | bell/email (staff) |
| Task not done after X days | creator | bell/email (staff), daily scan |
| End-of-day report submitted | staff | bell + email (replyable thread) |
| End-of-day report NOT submitted | staff | accountability chaser (always-fires) |

New **NeedsAttention bucket**: "Evenings without a sitter" (next N days, EVENING/LOCKOUT
occupancy, no confirmed assignment) — slots into the dashboard registry, amber, deep-links to the
roster.

---

## 12. Calendar endpoint (future-proofing)

The shift model (`shift_date` + envelope + `needs_sitter` + assigned person + derived room
occupancy) is exactly what the future calendar project wants. Expose from day one:
```
GET /api/studio-sitters/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
→ [{ date, rooms:[{room, band, job_ref, times, flavour}], sitter:{person, status} | null, needs_sitter }]
```
So the calendar build just consumes it — no rework.

---

## 13. RBAC

- Roster view + assign/reassign/bulk-assign + task management: **STAFF_ROLES** (day-to-day ops —
  use the shared constant, don't hardcode the role list).
- Settings (checklist template, reference images, lead-days, default windows): **admin/manager**.
- Sitter portal: the freelancer's own scoped portal session (existing portal JWT), seeing only
  their own shifts (+ shared `info@` account behaviour if reused).

---

## 14. Build order

1. **Phase A — Detection + data model + per-job card.** Migrations (shifts, shift_assignments,
   tasks, interactions anchors). Derivation: classify room/flavour, base-room child rule,
   session-day derivation (§3), ensure shifts exist for sitter-needed evenings. Enhance the
   rehearsal requirement card to show dates + coverage; pre-hire strip + amber warning.
2. **Phase B — Studio Sitter roster page** + assign / reassign / bulk-assign (Studio Sitter tag
   surfaced) + NeedsAttention "Evenings without a sitter" bucket.
3. **Phase C — Portal surface for sitters** (shifts list union, shift detail: who's in, shared
   specs/files, thread placeholder, lost-property/held deep-links).
4. **Phase D — Tasks system** (entity + visibility + notify toggles + staff dashboard card +
   On Today + sitter portal tasks) and **handover messaging** (shift thread via ThreadView).
5. **Phase E — End-of-day report** (configurable template, portal form, continuing-tomorrow
   gate, notes→thread, submit notification, not-submitted accountability chaser).
6. **Phase F — Calendar endpoint** + any remaining future hooks.

---

## 15. Reuse seams (so we don't reinvent)

- **Detection:** `hh-requirement-derivation.ts` (existing `has_rehearsal` path, `backline-categories.ts` for the 450 exclusion).
- **Freelancer assignment mechanics:** `quote_assignments` shape (assigned/confirmed/declined),
  freelancer picker + `is_approved` filter + Studio Sitter tag (`GET /api/people/skills`).
- **Portal:** existing portal JWT/session, jobs-list union, `share_with_freelancer` files,
  `portal-notification-prefs`, completion-chaser pattern (for the end-of-day chaser).
- **Messaging:** `interactions` polymorphic anchor + `ThreadView` + `MentionComposer` (+ scoping
  guard like `issue_id IS NULL`).
- **Dashboard:** section registry (`frontend/src/components/dashboard/v2/`), "On Today" generic
  payload, NeedsAttention bucket pattern.
- **Config:** `system_settings` (category `studio_sitter`) like the OOH-returns settings.
- **Problems/issues:** existing register for anything faulty.
- **Holding module:** lost-property + held-items logging (don't rebuild).

---

## 16. Out of scope / future

- **Shop / ad-hoc sales by sitters** — price lookup (reuse the HH stock export readers), add-to-
  bill (reuse the `addPcnFineLine`/staging-push billable-line pattern), pay-now Worldpay (bank
  169) record via `pushDepositToHH`. Substantial, cross-cutting; deferred. Manual for now.
- **Per-room "booking ended" granularity** in the end-of-day report (v1 is site-level).
- **Multi-site** (only one premises today; `shift_date UNIQUE` assumes single site — would become
  `(site_id, shift_date)` if a second premises ever appears).
- **Calendar view UI** (separate project; endpoint provided here).
- **Room turnaround / prep scheduling** beyond the existing prep-time display.

---

## 17. Open items / gotchas to keep in mind

- **Timing rule (§3) is rehearsal-specific** — do NOT reuse the 9am→9am vehicle/backline window or
  you'll create a dead phantom-day shift. Sibling to the `return_date +1 buffer` note in CLAUDE.md.
- **Base-room double-count (§2)** — classify off the variant; base room as a nested child is
  informational only.
- **One sitter per site** — any aggregate/count over shifts is per-evening, not per-job-room.
  Don't render one card per room-night.
- **Shift/task interaction scoping** — must carry the `issue_id IS NULL`-style guard so they don't
  bubble onto person/job/org/venue timelines.
- **Freelancer task channel** — portal-only, never bell/email. Don't let the general task
  notifier fan out to freelancers by email.
