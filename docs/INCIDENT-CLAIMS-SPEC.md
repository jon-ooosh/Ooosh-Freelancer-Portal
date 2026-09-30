# INCIDENT & POSSIBLE-CLAIMS SPEC — replacing the broker's Word/PDF claim form

**Status:** ✅ PHASES 1–3 BUILT (Sep–Oct 2026) — the case file, the client form and client chasing
(§12 rows 1–3). Phase 4 not started. See §18 (Phase 1), §19 (Phase 2) and §20 (Phase 3) for what
actually shipped and where it differs from the plan below.
**Shaped:** Sep 2026 — jon + Claude, revising a spec drafted months earlier in a non-code session
against the codebase as it actually is. Where this document and that draft disagree, this wins.

**Replaces:** the Alan Boswell *Motor Claim Form* (Word → PDF) that clients print, fill, scan and email,
and the vehicle manager chasing them "as and when he remembers".

---

## 0. One-line summary

> Something happens to a van → it's logged as a **Problem** like any other damage → staff press
> **"Possible insurance claim"** → a case file opens, a link goes to the drivers and lead contact, and
> they're chased daily until the form is done → a manager reviews it and **decides** whether the broker
> ever hears about it → if so, OP builds the broker PDF and tracks the claim to the end.

The frame is **possible claim**, not "claim". Most cases never reach the broker: a claim the broker
gets its teeth into counts against us at renewal even when it ends under the excess. So OP's job is to
collect everything fast and completely, and leave *when (or whether) to notify* as a human decision.

---

## 1. Decisions (settled — don't re-litigate without jon)

