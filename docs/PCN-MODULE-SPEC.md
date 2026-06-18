# PCN MODULE SPEC — Penalty Charge Notice management (Monday → OP)

**Status:** SPEC / DESIGN — shaped, not yet built. Refer to this before implementation.

**Last shaped:** Jun 2026 (jon + Claude design session)

**Replaces:** the standalone `PCN-Management-System` Netlify app (intake portal + Monday boards).
Monday is being torn down within a week; jon is pulling historical data out manually. The intake
flow, AI extraction, HireHop charge, and SMTP email all already work — this spec is about
**re-homing the module inside OP** so it reads/writes OP data instead of Monday, and folding in the
flow refinements agreed in the design session.

---

## 0. One-line summary

> Upload a parking/traffic notice → AI extracts the details → match the driver who had the van at
> the offence moment (from `vehicle_hire_assignments`) → track it through a liability lifecycle →
> chase, charge, and close — all logged in OP, emailed through OP, filed in R2.

A PCN is conceptually "a problem anchored to a vehicle + driver + job, with a financial/liability
lifecycle." It's a **standalone module** (not a `job_issues` add-on — decided: it's big and distinct
enough), built to the same shape as **Storage (Step 9)** and **Holding (Step 10)**: one engine table
with FK anchors into the existing entities, surfaced through reusable sections on the address-book +
vehicle + driver + job detail pages.

---

## 1. What the legacy system did (intent, for reference)

Source: `PCN-Management-System/docs/SPECIFICATION.md` + the 7 Netlify functions. Ooosh receives
hundreds of PCNs/year. The manual grind was: identify the responsible driver, transfer liability or
pay-and-recharge, add a handling fee, track deadlines, chase. The Netlify app turned that into a
4-step intake (upload → extract → match → act). **Three of its six functions touched Monday and need
re-homing**; the other three port straight onto OP infrastructure:

| Legacy function | Touches Monday? | OP destination |
|---|---|---|
| `extract.js` (Claude Vision) | No | OP backend route (Claude via existing patterns) |
| `send-email.js` (SMTP) | No | `email-service` (branded + `email_log` audited) |
| `hirehop-charge.js` (item `b1744`) | No | HireHop broker (logic unchanged) |
| `match-driver.js` | **Yes** — Driver Hire Form board `841453886` | `vehicle_hire_assignments` ⋈ `drivers` ⋈ `fleet_vehicles` ⋈ `jobs` |
| `get-settings.js` | **Yes** — Settings board `18390181263` | `system_settings` + email-template registry + OP users |
| `create-pcn.js` | **Yes** — PCN Tracker board `18390180140` (the DB) | new `pcns` table |

**Cutover stance on historical data:** OP has been live ~10 weeks, so ~99% of future PCNs concern
drivers already in `vehicle_hire_assignments`. Pre-OP offences that won't match are accepted as
manual triage (jon trawls the exported Monday data). No historical hire-data migration required.

---

## 2. Placement & surfacing

**Nav:** under **Vehicles** (not Operations). `/vehicles/pcns` — list + filters; `/vehicles/pcns/:id`
— detail/control panel. New entry in the Vehicles nav submenu.

**Reusable `PcnHistorySection`** (mirrors `StorageHistorySection` / `HeldItemsSection`): one
component, four mounts —
- **Vehicle detail** — every PCN against this reg (the repeat-vehicle view)
- **Driver detail** — every PCN matched to this driver (accountability / repeat-offender — see §7)
- **Person / Organisation detail** — PCNs where they're the client/hirer