| # | Decision | Why |
|---|---|---|
| D1 | **Everything starts as a Problem** (`job_issues`). A possible claim is only ever opened *from* a Problem. | One rule for staff, no "except sometimes". Problems already exist for mid-hire reports (a Problem needs a job OR a vehicle, not a returned van). |
| D2 | The possible claim is its **own record** (`incident_claims`), not more columns on `job_issues`. | One accident = several Problems (one per damaged area, per check-in's design) plus third parties, police and a months-long broker process. The Problem is the damage and its repair; the claim is the case file around it. |
| D3 | **No severity tiers.** One form; sections appear only when relevant (police only if police attended, etc.). | The draft's minor/full tiers, escalate/demote and "Tier 3" all existed to serve a client-initiated heads-up entry point we're not building yet. |
| D4 | **The broker is never contacted automatically.** A manager/admin reviews, then chooses *Notify broker* or *Close — not claimed*. | Renewal risk (above); and nothing reaches the broker unread. |
| D5 | **Only `MANAGER_ROLES`** (admin / manager / weekend manager) may review, sign as policyholder, generate the broker PDF or send it. | The policyholder signature is Ooosh declaring the statements true to its insurer. |
| D6 | **No driver personal data is ever shown or sent client-side.** Client pages say "Driver at the time: Bob Jones" and nothing more. There is **no client PDF copy**. Personal details are joined up only in the broker PDF, staff-side. | GDPR — we already hold it; sending it back out (possibly to a TM) only creates exposure. |
| D7 | Claiming to be the driver requires the **6-digit email code** to the address on that driver's record — the same mechanism the hire form uses. Only after that does the form show the driver *their own* stored declaration answers. | Gives the driver's signature real weight; shows their own data only to them. |
| D8 | **Declarations are pre-filled from the hire form** (§7.3), and the verified driver confirms nothing has changed. | Hire form (a) and (c) match the broker's questions; (b) is combined from what we hold. |
| D9 | Client chase: **daily for 4 days, then stop and flag to staff.** Staff can **pause** (with reason) and **restart** (resets to day 1, logged). | Chasing for weeks after an accident sours the relationship; staff need a way back in. |
| D10 | Road sketch = **freehand drawing pad or a photo of a paper sketch**. No scene-builder. | ~20 forms a year; a mobile scene-builder is weeks of fiddly work for a rough drawing brokers accept. |
| D11 | Damage marking = **tap anywhere** on a van outline to drop a cross (damage) or arrow (impact), with an optional note. **No zones.** | Only the general area is needed — photos carry the detail. Zones would mean hand-mapping every panel on every van shape. |
| D12 | GPS trace is **staff-reviewed and optionally attached**, never automatic. | A trace can be evidence against our client (speed). |
| D13 | Video, GPS, SMS and retention are **Phase 4**. | Video has no OP plumbing at all; the rest is extras. |

---

## 2. What already exists (verified in the repo, Sep 2026)

- **Problems (`job_issues`, mig 075/081)**: anchors (job, vehicle, driver, person, org), `category`,
  `severity`, `status` (open → investigating → awaiting_quote → quoted → actioned → resolved / written_off
  / cancelled), `watchers UUID[]`, `job_issue_events` timeline, `job_issue_files`. Check-in damage lands
  here via `POST /api/problems/auto-create` (one Problem per damaged area, deduped on
  `vehicle_id + component_key`). Repair quotes go to TTS360 via `services/damage-repair-quote.ts`.
  **There is no separate "repair job" entity — the Problem *is* the repair lifecycle.**
- **PCN module (`pcns`, `pcn_events`, mig 130)** — the structural template for this module: own table,
  FK anchors, event timeline, history sections on vehicle/driver/job pages, a day-ladder chase
  (`services/pcn-chase.ts`), Needs Attention buckets (`services/pcn-attention.ts`), a tokenised public
  upload page.
- **Tokenised public links**: ~10 copies of one pattern — `randomBytes(24).toString('base64url')`,
  stored **in the clear** on the owning row (a chase must re-send the *same* link), closed by the record's
  status rather than a timer, public route mounted before `authenticate`, per-file `express-rate-limit`.
  **Nothing GETs-and-mutates** (mail scanners follow links). **No public form saves a partial draft** —
  that's new here.
- **Driver email code**: `routes/driver-verification.ts` send-code / verify (10-min expiry, 5 attempts,
  30-s resend throttle, `driver_verification_codes`).
- **Driver data (`drivers`)**: name (single `full_name`), DOB, address, phone, email, licence detail,
  `date_passed_test`, `licence_categories`, `licence_points`, `licence_endorsements`, the six
  declaration flags + `additional_details`. **No title, no occupation.** DOB/address encrypted via
  `services/driver-pii.ts`.
- **Who could have been driving**: `vehicle_hire_assignments` (one row per driver × van × job,
  soft-cancel). No general "drivers on this van on this job" helper yet; `getOohVanDrivers` and
  `loadPcnWithDrivers` are the nearest.
- **Who we could contact**: `services/job-contact-candidates.ts` `resolveJobContactCandidates()`.
- **Signature pad**: `modules/vehicles/components/book-out/SignatureCapture.tsx` (ref → `getBlob()` PNG).
- **Photo capture/compression**: `PhotoCapture.tsx`, `modules/vehicles/lib/image-utils.ts` (canvas →
  JPEG; **strips EXIF**). The hire-form app (`ooosh-driver-verification-`, `src/POA1Page.js`) has better
  format handling — HEIC detected by magic bytes (catches iPhones labelling HEIC as `.jpg`), converted
  with lazy-loaded `heic2any`. OP has neither.
- **PDF**: `pdf-lib` + fontkit (`hire-form-pdf.ts` is the reference). Attachments via
  `emailService.sendRaw({ attachments, skipLayout: true })`.
- **Files access**: `GET /api/files/download` serves every allowed prefix to ANY authenticated caller,
  freelancers included; only `staff-records/` is role-gated (`routes/files.ts`).
- **Traccar**: device name = reg. Backend only has `getLatestPositionForReg()`; history exists only via
  the staff proxy `POST /api/vehicles/traccar` + frontend `getRoute()`. Maps are client-side Leaflet.
- **Dead code, leave alone**: `modules/vehicles/components/issues/AddActivityForm.tsx` and
  `RepairInsuranceDetails` in `modules/vehicles/types/issue.ts` (an `insuranceClaim` flag from the
  absorbed standalone app) — not imported anywhere. This module supersedes the idea; don't wire it up.

---

## 3. How staff use it (the whole flow)

1. **Something happens.** Phoned in mid-hire, spotted at check-in, or a letter from a third party.
2. **Log it as a Problem**, as today. Check-in does this itself; otherwise the Problems "new" form, or
   the new **"Report incident"** button on the Job › Drivers card (opens the Problem form pre-filled with
   job, van and driver).
3. On the Problem, press **"Possible insurance claim"** (also offered as a tick-box on the new-Problem
   form, which does steps 2 + 3 in one save). This opens the case file, anchored to the Problem's job and
   van. Further Problems on the same van + job link to it — by hand from the case page, and
   **automatically** when check-in logs damage while an open case exists for that van + job.
4. **Send the form.** Staff see a pre-ticked list: every driver on that van on that job, plus the job's
   lead contact (from `resolveJobContactCandidates`). Untick as needed, send. Each person gets **their
   own link** to the same form.
5. **Chasing runs itself** (§9) until someone submits.
6. **Review.** A manager/admin reads the submission, fills in the Ooosh-only fields (§7.1), fixes
   anything obvious, then decides: **Notify broker** or **Close — not claimed**. Or leaves it reviewed
   and waiting (EU incidents often surface weeks late; notifying later is fine).
7. **Notify broker**: manager signs as policyholder → OP generates the broker PDF → one-click email.
8. **With broker**: record the Boswell and Markerstudy refs and milestone dates as they arrive; repairs
   carry on through the linked Problems (quote → TTS360 → actioned) exactly as today.
9. **Close** with an outcome.

### 3.1 A claim out of the blue, after the hire has closed

A third party (or their insurer) writes weeks or months later saying one of our vans hit them. The van
may have checked in clean. Same one rule — **start with a Problem**:

1. New Problem on the **vehicle**, category `dispute`, with the date the third party alleges. The form
   offers the hire(s) that had that van at that moment — the PCN matcher's lookup (`vehicle_hire_
   assignments` hire window, `jobs.job_date/job_end` fallback) — and anchors the Problem to the job
   picked. No match → vehicle-only Problem (e.g. the van was in the yard: that *is* the defence).
2. "Possible insurance claim" → case opens with `third_party_claim = true`.
3. The evidence we'd defend with is already on the case: the check-in condition report (§13) and, in
   Phase 4, the GPS trace (§14) for the alleged time.
4. Sending the form to the driver works exactly as normal, however long ago the hire was.

**Consequence for every scheduled job in this module:** claims outlive their jobs. Chasers and
reminders here must **not** apply the usual "skip lost/cancelled/completed jobs" gate (CLAUDE.md,
scheduled tasks) — the case's own `stage` decides, as with PCNs.

---

## 4. Lifecycle

`incident_claims.stage`:

| Stage | Meaning | Who moves it on |
|---|---|---|
| `open` | Case created from a Problem; form not yet sent | staff: send form |
| `form_out` | Links sent; chasing (§9) | client submits → `submitted` |
| `submitted` | Form complete; awaiting manager review | manager: review |
| `reviewed` | Manager has checked it; broker not notified. **May sit here indefinitely.** | manager: notify broker / close |
| `with_broker` | Broker PDF sent | manager: close |
| `closed` | Done — see `outcome` | manager can re-open |

`incident_claims.outcome` (set on close): `not_claimed` (dealt with internally / under excess),
`settled`, `denied` (our claim refused), `defended` (a third-party claim against us that failed or
was dropped), `withdrawn`.

Staff may also fill the form themselves from a phone call (§7) and move `open` → `submitted` without
ever sending a link.

**Milestone dates** (the vehicle manager's timeline) are events on the case with an **editable date**,
because they're often logged after the fact:
- Date we were notified of the incident (defaults to case creation)
- Date docs sent to Boswells (set automatically on send; editable)
- Claim processed / approved
- Repair booked (also visible from the linked Problems' status)

---

## 5. Where it appears

- **Nav:** Vehicles › **Claims** — `/vehicles/claims` (list) and `/vehicles/claims/:id` (case page),
  next to PCNs.
- **List columns** (the vehicle manager's list): HH#, reg, driver, date of incident, location, Markerstudy
  ref, Boswell ref, stage, days in stage. Filters: stage, vehicle, outcome, date range.
- **Case-file cards** (like `PcnHistorySection`): on vehicle detail, job detail (renders only when a case
  exists), driver detail.
- **Linked Problems** show an **"Insurance claim"** badge linking to the case.
- **Needs Attention** buckets (Phase 3, §9.3).

---

## 6. Data model (migration 258+ — take the next free number at build time)

### 6.1 `incident_claims`

```
incident_claims
  id                      UUID PK
  stage                   TEXT  -- §4
  outcome                 TEXT  -- §4, null until closed

  -- anchors
  origin_issue_id         UUID REFERENCES job_issues(id)        -- the Problem it was opened from
  job_id                  UUID REFERENCES jobs(id)
  vehicle_id              UUID REFERENCES fleet_vehicles(id)
  driver_id               UUID REFERENCES drivers(id)           -- NULL until identified (§8.2)
  assignment_id           UUID REFERENCES vehicle_hire_assignments(id)
  hh_job_number           INTEGER   -- denormalised for list + email subjects
  vehicle_reg             TEXT      -- denormalised

  -- the few answers the list/filters need as real columns
  incident_at             TIMESTAMPTZ
  incident_time_text      TEXT      -- as typed ("around 3pm") — avoids false precision
  incident_location       TEXT

  -- everything else the form collects (Appendix A) — see note below
  form_data               JSONB NOT NULL DEFAULT '{}'
  sections_done           JSONB NOT NULL DEFAULT '{}'   -- { section_key: completed_at }

  -- driver declaration (§7.3) + signatures
  driver_declaration      JSONB     -- snapshot of the answers as signed
  driver_signature_key    TEXT      -- R2 key, claims/ prefix
  driver_signed_name      TEXT
  driver_signed_at        TIMESTAMPTZ
  policyholder_user_id    UUID REFERENCES users(id)
  policyholder_signature_key TEXT
  policyholder_signed_at  TIMESTAMPTZ

  -- broker / insurer
  broker_ref              TEXT      -- Alan Boswell
  insurer_ref             TEXT      -- Markerstudy
  broker_pdf_key          TEXT      -- the exact PDF that was sent (frozen)
  broker_sent_at          TIMESTAMPTZ

  -- complications
  third_party_claim       BOOLEAN DEFAULT FALSE   -- a third party is claiming against our policy
  third_party_claim_notes TEXT
  liability_dispute       BOOLEAN DEFAULT FALSE   -- dispute with the hirer over who pays
  liability_dispute_notes TEXT

  -- chase (§9)
  chase_level             SMALLINT DEFAULT 0
  chase_sent_for          TEXT      -- per-day dedup stamp, pcn-chase style
  chase_paused_at         TIMESTAMPTZ
  chase_paused_reason     TEXT

  -- damage outline + sketch (§10)
  damage_marks            JSONB DEFAULT '[]'  -- [{view, x_pct, y_pct, kind:'cross'|'arrow', angle?, note?}]
  damage_marks_png_key    TEXT
  sketch_key              TEXT      -- freehand PNG or uploaded photo of a paper sketch

  -- keeping long cases moving (§9.2)
  owner_user_id           UUID REFERENCES users(id)   -- who's driving this case; defaults to creator
  next_check_on           DATE                        -- when the owner next chases/looks

  watchers                UUID[] DEFAULT '{}'
  created_by              UUID REFERENCES users(id)
  is_deleted              BOOLEAN DEFAULT FALSE  -- soft only
  created_at / updated_at TIMESTAMPTZ
```

**Why `form_data` is JSONB, not ~80 columns or child tables.** Nothing ever queries "all passengers" or
"third-party insurers across claims"; the answers are only ever read whole — to redraw the form and to
build the PDF. Passengers / witnesses / third parties are arrays inside it. The handful of fields that
*are* listed or filtered on are real columns above. Remember the house rule: **`JSON.stringify` on
write.**

`job_issues` gains **`claim_id UUID REFERENCES incident_claims(id)`** (nullable). That column is the
whole Problem ↔ case link.

### 6.2 `incident_claim_links` — one per recipient

```
  id, claim_id, token (clear, unique), recipient_name, recipient_email, recipient_phone,
  driver_id NULL, person_id NULL,
  status        -- 'sent' | 'opened' | 'handed_off' | 'submitted' | 'revoked'
  handed_off_to UUID REFERENCES incident_claim_links(id)   -- the handoff chain
  first_opened_at, last_opened_at, created_by, created_at
```

A link works while the case is `open` / `form_out`. Once the case is `submitted` the page shows "Thanks
— received" and nothing else (no read-back of what was entered). Revoking one link doesn't affect others.

### 6.3 `incident_claim_events` — timeline (same shape as `pcn_events` / `job_issue_events`)

`event_type, event_date (editable for milestones), body, metadata JSONB, created_by`. Types include
`created`, `form_sent`, `link_opened`, `section_saved`, `handed_off`, `driver_verified`, `submitted`,
`chase_sent`, `chase_escalated`, `chase_paused`, `chase_restarted`, `reviewed`, `broker_sent`,
`ref_recorded`, `milestone`, `problem_linked`, `stage_change`, `comment`.

### 6.4 `incident_claim_files`

Same shape as `job_issue_files` (`r2_key, file_type, content_type, size_bytes, caption, taken_at,
uploaded_by | uploaded_via_link_id`). `file_type`: `photo | police_report | broker_correspondence |
repair_quote | other`. `taken_at` is the photo's original capture time, read before compression (§10.3).

**All claim files live under a new `claims/` R2 prefix, gated in `GET /api/files/download` the same way
`staff-records/` is** — never under `files/`, which any freelancer can read.

### 6.5 `fleet_vehicles.outline_type`

`TEXT` — `vito | sprinter_mwb | sprinter_lwb`, NULL = generic van. Set once per van on the vehicle
page. (`simple_type` is trim level, not body length, so it can't be derived.)

### 6.6 Estimated vehicle value (a fleet-module side-step, Phase 1) — BUILT

`services/vehicle-value.ts` is THE definition. Useful beyond claims; deliberately rough (the broker
asks for an *approximate* value). Never stored — computed at read time.

- **Base** = `cash_price` (the van's cash price, which already excludes finance charges); falls back to
  `deposit_paid + amount_financed` when no cash price is recorded.
- **Start** = `date_first_reg` (jon: ≈ when we got it). No acquisition-date field was added.
- **Curve** (jon, Sep 2026): an immediate drop on the start date, then a yearly rate that starts high
  and falls a step each year, never below a floor; part-years compound pro rata. Defaults
  10% / 17% / −1 point / 5% floor, all in `system_settings` (Settings › Insurance claims).
- **Ex-VAT**: `cash_price` is stored inc-VAT; we recover VAT, so insurers settle net of it.
- `cash_price` is admin-only, so the estimate is rounded to the nearest **£500 for non-admins**
  (£100 for admins). The claim form's pre-fill always uses the £500 figure (the form is all-staff).
- Missing price or first-registration date → no estimate, no guess.

---

## 7. The form

### 7.1 Who fills what

| Part | Filled by | Notes |
|---|---|---|
| Insured block (name, address, policy no., VAT ×2, email, phone, business) | **Constants** — `system_settings` | Never shown to the client |
| Depot, driver type (`On Hire`), use (`Carriage of own goods`), ownership (`Owned`) | **Staff defaults**, editable on review | |
| Vehicle make / model / CC / reg | **From `fleet_vehicles`** | CC = `cylinder_capacity_cc` |
| Approx. vehicle value | **Pre-filled** from the estimate (§6.6), staff can overwrite | |
| Repair cost, repairer instructed + details, storage charges, vehicle in use / where | **Staff** on review | |
| Driver name, DOB, address, phones, licence type + date obtained | **From `drivers`** once identified (§8.2) — joined in the PDF only | HGV = `licence_categories` contains C; full car = B; date = `date_passed_test` |
| Title, occupation | **Verified driver** | Not held anywhere |
| Declarations (a)(b)(c) | **Pre-filled** (§7.3), confirmed by verified driver | |
| Everything about the incident | **Client** (any link holder) | §7.2 |

### 7.2 Client-facing sections (the progress checklist)

The landing page lists these with ticks — "3 of 8 done" — and any can be opened in any order. Each
saves to the server when the person moves on (`POST .../section/:key`, never on GET).

1. **About you** — who's filling this in (§8.1)
2. **What happened** — date, time, place (junction + town), purpose of journey, goods carried, speeds
   (ours + other), speed limit, lights, weather, visibility, road conditions, warning lights/horn,
   any concerns
3. **Police** — informed? then ref, officer name/number, station, potential prosecution
4. **People involved** — one "Add a person" list (§7.2.1); plus "was the driver injured?"
5. **Other vehicles or property** — repeatable block: make/model, reg, insurer + policy no., damage,
   number of passengers; owner and driver **picked from the people list** (or "unknown")
6. **Damage & photos** — outline marks (§10.1), damage description, airbags deployed?, photos (§10.3)
7. **Your account** — description (with the broker's prompt: direction, speed before and at impact),
   sketch (§10.2), at fault? if not why, prepared to attend court?
8. **Driver declaration** — **driver only** (§8.2): title, occupation, stored declarations shown for
   confirmation, "anything changed since your hire form?" (address/phone), sign

Sections appear only when relevant (e.g. section 5 only if "another vehicle or property was involved").

#### 7.2.1 "Add a person" — the contact gatherer

One list instead of the broker form's three separate tables, so nobody has to work out which box a
person belongs in. Big "Add a person" button → **who are they?** (Passenger in our van · Witness ·
Other driver · Owner of other vehicle/property · Someone injured · Other) → name, phone, email,
address, notes. **Every field optional** — it's a memory aid, and a name and a phone number beat
nothing. A person can have more than one role (a passenger who was injured). Passengers get "injured?"
and witnesses get "passenger / employee / independent", matching the broker form.

The broker PDF sorts the list back into its Passengers, Witnesses and Third Party tables.

**Honest limit:** it's most useful *at the scene*, but a client only has the link once we've sent it —
i.e. after they've told us. Getting the form into hands *before* anything happens is the "report an
incident" link planned for the van info-pack rebuild (§17). The form is built phone-first so it works
at the roadside the day that exists.

Submit is available once sections 1–7 are done **and** section 8 is signed. If the person filling in
isn't the driver, section 8 shows "This part must be completed by the driver" with a button to send it
to them (§8.1).

### 7.3 Declarations — mapped from the hire form

| Broker question | Source | Rule |
|---|---|---|
| (a) Accident or claim in past **3** years | `drivers.has_accidents` — hire form asks exactly "past three years" | Direct |
| (b) **Any** driving conviction in 5 years, or prosecution pending | `has_convictions` OR `has_prosecution` OR `licence_points > 0` OR endorsements present | Hire form's convictions question covers only serious offences, so combine with the DVLA points/endorsements; the codes become the "details" |
| (c) Vision/hearing defect or any disability | `drivers.has_disability` | Direct |
| Details | `additional_details` + endorsement codes | |

The driver sees these as "Your hire form says: …  Still correct? Yes / Something has changed". A change
opens a free-text box. **The broker question means *previous* accidents — this incident doesn't turn
(a) into Yes.**

### 7.4 Privacy notice (DRAFT — jon to approve)

Shown at the top of section 1 and on the PDF footer:

> **How we use this information.** Ooosh! Tours Ltd uses what you tell us on this form - including
> details of passengers, witnesses, other drivers and anyone injured - only to deal with this incident:
> to assess it, arrange repairs and, if needed, make or defend an insurance claim. We may share it with
> our insurance broker (Alan Boswell Group), our insurers, repairers, legal advisers and the police
> where required. If you include details of other people, please give only what's needed for the claim.
> We keep incident records for 7 years after the case is closed, as insurance records require. To ask
> what we hold about you, email info@oooshtours.co.uk.

The driver themselves is already covered by the hire-form declaration (consent to sharing "accidents or
claims" information with insurers).

---

## 8. Identity on the public form

### 8.1 "Who's filling this in?"

- **I was driving** → pick your name from the drivers on that van (names only) → code to the email on
  that driver's record (§8.2).
- **I wasn't driving, but I know what happened** → free-text name; fills sections 1–7. Section 8 offers
  "Send the driver's part to: [driver names on this van]".
- **Someone else should do this** → name + email → a new link is minted for them, this link becomes
  `handed_off`, and the chain shows on the case timeline.

A handed-off or forwarded person sees the form **as it stands** (what's been entered so far) — they're
in the same touring party, and it saves re-typing. They never see held driver data (D6).

### 8.2 Driver verification

Reuse the hire-form code mechanics (`driver_verification_codes` pattern: 10-min expiry, 5 attempts,
30-s resend). Success sets `incident_claims.driver_id` / `assignment_id` (nullable until then — a hire
often has several drivers on one van and we don't know who was driving) and unlocks section 8 on that
browser session only (short-lived token, as the hire form's `/auth/verify` JWT).

If the driver has no email on file or can't receive it: staff can set the driver on the case page and
complete section 8 by phone.

---

## 9. Chasing and reminders (Phase 3, except §9.2 which is Phase 1)

Built the house way: a marker column + a scheduled job, like `pcn-chase.ts`. **No generic rules engine.**

### 9.1 Client chase

- Daily (including weekends — tours run through them), ~09:20, for every case in `form_out`, not paused.
- Chase emails go to every link in `sent` / `opened` status (not handed-off, not revoked). Content:
  "You've completed 3 of 8 sections — please finish the rest", with the same link, HH# in subject + body
  per template convention. **No personal or injury details in the email body.**
- After the **4th** chase with no submission → stop, `chase_escalated` event, bell to watchers, Needs
  Attention bucket.
- **Pause** (reason required) and **Restart** (resets `chase_level` to 0 → next run is chase 1; reason
  optional) on the case page, both logged.
- Submission stops chasing immediately.

### 9.2 Keeping long cases moving — owner + next check date

EU and third-party cases can run for months. Fixed reminder intervals don't fit that (some weeks
nothing can happen; some days it's urgent), so every open case has an **owner** and a **next check
date**, like a job's next-chase date:

- Every case outside `form_out` (which chases itself) **must** have a `next_check_on`. Logging any
  update on the case asks "When should we next check on this?" — default +14 days, one-tap +7 / +30.
- On the date, the owner gets a bell: "Check in on claim — RF21 PWX (#16063): with broker, last update
  12 days ago". It links to the case.
- **Overdue or missing date → Needs Attention.** A case can't silently go quiet: it's either got a
  date in the future or it's on the list.
- `submitted` gets `next_check_on` = next working day automatically ("waiting for review").
- Pushing the date on is itself an event ("next check moved to 3 Nov — waiting on Markerstudy's
  engineer"), so the timeline shows the case was being watched.

**Why not the To Do module:** `docs/TASKS-SPEC.md` §2 is explicit — things that belong to another module
(Problems, job reminders) are shown in To Do *read-through*, never copied into `staff_tasks`; two write
paths to one thing is exactly the drift CLAUDE.md warns about. When To Do's Phase 4 (pull-ins) lands,
"claims I own that are due" becomes one more read-through source, badge and link back here. Until then
the bell + Needs Attention do the job.

### 9.3 Needs Attention buckets

Chasing exhausted · check date overdue or missing.

### 9.4 Watchers

`watchers UUID[]`, watch/unwatch endpoints and default watchers from `system_settings`
(`claims_default_watchers`) — copied from Problems. No generic subscriptions table.

---

## 10. Drawing and photos

### 10.1 Damage outline (D11)

- **Artwork:** simplified SVG line drawings, five views each (top, left, right, front, rear) for Vito,
  Sprinter MWB, Sprinter LWB, plus a generic van. **Drawn fresh for OP** — not traced from the
  watermarked Dreamstime previews jon found (copyright; the watermark would also print on the broker PDF).
  Accuracy isn't the point; recognisable shape and orientation are.
- Tap to drop a cross or an arrow (arrow rotates by drag), optional note, undo. Stored as `damage_marks`
  (percent coordinates per view); rendered to PNG in the browser on save for the PDF.
- Van picked by `fleet_vehicles.outline_type`, generic if unset.

### 10.2 Sketch (D10)

A larger version of `SignatureCapture` with undo, clear and two or three colours, **or** "upload a photo
of a paper sketch". Stored as a PNG.

### 10.3 Photos

- Camera-first on mobile (`capture="environment"`), multiple selection, one-at-a-time upload with a
  progress row each (as the vehicle module does).
- **Port the hire-form app's HEIC handling into one shared OP helper** (`frontend/src/lib/`): detect by
  type, extension and magic bytes; lazy-load `heic2any` only when needed; then the existing canvas
  compression. OP's own driver uploads can use it too.
- Read the photo's original capture time (EXIF `DateTimeOriginal`) **before** compressing — compression
  discards it — and send it as `taken_at`.
- Public upload endpoint: token-gated, rate-limited, image types + PDF (police reports), stored under
  `claims/{claimId}/`.

---

## 11. The broker PDF and email (Phase 1)

- Built server-side with `pdf-lib` (pattern: `hire-form-pdf.ts`). Follows the broker form's section
  order; **omits empty sections**; driver details joined from `drivers` here and only here.
- Contents: insured block · driver + licence + declarations · use / vehicle / ownership · incident ·
  police · passengers and witnesses (tables) · description · sketch · fault / court / injury / airbags ·
  damage outline + description · third parties · photo thumbnails with captions and capture times ·
  the broker declaration **verbatim** · driver signature + print name + date · policyholder signature +
  print name + date · our privacy notice in the footer.
- Generated only by `MANAGER_ROLES`, after the policyholder signature (drawn with `SignatureCapture`,
  recorded against the logged-in user). The PDF sent is frozen to R2 (`broker_pdf_key`); regeneration
  after sending makes a new file, never overwrites.
- **Photos: thumbnails in the PDF, each with a "View full size" link** — the book-out condition
  report's pattern. **But not its storage:** those links point at the *public* vehicle-photo bucket,
  and claim photos (faces, other people's number plates, injuries) must never go there. Instead each
  sent case gets a long-lived, unguessable **broker link token**; the PDF's links go to a public OP
  route (`/claim-photo/:token/:n`) that streams the full-size photo from the private `claims/` prefix.
  Revocable per case; closed when the case closes + 90 days. Rate-limited like every public route.
- **Send:** one click → `emailService.sendRaw` with the PDF attached, to
  `system_settings.claims_broker_email` (initially **SelfDriveHire@alanboswell.com**), reply-to a
  monitored Ooosh address. Branch on `result.success`. Sets `broker_sent_at`, stage `with_broker`,
  milestone event.
- A **Download PDF** button lets a manager review it before sending.

---

## 12. Build phases

| Phase | Contents | Standalone value |
|---|---|---|
| **1. Case file** | Migrations (§6); gated `claims/` prefix; "Possible insurance claim" on Problems + tick-box on the new-Problem form; "Report incident" on the Job › Drivers card; check-in auto-link; hire lookup for out-of-the-blue claims (§3.1); list + case page (stage, refs, milestones, complications, notes, files, watchers, linked Problems, owner + next check date with its daily bell and Needs Attention (§9.2)); estimated vehicle value (§6.6); staff-entered form (§7); auto-linked documents (§13); broker PDF + policyholder sign + one-click send | Replaces the Word form for phoned-in claims; gives the vehicle manager his tracker |
| **2. Client form** | Links + send dialog; public page with checklist and section-by-section save; who's-filling-in + handoff; driver code; outline marking (+ artwork, `outline_type`); sketch; photos (HEIC port, capture time); privacy notice | The client replacement |
| **3. Chasing** | Client chase (§9.1), Needs Attention for exhausted chases; scheduler entry (add to CLAUDE.md's scheduled-tasks line) | Nobody has to remember to chase |
| **4. Extras** | GPS trace (§14); SMS chase via Twilio (check international sending is enabled — EU numbers); video (direct phone-to-R2 upload); retention flagging | |

---

## 13. Auto-linked documents (Phase 1)

Shown on the case page as links to the originals (never copies):
- **Driver documents** — the identified driver's files; until identified, each driver on that van.
- **Hire form PDF** — per driver per job (`hire_form_documents`).
- **Book-out and check-in condition reports** for that van on that job (`condition-reports/{REG}/…`;
  older events regenerate on demand as they do today). *Verify at build: the cleanest lookup from
  job + vehicle to the event IDs.*

---

## 14. GPS trace (Phase 4)

On the case page, once the incident date/time is known: a panel showing the van's Traccar route ±30 min
on the existing Leaflet map; staff widen/narrow the window and press **Attach** to save the points (CSV)
and a map image as case files. Needs a backend `getRouteForReg(reg, from, to)` alongside
`getLatestPositionForReg`. *Verify at build: capturing the Leaflet map to an image in the browser
(tile cross-origin headers).*

---

## 15. Access and privacy summary

- Case pages and the `claims/` prefix: `STAFF_ROLES` (never freelancers). Review, policyholder signing,
  broker PDF and send: `MANAGER_ROLES`.
- Notification and email bodies link to the case; they never carry injury, declaration or driver
  personal details.
- Client pages never show held driver data (D6); the verified driver sees only their own declarations.
- Public links close when the case leaves `form_out`; nothing mutates on GET; every public route
  rate-limited.
- **Retention:** 7 years from close is the policy. Enforcement is deliberately deferred to the wider
  retention discussion (it should cover historic driver records too — currently there's no retention for
  `drivers` at all).

---

## 16. Open items

1. **Broker:** preferred subject line / file naming (ask before Phase 1's send button goes live).
2. **Van outline artwork** — Claude draws them at the start of Phase 2; jon judges whether they're good
   enough.
3. **Depreciation rate** (§6.6) — jon to pick the starting figure.
4. **Retention enforcement** — part of the wider driver-data retention discussion, not this module.

**Resolved:** privacy notice approved (hyphens, not dashes); injury and declaration answers visible to
all `STAFF_ROLES`; broker address SelfDriveHire@alanboswell.com; photos as thumbnails + full-size links.

---

## 17. Later (not scheduled)

- **Client-started reports** — a "report an incident" link in the rebuilt van info packs, creating the
  Problem + case itself. The natural home for at-the-scene use of the people gatherer (§7.2.1).
- To Do read-through of cases I own (§9.2), when To Do Phase 4 lands.

---

## 18. Phase 1 as built (Sep 2026)

**Backend**
- Migration `259_incident_claims.sql` (258 was taken on main): `incident_claims`, `incident_claim_events`,
  `incident_claim_files` (+ `thumb_r2_key`), `job_issues.claim_id`, `photo_link_token`, settings
  (category `claims`). The Phase 2 per-recipient links table is NOT created yet.
- `services/incident-claims.ts` — `createClaimFromIssue()` (transactional, idempotent),
  `autoLinkIssueToOpenClaim()` (wired into both paths of `POST /problems/auto-create`),
  `runClaimCheckReminders()` (daily 09:22, stamp-first on `next_check_sent_for`),
  `getClaimAttentionBuckets()` (dashboard `claim_check_overdue`).
- `services/claim-form-fields.ts` — THE field catalogue; the frontend imports it via the `@claimform`
  alias (same arrangement as `@calc`). Pure — no imports.
- `services/claim-pdf.ts` — broker PDF (pdf-lib, subset fonts, ~25KB before photos).
- `routes/incident-claims.ts` at `/api/claims`. Public: `GET /claims/photo/:token/:fileId` only.
  Out-of-the-blue claims reuse `GET /pcns/match` for the hire lookup (needs regs without spaces,
  as the fleet stores them).
- `GET /files/download` gates the `claims/` prefix to `STAFF_ROLES`.

**Frontend** — `/vehicles/claims` (list + "Claim out of the blue"), `/vehicles/claims/:id` (case page),
"🛡️ Possible insurance claim" on the Problem page, a tick-box on the job's Log Problem form,
"🛡️ Report incident" on the Job › Drivers cards (opens that form pre-filled), claims cards on job /
driver / vehicle pages, estimated value on the vehicle page, Settings › Insurance claims, and a Needs
Attention bucket.

**Differences from the plan above**
- "Form out" can't be set yet — there's no client link until Phase 2, so nothing would chase. Staff
  fill the form themselves and move `open → submitted`.
- Other vehicles' owner and driver are typed into the block (§7.2 item 5); picking them from the people
  list comes with the Phase 2 client form.
- Photo capture time (EXIF) is not read yet — `taken_at` stays empty for staff uploads (Phase 2, §10.3).
  HEIC that the browser can't decode is uploaded as-is, without a PDF thumbnail.
- `fleet_vehicles.outline_type` is not added yet (Phase 2 with the outline artwork).

**Not tested end to end before shipping** (no R2 / email in the build sandbox): file upload, the
policyholder signature save, and the broker send. Everything else was exercised against a real
Postgres: create/idempotency, check-in auto-link, stage rules and roles, freelancer lock-out,
reminders, dashboard bucket, out-of-the-blue, and the PDF build (rendered and checked).

### 18.1 Follow-up (migration 260, Sep 2026 — jon after first live use)
- **How we heard** (`incident_claims.notified_via`): client / TTS360 (24-hour line) / third party /
  found at check-in / other. Set automatically for check-in Problems and out-of-the-blue claims; staff
  set the rest. New file type **TTS360 notice** for the notices TTS360 send when a client calls them.
- **Share with insurers** (`incident_claim_files.share_with_insurer`): not everything on the case goes
  to the broker. Photos, police reports and repair quotes start ticked; everything else private. Only
  ticked photos go in the broker PDF (and only they work behind its "View full size" links); ticked
  documents are attached to the broker email, up to 15MB in total (anything over is named in the email
  as "available on request").
- **@mentions in case updates** — the shared `MentionComposer`; mentioned staff get the same bell and
  immediate email as a mention anywhere else (`notifyClaimMentions()`). Pasted attachments are refused
  there: case files go through the Files card so they stay under the private `claims/` prefix.

## 19. Phase 2 as built (Sep 2026) — the client form

**Backend**
- Migration `261_claim_client_form.sql`: `incident_claim_links` (one per recipient — token, name,
  email, `driver_id` / `person_id`, role `driver | contact | forwarded`, status
  `sent → opened → handed_off | submitted | revoked`, who filled it in, `handed_off_from`, opened
  times), `incident_claim_codes` (driver email codes, sha256-hashed), `fleet_vehicles.outline_type`,
  `incident_claim_files.uploaded_via_link_id`, `incident_claims.submitted_at` / `submitted_via_link_id`.
- `services/claim-links.ts` — link resolve, create + send (an existing live link for the same email is
  re-sent rather than duplicated), drivers on the van, the driver code (6 digits, 10 minutes, 5 tries,
  30s resend throttle; success = a 2-hour `claim_driver` JWT sent back in `x-claim-driver-session`),
  damage marks, sketch, and the hire-form declarations pre-fill (§7.3).
- `routes/claim-form.ts` — PUBLIC, `/api/claim-form/:token`, rate-limited per IP. Nothing changes on a
  GET ("opened" is its own POST). Writes are refused (409) once the case has left `open` / `form_out`,
  so a client can't edit a form a manager is reviewing. The page only ever receives the client
  sections, driver NAMES (never contact details or hire-form data), and files uploaded through a link
  — never staff files. The driver section and declarations only after the code, and only the details
  that driver gave on their own hire form.
- Every save runs through `sanitiseSection()` in the field catalogue: unknown keys dropped, types
  coerced, choices checked, list blocks capped at 30 rows. Damage marks through
  `sanitiseDamageMarks()` (≤ 60, positions 0–100).
- Submit needs "who", every client section and the driver's signature; otherwise it returns the
  missing list. On success: stage `submitted`, next check the next working day, followers notified.
- Staff: `GET /claims/:id/recipients`, `POST /claims/:id/links` (moves `open → form_out`),
  resend / "switch off" a link, `PUT /claims/:id/damage`, `POST /claims/:id/sketch`.

**Frontend**
- `/claim/:token` (`pages/ClaimFormPage.tsx`) — public, no Layout, phone-first. Home checklist
  ("N of 8 done") → one section at a time, saved as you go, so it can be finished over several sittings
  from the same link. Who's filling this in: the driver (pick your name → email code), someone else
  (name), or "send it to someone else" (forward). A non-driver can send the driver section to the
  driver by name without ever seeing their email address.
- `components/claims/VanOutline.tsx` — the outline sheet (top, both sides, front, rear) drawn in
  code from a few proportions per type (Vito/V-Class, Sprinter MWB, Sprinter LWB, generic), not from
  the watermarked stock images. Tap for a cross, or an arrow you can turn; each mark can take a note.
  Saved as marks (JSON) plus a PNG for the PDF. Staff get the same editor on the case page.
- `components/claims/SketchPad.tsx` — freehand scene sketch (3 colours, two pen sizes, undo), or a
  photo of a paper sketch through the photo uploader.
- `lib/imageNormalise.ts` — the hire-form photo port: reads the EXIF capture time first, converts
  HEIC (detected by its bytes, not the file name) with `heic2any` loaded only when needed, then
  compresses to 2048px with a 400px thumbnail.
- `components/claims/FormFields.tsx` — the field inputs, now shared between the case page and the
  public form.
- Case page: "Client form" card (pick recipients — drivers on the van and the lead contact start
  ticked — plus an extra name/email; each link's status, resend, switch off), "Damage marks & sketch"
  card, and the signed driver declaration. The vehicle page gets a "Claims damage drawing" choice
  (`outline_type`); left blank, it is guessed from the make/model/type text.

**Differences from the plan above**
- Until Phase 3, `form_out` cases are chased by the ordinary owner/next-check-date reminder (§9.2),
  not by client emails — sending the form sets the check date 3 days out.
- Other vehicles' owners and drivers are typed in by the client; they are not picked from the people
  list (a public page can't see it).
- No video, GPS or SMS (Phase 4).

**Not tested end to end before shipping** (no R2 / email in the build sandbox — an in-memory storage
shim and a local mail sink stood in): the real link and code emails, and photo/sketch storage on R2.
Exercised against a real Postgres and a phone-sized browser with touch input: send, open, who's
filling it in, forward, send-to-driver, the code (wrong code, reuse), every section save and its
sanitising, photo upload (and refusal of non-images), marks, sketch, signature, submit (missing list,
then success, then writes refused), and the broker PDF with all of it in.

### 19.1 Follow-up after first live test (Sep 2026 — jon)
- **Send first.** On an open case the top bar's main button is "Send form to driver / client", which
  opens the recipient picker right there (drivers on the van, job contacts, and a clear "Someone else"
  name + email row). "Taken by phone — ready for review" is the secondary route. Once the form is out
  the bar shows **progress** — "N of 8 done", each part done / started / not yet, and the client's
  latest activity.
- **Staff and client edit the same answers.** Anything staff type into a client section pre-fills the
  client's link; a section only ticks when the client saves it complete (their confirmation). The staff
  form now saves **only the sections staff edited** (`form_data || patch`), so a client saving through
  their link at the same time keeps their answers; while the form is out the staff form says so. No lock.
- **Required answers** (catalogue: `required`, `requiredWhenAnyYes`, `minLength`, section `oneOf`,
  list gates): a section always saves, but only counts as done — and the form can only be sent — once
  its core answers are in (`sectionMissing()`). When and where: date + place. Police: informed; if so a
  reference or station. People involved: new "Was anyone else there?" gate; if yes, a name per person.
  Other vehicles: the gate; if yes, make/model or reg per row. Damage: a description ("none" is fine).
  Your version of events: a description (≥ 20 characters) + at fault. Driver declaration: title,
  occupation, (a)–(c), details if any is yes, and the signature. Staff "mark complete" is not gated.
- **Validation** (`fieldFormatError()`): emails need `x@y.z`; phones are loose (any country) — digits,
  spaces, `+ ( ) - .`, 7–15 digits. Refused on the client form (page and server); shown as a warning
  on the staff form.
- **People consolidated.** "Witness type" and the "Someone injured" chip are gone: a witness gets
  "Do they know you or the driver?", and the PDF derives the broker's witness type (Passenger /
  Connected / Independent; an old `witness_type` still prints). Injured stays a yes/no.
- **Renamed:** "What happened" → **When and where**; "Your account" → **Your version of events**.
- **Submitted = action.** Bell (high) to owner + watchers, an **email to the owner** (or the default
  claim watchers when there's no owner), and a Needs Attention bucket **"Claim forms to review"**
  (stage `submitted`) — those cases are left out of the overdue-check bucket.
- **Second case on the same job — a flag, not a gate.** Ticking "Possible insurance claim" (Log Problem
  form or the Problem page) when the job (or, for a jobless Problem, the van) already has an open case
  offers "Add this Problem to that case" or "open a separate case".
- **Driver not on a hire** (one of us or a freelancer — garage runs, non-HireHop jobs): a staff-only
  section `non_hire_driver` (name, DOB, address, mobile, licence) that the broker PDF prints in the
  driver block when the case has no hire driver. Staff fill the declaration from the staff form.
- Not done, deliberately: changing the van on a case (jon — it comes from the Problem; a jobless
  Problem on the van already covers non-job claims).

### 19.2 Outline artwork (Oct 2026)
The Vito, Sprinter MWB and Sprinter LWB now use jon's original shaded outline sheets
(`frontend/src/components/claims/outlines/*.svg`, from the "Ooosh Vehicle Outlines" design handoff —
drawn to scale in mm, roof / offside + front / nearside + rear). Use them as they are; the handoff's
generator (not committed) is where edits belong. The C2PA provenance metadata was stripped from the
copies. They're inlined into the marking sheet, so marks (still % of the sheet) sit on the artwork and
the saved PNG for the broker PDF includes it. 'generic' vans keep the simple generated drawing.
Marks saved before the swap were placed on the old layout and will sit in the wrong place on these
sheets — only test cases had any.

## 20. Phase 3 as built (Oct 2026) — client chasing

- `services/claim-chase.ts` `runClaimClientChase()`, daily **09:21** Europe/London, weekends included.
  No migration — the `chase_*` columns came with 259.
- Every case in `form_out` with chasing not paused: stamp-first on `chase_sent_for` (UK date), then
  email every live link (`sent` / `opened`) a reminder — same link, "N of 8 parts done"
  (`formProgress()`, the count the form and case page show), van + job number only, no personal or
  injury details. The 4th says it's the last and to call us. `chase_level` counts them (1–4).
- The day after the 4th with no form: `chase_escalated` event, a high bell to owner + watchers, and
  the Needs Attention bucket **"Claim forms not coming back"**; `chase_level` = 5 marks it flagged.
- **Quiet days** (added in the build, not in §9.1): a day is skipped, not counted, when the form went
  out or the client did anything on it in the last 20 hours — someone half-way through doesn't get a
  "please finish". A day where no email could be sent is also not counted.
- **Pause** (reason required) and **Restart** (back to reminder 1, clears a pause) on the case page's
  top bar, both on the timeline. A paused case goes back on the owner's check date (one is set, 7 days
  out, if missing) and into the overdue-check bucket; an actively chased case is left out of the
  check-date bells and that bucket (`SELF_CHASING` = `form_out`).
- Staff sending the form to someone **new** restarts the count, so the new person gets the full run.
- The claims list's check-date column shows "client reminders (n/4)" or "reminders ran out" for a
  case being chased.
- Not done: a separate chase for the driver's part (the driver's link is chased like any other).