**Job View surfacing (conditional, at-a-glance):** a **PCN card on Job Detail that renders ONLY when
`pcns` rows exist for the job** (same conditional pattern as Holding's "Also holding (FYI)"). Because
a job can collect several notices, it **lists one row per PCN** (ref · reg · status pill) rather than
collapsing to a single pip. Status colour:
- 🟢 **green / sorted** — `paid_by_driver`, `paid_recharged`, `internal_*`, `closed`
- 🟡 **amber / in-flight** — `driver_notified_pay`, `awaiting_driver_id`, `liability_transferred` (chasing), `under_query`
- 🔴 **red / outstanding** — past an issuer deadline or past the final receipt-chase with no resolution

Not on the dashboard Today strip (a PCN isn't a per-job prep gate). It DOES get NeedsAttention
buckets — see §8.

---

## 3. Data model

### `pcns` (new table, migration 12X)

```
pcns
  id                     UUID PK
  reference              TEXT            -- PCN / ticket reference (was Monday item name)
  fine_type              TEXT            -- 'private_pcn' | 'council_pcn' | 'police_nip' | 'toll' | 'other'

  -- anchors (all nullable; at least one of vehicle_id / job_id expected)
  vehicle_id             UUID REFERENCES fleet_vehicles(id)
  driver_id              UUID REFERENCES drivers(id)
  assignment_id          UUID REFERENCES vehicle_hire_assignments(id)
  job_id                 UUID REFERENCES jobs(id)
  client_organisation_id UUID REFERENCES organisations(id)
  hh_job_number          INTEGER         -- denormalised for comms + display (see §4)
  vehicle_reg            TEXT            -- denormalised, as extracted (survives unmatched case)

  -- extracted detail
  offence_at             TIMESTAMPTZ     -- combined offence date + time
  offence_time_text      TEXT            -- raw "HH:MM" as extracted (avoids tz drift, mirrors legacy)
  location               TEXT
  issuing_authority      TEXT
  offence_description     TEXT
  fine_amount            NUMERIC(10,2)
  reduced_amount         NUMERIC(10,2)
  reduced_deadline       DATE
  final_deadline         DATE
  extraction_confidence  TEXT            -- 'high' | 'medium' | 'low'

  -- lifecycle
  status                 TEXT            -- see §5
  action_path            TEXT            -- 'pay_direct' | 'transfer_liability' | 'pay_recharge'
                                         --   | 'internal_ooosh' | 'internal_freelancer' | 'query'
  handling_charge_applied BOOLEAN DEFAULT FALSE   -- did the £35+VAT actually land on HH?
  handling_amount        NUMERIC(10,2)           -- actual charged (default from system_settings)
  hh_charge_pushed_at    TIMESTAMPTZ

  -- pay-direct / receipt loop (§6)
  pay_direct_deadline    TIMESTAMPTZ     -- the 48h ask
  receipt_url            TEXT            -- R2 key of uploaded proof-of-payment
  receipt_uploaded_at    TIMESTAMPTZ
  receipt_chase_level    SMALLINT DEFAULT 0       -- 0..3 ladder position (§6)
  receipt_chase_sent_for TEXT            -- per-cycle dedup stamp

  -- audit
  pcn_document_url       TEXT            -- R2 key of the original notice
  handled_by             UUID REFERENCES users(id)   -- logged-in staff, not a name picker
  notes                  TEXT
  is_deleted             BOOLEAN DEFAULT FALSE        -- soft-delete only, never hard
  created_at / updated_at TIMESTAMPTZ
```

**`pcn_events`** (audit timeline — same shape as `job_issue_events`): typed rows (`created`,
`extracted`, `matched`, `status_change`, `email_sent`, `receipt_chase`, `receipt_received`,
`handling_charged`, `liability_transferred`, `comment`) with `body` + `metadata JSONB` +
`created_by`. Drives the detail-page timeline and the repeat-offender reporting.

Soft-state only — no `DELETE FROM pcns` anywhere (consistent with `vehicle_hire_assignments` /
`job_excess` convention).

---

## 4. Driver matching (replaces `match-driver.js`)

`GET /api/pcns/match?reg=<REG>&offence_at=<ISO>` →

```sql
-- find assignments where this reg was out across the offence moment
SELECT vha.*, d.*, fv.reg, j.hh_job_number, j.job_name
FROM vehicle_hire_assignments vha
JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
LEFT JOIN drivers d ON d.id = vha.driver_id
LEFT JOIN jobs j ON (vha.job_id IS NOT NULL AND j.id = vha.job_id)
                 OR (vha.job_id IS NULL AND j.hh_job_number = vha.hirehop_job_id)
WHERE fv.reg = :normalisedReg
  AND vha.status NOT IN ('cancelled')
  AND COALESCE(vha.hire_start, j.job_date) <= :offence_at
  AND COALESCE(vha.hire_end,   j.job_end)  >= :offence_at
```

- **Canonical hire window** = `vehicle_hire_assignments.hire_start/hire_end`, fallback
  `jobs.job_date/job_end` (NOT `return_date` — that's the +1 buffer). Reuse the rules already in
  `services/assignment-overlap.ts`, including the **dual-match-on-`hh_job_number`** LEFT JOIN (V&D
  staff-allocation rows carry only `hirehop_job_id`).
- Returns **0 / 1 / N** drivers, each with the full driver record (name, email, phone, referral
  status, excess history) + the linked job + `hh_job_number`. This is a strict upgrade on Monday,
  which only had name + email + dates and matched client self-drive only — OP matches self-drive,
  V&D, and D&C.
- **0 matches** → manual triage: staff pick `internal_ooosh` / `internal_freelancer` / `unknown`, or
  enter a driver by hand.
- **N matches** → driver-ID request (§5, and the names fix below).

**HH job number everywhere (flow fix #1):** the match pulls `hh_job_number` onto the record, and
**every client-facing PCN email carries it in subject + body** per OP's existing template convention
(`<Headline> — <Job Name> (#<jobNumber>)`). Unmatched/internal PCNs with no HH number degrade
gracefully (`(#)`), same as the rest of OP.

---

## 5. Status & action model

**Statuses** (`pcns.status`):

| Status | Meaning | Terminal? |
|---|---|---|
| `received` | Logged, no action chosen yet | no |
| `awaiting_driver_id` | N drivers — asked who was driving | no |
| `driver_notified_pay` | Lenient path: driver asked to pay issuer direct + send receipt (§6) | no |
| `paid_by_driver` | Receipt received — closed, **no handling fee** | ✅ |
| `liability_transferred` | Formally transferred to driver/client, £35+VAT applied, chasing proof | no |
| `paid_recharged` | Ooosh paid the issuer, recharged to client | ✅ |
| `internal_ooosh` | Staff vehicle — absorbed | ✅ |
| `internal_freelancer` | Freelancer responsible — logged (§7) | ✅ |
| `under_query` | **We** are disputing/appealing on our own behalf | no |
| `closed` | Fully resolved | ✅ |

**Action paths** (`pcns.action_path`) and what each does:

- **`pay_direct`** (the lenient flow — §6): notify driver to pay the issuer themselves. **No
  handling fee unless it escalates.**
- **`transfer_liability`**: formally transfer to the driver/client. Adds £35+VAT to the HH job.
- **`pay_recharge`**: Ooosh pays the issuer, then recharges fine + handling to the client (via the HH
  job; future: through the Money tab).
- **`internal_ooosh` / `internal_freelancer`**: absorbed / logged, no client comms.
- **`query`**: we dispute it → `under_query`.

**Two distinctions to keep straight (agreed in session):**
1. **"Appeal" ≠ "Under Query".** If a driver says *they* want to appeal, that's them taking it on in
   their name → `transfer_liability` (+£35+VAT). `under_query` is reserved for when **Ooosh** is
   disputing on its own behalf.
2. **Handling fee is conditional on the `pay_direct` path** — see §6. On `transfer_liability` and
   `pay_recharge` it always applies (unchanged from legacy).

---

## 6. The pay-direct lenient flow (the careful bit)

**Why it exists:** for regular/valued clients, recharging £35 for a notice that's really their
driver's problem feels heavy-handed. We want the option of leniency — *but it must be rock solid*, or
we eat fines that were never ours. So: strong driver chasing **plus internal info@ alerts at every
rung** so nothing slips while we're being a soft touch.

**State machine:**

```
received
 → staff chooses action: "Notify driver to pay direct"
   status: driver_notified_pay
   set pay_direct_deadline = now + 48h
   email driver (POP upload link, §6.1):
     "Pay the issuer within 48h and forward a receipt. If you appeal or
      don't pay, we transfer liability to you with a £35+VAT fee."
   internal: info@ alert "pay-direct offered on PCN <ref> (#<job>), watching for receipt"

   receipt-chase ladder (scheduler, business hours, per-cycle dedup on receipt_chase_sent_for):
     T+3 days  no receipt → receipt_chase_level=1 → driver chase 1 + info@ alert
     T+5 days  no receipt → receipt_chase_level=2 → driver chase 2 + info@ alert
     T+7 days  no receipt → receipt_chase_level=3 → driver FINAL warning + info@ alert
     T+7+      no receipt → NeedsAttention red bucket: "Ready to transfer liability"
                            (NOT auto — one-click human action, decision #1)

   exits:
     receipt uploaded (any point) → status: paid_by_driver  (NO fee)  ✅
     staff one-click "Transfer now" → status: liability_transferred
                                      action_path: transfer_liability
                                      add £35+VAT to HH job
                                      email driver: liability now formally yours, fee applied
```

**Decisions baked in:**
- **#1 escalation is one-click, never automatic** — the receipt may already be sitting in the inbox
  unread; a human confirms the transfer. The system surfaces it loudly (red NeedsAttention bucket +
  the T+7 final state), it doesn't pull the trigger.
- **#3 fee is conditional** — `paid_by_driver` = £0 handling. The £35+VAT only lands when staff
  escalate to `liability_transferred`.

**§6.1 Closed-loop receipt upload (decision #2):** reuse the existing **`mobile_upload_tokens`**
primitive (the same one excess receipts + the QR handoff use — it's purpose-scoped and generalises).
- New purpose `pcn_receipt`. Each chase email contains a tokenised link, e.g. `/p/pcn-receipt/:token`.
- Driver clicks → public page (no Layout, `capture="environment"`) → **uploads a PDF or snaps a photo
  of the proof-of-payment** → backend attaches to R2 (`pcn-receipts/<id>/…`), sets `receipt_url` +
  `receipt_uploaded_at`, flips status to `paid_by_driver`, logs a `receipt_received` event, and fires
  an info@ confirmation. Single-use token, sensible TTL.
- Receipt also appears on the job's **Files tab** (same `attachExcessReceipt`-style single-source-of
  -truth helper pattern).
- Staff can still upload manually from the detail page (decision #1's "they emailed it over" case).

**Internal alerting:** every rung of this ladder fires an **info@ email** (not just the driver), per
jon's "right on top of chasing them" requirement. This is the one flow where we deliberately notify
ourselves at each step — contrast the silent OOH/holding chasers. Use the established
sanity-scanner-style stamp-first-then-send dedup so a transient send failure doesn't double-fire.

---

## 7. Driver accountability (improvement — agreed)

Same spirit as the OOH-return non-compliance logging, but **more automatable here because the driver
is already matched**:
- `PcnHistorySection` on Driver detail shows every PCN against that driver + a count.
- Repeat-offender flag trivial off `driver_id` (e.g. ≥N PCNs in rolling 12 months) → surfaces on the
  driver record + feeds the freelancer review.
- Pattern reporting later (cross-driver, like the issues-register recurrence idea).

---

## 8. Deadlines, chasers & dashboard

**Two deadline types feed the scheduler:**
1. **Issuer deadlines** (`reduced_deadline`, `final_deadline`) — from the document. Nudge if a PCN is
   still in `received`/`awaiting_driver_id` as the reduced deadline approaches (don't miss the cheap
   window).
2. **Internal receipt-chase ladder** (§6) — the 3/5/7-day rungs.

**Police NIP** keeps the legal **28-day** red-alert treatment (registered-keeper response is a legal
obligation — missing it is a criminal offence). Urgency window from `system_settings`.

**Dashboard NeedsAttention buckets** (extend `GET /api/dashboard/operations` → `needs_attention`):
- 🔴 **Police NIP — respond now** (within the legal window)
- 🔴 **PCN ready to transfer** (pay-direct lapsed past T+7, no receipt — the one-click action queue)
- 🔴 **PCN deadline approaching** (issuer reduced/final deadline near, still unactioned)
- 🟡 **PCNs awaiting action** (`received` with no path chosen)

Follow the established `NABucket` + `viewAllHref` deep-link pattern.

---

## 9. Settings (replaces `get-settings.js`)

Into **`system_settings`** (key/text store, category `pcn`), admin/manager-editable from the Settings
page — NOT new env vars:
- `pcn_handling_charge` (default 35), `pcn_vat_rate` (20)
- `pcn_receipt_chase_days` (3,5,7), `pcn_police_nip_urgency_days` (5)
- HH charge item id `b1744` (config, not hardcoded — it WAS hardcoded in legacy)

Email templates → OP's **email-template registry** (branded, `email_log` audited), not Monday long-
text columns. Handler = the logged-in OP user (drops the legacy name picker + audit-by-text).

**Templates needed** (all carry HH job number per §4; client-facing route through
`getJobEmailRecipients` / `job_contacts` so they reach the right contact):
- `pcn_transfer_liability` — formal transfer, £35+VAT, HH ref
- `pcn_request_driver_id` — multiple drivers; **lists the candidate driver NAMES** (flow fix #3 —
  legacy just said "multiple drivers"; OP holds the records so interpolate them)
- `pcn_police_nip_urgent` — legal 28-day driver-ID request
- `pcn_pay_direct` — the 48h pay-direct offer + POP upload link (§6)
- `pcn_receipt_chase` — one parameterised template, level 1/2/3 (mirrors OOH/holding ladder)
- `pcn_pay_recharge` — Ooosh-paid-and-recharged notification

---

## 10. What it reads / writes

**Reads from OP:** `vehicle_hire_assignments` (+`drivers`,`fleet_vehicles`,`jobs`) for matching;
`system_settings` for config; logged-in user as handler; `getJobEmailRecipients`/`job_contacts` for
client comms routing.

**Writes to OP:** `pcns` + `pcn_events`; HireHop handling charge via the broker (item `b1744`,
save_job.php logic unchanged from `hirehop-charge.js`); branded emails via `email-service`
(→`email_log`); a job-timeline `interaction` per material event (so it shows on Job Detail Activity
Timeline); files → R2 (`pcn-documents/…`, `pcn-receipts/…`).

**Ports unchanged (no Monday):** Claude Vision extraction (`extract.js` logic, model bumped to a
current Claude), the HH charge logic, the SMTP→`email-service` swap.

---

## 11. RBAC

`/api/pcns` gated to **STAFF_ROLES** (spread the constant — don't hardcode the role list).
The one-click **liability transfer** (puts £35 on a client bill) and **handling-charge push** sit at
**MANAGER_ROLES**, consistent with the "money out / hard action" tiering elsewhere. Public
receipt-upload token endpoint is unauthenticated-by-token (before the auth gate, like the OOH parking
page).

---

## 12. Build order (proposed)

1. ✅ Migration (`pcns` + `pcn_events`) + add to `run.ts`. (migration 130)
2. ✅ `routes/pcns.ts` — CRUD, `match`, settings reads; **`/extract` (Claude Vision, `services/pcn-extract.ts`)**.
3. ✅ `/vehicles/pcns` list + detail page; Vehicles nav entry. **Extraction-first Log PCN modal** (upload → extract → review → save; manual entry is the fallback). Document stored to R2 on save.
4. ✅ **"Log PCN" tile on `/quick`** (mobile-first — most PCNs arrive on paper; the file input offers camera OR PDF).
5. Pay-direct flow + `mobile_upload_tokens` `pcn_receipt` purpose + public upload page.
6. Receipt-chase scheduler + info@ alerts + issuer-deadline / NIP nudges.
7. `PcnHistorySection` (Vehicle/Driver/Person/Org) + conditional Job Detail card.
8. Dashboard NeedsAttention buckets.
9. Email templates (transfer / driver-ID / pay-direct / receipt-chase / pay-recharge) into the registry + HireHop £35 handling charge.

**Extraction is the PRIMARY entry path** (matches the legacy Netlify flow): the Log PCN modal leads with "take a photo or choose a file → Extract Data", pre-fills the form, and staff review/correct before saving. Manual entry is the fallback (a one-tap "enter details manually" link, and the fields are always editable). Extraction uses Claude Haiku via the shared `config/anthropic.ts` client — inert (503 → graceful "enter manually" message) when `ANTHROPIC_API_KEY` isn't set; it IS set on prod (the cost-receipt extractor already uses it).

---

## 13. Open / deferred

- **Pay & recharge via the Money tab** rather than just an HH line item (improvement, deferred).
- **Duplicate detection** on `reference` at upload (legacy had it as last-to-do; cheap to add here).
- **Historical Monday hire data** — not migrated; pre-OP unmatched PCNs are manual triage (§1).
- **AI extraction sharing** with the deferred Vehicle service-record extractor (same shape — could
  share a `services/document-extract` primitive later).

---

## Revision History

| Version | Date | Notes |
|---|---|---|
| 1.0 | 16 Jun 2026 | Initial OP spec — derived from legacy `PCN-Management-System` + jon design session (placement under Vehicles, conditional Job View card, pay-direct lenient flow with closed-loop receipt upload + info@ chasing, driver accountability, HH-number-everywhere, multi-driver names fix) |
