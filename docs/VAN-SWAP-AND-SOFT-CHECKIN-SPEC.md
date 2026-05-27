# Vehicle Swap & Soft Check-In Spec

**Status:** Draft, May 2026. Supersedes the bare Phase D3 bullets in CLAUDE.md (Step 2 Phase D3) and the open soft-check-in TODO under Future Enhancements.

**Motivation incident (15 May 2026, HH 15378):** A van (TBZ) developed a brake fault mid-hire. Staff tried to swap it for RO23HLU via the existing `POST /api/assignments/:id/swap-vehicle` endpoint. The swap was blocked by the overlap check — HLU appeared "unavailable" because an orphaned `confirmed` `vehicle_hire_assignments` row from a previous hire (15613) still occupied the slot, even though the actual hire row had been correctly checked in at 11:59 the same day.

Two root causes surfaced:

1. **Orphaned sibling rows at book-out** — the dual-row pattern (staff-allocation row + hire-form row for the same `(vehicle, job)`) isn't deduplicated at staff book-out time. The freelancer-bookout path already merges them; the staff path doesn't.
2. **No swap workflow** — the backend swap endpoint exists, but no UI surface triggers it, no soft check-in captures the swapped-out van's state, no link to the Job Issues register records WHY the swap happened.

This spec covers both, plus the soft-check-in primitive that's also needed for the future freelancer-led handover flow.

## Scope

**In scope:**
- Phase D3 swap UI (Job Detail Drivers & Vehicles tab)
- Soft check-in primitive (new vehicle event type, used by swap and freelancer handover)
- Job Issues integration (link existing or auto-create on swap)
- Orphan dedup at staff book-out (port from freelancer path)
- One-shot sweeper script for historical orphans

**Out of scope (deliberately):**
- Mid-hire driver changes that don't involve a vehicle swap (covered by existing "Add to Hire" flow)
- Multi-van swap in a single action (one swap per modal — chain them if needed)
- HireHop write-back for the swap (HH doesn't model mid-hire vehicle changes — we record it on our side only)
- Client-facing email about the vehicle change (drafted at PDF email time on book-out of replacement)

## 1. Phase D3 — Swap UI

### Trigger

"Swap Vehicle" button on **Job Detail > Drivers & Vehicles tab**, per assignment card. Visibility rules:

| Assignment status | Button |
|---|---|
| `soft`, `confirmed`, no van linked | Hidden — there's nothing to swap |
| `soft`, `confirmed`, van linked, not yet booked out | Hidden — use Allocate Van / change directly |
| `booked_out`, `active` | **Visible** — primary swap case |
| `returned`, `cancelled`, `swapped` | Hidden — terminal |

**RBAC: `admin`, `manager`, AND `weekend_manager`.** Breakdowns happen at weekends — `weekend_manager` MUST be able to action a swap. Do NOT use a bare `authorize('admin', 'manager')` (it silently locks out `weekend_manager`, the exact bug class flagged in CLAUDE.md for `/pipeline` + `/requirements`). Use `authorize('admin', 'manager', 'weekend_manager')` explicitly — this is narrower than `STAFF_ROLES` (which also includes `staff` + `general_assistant`), so don't reach for the spread constant here. No override flow for other roles — trust that 90% of swaps are pre-planned enough to wait for a manager call; the rare genuinely-stuck case escalates by phone.

### Modal contents

Single modal, three sections:

**Section A — What's happening**
- Header: "Swap RX73TBZ on job #15378 — Dave Driver"
- Reason picklist (required): `breakdown` / `accident` / `mechanical_failure` / `client_request` / `other`
- Free-text details (required, min 10 chars)

**Section B — Replacement van**
- Vehicle search picker (same component as Allocations)
- Filter to vans of the same `simple_type` by default, toggleable to "any vehicle"
- Live availability check on selection — surfaces 409 inline with proposed alternatives rather than waiting until submit
- Read-only sibling-driver awareness: if multiple drivers share this van slot on the hire, show "This swap will affect N drivers" with a list. **All siblings auto-cascade — a physical van change moves every driver on it.** No per-driver confirmation; single submit swaps all N assignments from van A to van B. Each driver's hire agreement PDF re-stamps with the new reg at the replacement van's book-out (per-driver PDFs, same van reg on each — see CLAUDE.md "Scope rules" table)

**Section C — Soft check-in of the van being swapped out**
See §2 for the primitive. In the modal, this section captures:
- Current mileage (required if known, "unknown" toggle)
- Fuel level (required if known, "unknown" toggle)
- Current location (free text — "Edinburgh, AutoFix Garage" / "on tow truck to base" / "still at venue, recovery booked")
- Any new damage notes (free text)
- Photo upload (optional, min 0 — recovery context often doesn't allow it)

**Section D — Link to a problem**
- Backend pre-fetches open `job_issues` for this vehicle (and optionally this job) via `GET /api/problems/by-vehicle/:vehicleId?status=open`
- UX:
  - If 1+ open issue exists: radio list with subjects + categories, "Link this swap to:" + "Create a new breakdown issue instead" + "Don't link to an issue (uncommon)"
  - If 0 open issues: "We'll create a new breakdown issue for this swap" with editable subject (auto-prefilled from reason + details), category (default `breakdown`), severity (default `urgent`)
- Decision: default to NEW issue if no open ones exist; default to FIRST matching issue if any are open (most common case is "this matches the call we got earlier today")

Submit button is disabled until A, B, D are valid. Section C "unknown" toggles allow incomplete soft-check-in data (real-world: staff don't always know mileage when a van's broken down 200 miles away).

### Backend changes

Extend `POST /api/assignments/:id/swap-vehicle`:

**Existing behaviour (unchanged):**
- Overlap check on replacement van (uses target hire window — see CLAUDE.md "Hire Date Resolution" — `vha.hire_start/hire_end` → fallback `jobs.job_date/job_end`, NOT `return_date`)
- Mark original assignment `status='swapped'`, populate `swap_reason`, `swapped_at`, `swapped_to_assignment_id`
- Create new assignment for replacement van, copy excess

**New behaviour:**
- Accept `soft_checkin` payload — see §2
- Accept `issue_link` payload: `{ existing_issue_id: uuid }` OR `{ new_issue: { subject, category, severity, description } }`
- On success: fire soft-check-in event on original van, link/create issue with swap event on its timeline
- Trigger `syncFleetHireStatus` for original van — see §2 rules
- Trigger `syncFleetHireStatus` for replacement van (the new assignment is `confirmed`, so its status doesn't flip to On Hire until book-out)
- Return `{ original_assignment: {...}, new_assignment: {...}, issue: {...}, redirect_to: '/vehicles/book-out?assignment_id=<new_id>' }`

### Frontend post-submit

- Toast: "Vehicle swapped — record soft check-in saved. Now book out the replacement van."
- Redirect to BookOutPage for the new assignment, pre-filled
- BookOutPage runs as normal — full walkaround, condition report, driver email of the new agreement
- On book-out completion, new assignment flips `confirmed → booked_out`, replacement van's hire_status goes to `On Hire`

### Edge case: missing hire form for new van

If the new assignment is created from the swap but no hire form exists for it (because the original hire form was for the swapped-out van — actually wait, hire forms in Ooosh are per-driver, vehicle-agnostic): the existing hire form (signed by the driver, pointing at the original van) should remain valid. The new vehicle reg gets stamped on the new assignment's hire agreement PDF at book-out via the existing book-out trigger (CLAUDE.md "Phase C4 — hire form PDF generation trigger"). No new hire form needs signing.

VE103B regen: VE103B generation requires a NEW pre-printed certificate number (manually entered — the system can't assign one), so the swap can't auto-regenerate. **As shipped (PR 2):** the swap endpoint detects `ve103b_ref` on any swapped row and returns `ve103b_regen_needed: true` + `ve103b_reg`; the frontend alerts the user to generate a new VE103B for the replacement van manually from the VE103B page. The original cert is NOT auto-voided (staff void it from the VE103B page if needed).

**Deferred (PR 2):** the auto-generated Interim Assessment PDF + vehicle Event-History entry for the swapped-out van. The `isInterim` PDF variant + the `save-event` `soft-check-in` branch both exist (PR 1), and the swap records the soft check-in durably (old van → `Not Ready`, mileage logged, soft-checkin data on the Job Issue `swap_logged` event + a job-timeline interaction). The swap endpoint just doesn't fire the PDF — the breakdown's system of record is the Job Issue, which can carry photos + contractor quotes. Wiring the interim PDF into the swap flow (or a "Generate interim PDF" button on the issue) is a small follow-up.

## 2. Soft Check-In Primitive

### Concept

An **interim** check-in. Captures the state of a van at a point in time without closing the hire from a close-out / reconciliation perspective.

Two use cases:
1. **Vehicle swap** (this spec) — capture state of the swapped-out van before it goes to a garage
2. **Freelancer-led customer pickup** (future, CLAUDE.md roadmap) — freelancer collects van from a customer on Ooosh's behalf, does a soft check-in to record state, full check-in happens when van returns to base

### Differences from full check-in

| Behaviour | Full check-in | Soft check-in |
|---|---|---|
| `vehicle_hire_assignments.status` | Flips to `returned` | Stays as-is (swap endpoint handles its own status flip to `swapped`) |
| `vehicle_hire_assignments.checked_in_at` | Set to NOW() | Stays NULL — preserved for the eventual full check-in |
| `fleet_vehicles.hire_status` | `On Hire` → `Prep Needed` | `On Hire` → `Not Ready` (sticky, manual revert required) |
| Mileage log | Written to `vehicle_mileage_log` | Written to `vehicle_mileage_log` (state-of-the-van data is real either way) |
| Post-hire close-out requirements | Auto-created (invoice, payment reconcile, etc.) | NOT created — the original hire continues on the replacement van |
| HireHop writeback | Pushes status 7 (Returned) on last vehicle | NO writeback — HH keeps the hire as Dispatched |
| Email to driver | Check-in confirmation + signed PDF | NOT sent — the driver isn't getting the van back; the replacement van triggers its own emails |
| PDF generation | Full condition report PDF | "Interim Assessment PDF" — see §2.4 |
| `damage_review` requirement | Auto-created if `has_damage=true` | NOT created — the linked Job Issue (§3) takes its place |

### Vehicle event type

New `eventType` value: `'soft-check-in'` (alongside existing `'Check In'` / `'check-in'` / `'Check Out'` etc.). Stored in the vehicle event history under R2 with the same shape as other condition events.

### Side-effect rules in `POST /api/vehicles/save-event`

Add a branch for `normalisedEventType === 'soft-check-in'`:

- Log to `vehicle_mileage_log` (same as book-out / check-in for mileage capture)
- Do NOT flip any `vehicle_hire_assignments.status` (caller — the swap endpoint — handles that)
- Do NOT auto-create close-out requirements
- Do NOT fire HH writeback
- Set `fleet_vehicles.hire_status = 'Not Ready'` (sticky, requires manual revert via prep form or admin override)
- Generate "Interim Assessment PDF" — see §2.4
- Store PDF in R2 under `vehicle-events/{REG}/{event_id}_interim.pdf`

### Interim Assessment PDF

Port of the existing condition report PDF (`backend/src/routes/vehicles.ts buildConditionReportPdf`) with:
- Title: "Interim Vehicle Assessment" (not "Vehicle Condition Report")
- Subtitle explaining context: "This is an interim assessment captured during a mid-hire vehicle swap. The hire is continuing on a replacement vehicle. A full check-in will be carried out when this vehicle returns to base."
- All standard sections: mileage, fuel, damage notes, photos, location
- NO signature section (drivers / customers aren't necessarily present for breakdowns)
- Footer: links to the linked Job Issue (§3) for ongoing context

Reuses `services/post-hook-recovery.ts` `runHookWithRecovery` for the email/storage chain (matches the 7 May 2026 pattern for post-book-out hooks).

### Future eventual full check-in

When the van eventually arrives back at base (could be days/weeks later after garage repairs):

- Staff runs CheckInPage as normal
- The check-in side-effect in `vehicles.ts` finds no `booked_out` assignment for this van/job (because the assignment is already `swapped`) — would normally log "no matching assignment, no state flip"
- **New behaviour:** also look for `status='swapped'` assignments on the same `(vehicle, hh_job)` with a prior soft-check-in event. If found, treat this as a follow-up full check-in:
  - Read the prior soft-check-in event's mileage, fuel, damage notes
  - Diff against current readings
  - Surface differences in the check-in flow ("Mileage was 45,120 at soft check-in on 15 May. Now 45,118 — discrepancy?" / "Damage noted at soft check-in: scuffed bumper. Any additional damage?")
  - On submit: regular full check-in flow, but with a "Final check-in following swap" note logged to the Job Issue
- `fleet_vehicles.hire_status`: `Not Ready` → `Prep Needed` (or stays `Not Ready` if damage is still being repaired — staff decides via the prep form)

Out of scope for this spec but flagged for the implementation: the swap-then-eventual-check-in flow needs a CheckInPage UI affordance that recognises "this van has a prior soft check-in for this job". Could be deferred to a follow-up — initial release can just do the regular check-in path.

## 3. Job Issues Integration

### On swap submit

Caller provides one of:
- `issue_link.existing_issue_id: uuid` — link this swap to an existing open issue
- `issue_link.new_issue: { subject, category, severity, description }` — create a new issue
- `issue_link: null` — don't link to an issue (rare, surfaced as a warning in the UI)

### Backend behaviour

If `existing_issue_id`:
- Verify issue exists, status is non-terminal, vehicle_id matches
- Log a `job_issue_events` row: `event_type='swap_logged'`, body includes swap reason + details + soft check-in summary + links to both assignment IDs
- If issue's `severity` is currently `low` and the swap reason is `breakdown` / `accident` / `mechanical_failure`, bump severity to `urgent` automatically — surfaces the now-acute situation

If `new_issue`:
- Create a `job_issues` row with: `vehicle_id`, `job_id`, `hh_stock_item_id=NULL`, `category` (from payload), `severity` (from payload, default `urgent`), `subject`, `description`, `reported_by` (current user), `status='open'`
- Set `watchers` from `vehicle_issue_default_watchers` system setting
- Log `event_type='created'` event
- Log `event_type='swap_logged'` event with same body as above
- Fire notifications via `notifyIssueRecipients` (existing pattern)

Both paths return the issue ID in the swap response so the UI can link to it from the success toast.

### UI affordances

- Issue picker section in swap modal (§1, Section D)
- "View issue" link in post-swap toast
- Job Detail Activity Timeline: swap creates an interaction logged as a `note` with the swap summary + issue link
- Driver Detail Hire History: swapped assignment shows "↪ Swapped to RX22XYZ on 15 May" (already designed per Turnaround Schedule spec)

## 4. Orphan Dedup at Book-Out (Root-Cause Fix)

### Where the dual-row pattern arises

A self-drive hire can land two `vehicle_hire_assignments` rows for the same `(vehicle_id, hirehop_job_id)`:

1. **Staff allocation row** — created from AllocationsPage when staff picks the van for the hire. `status='confirmed'`, no `booked_out_at`
2. **Hire form row** — created by `POST /api/hire-forms` when the driver submits their hire form. Initially `status='confirmed'`, then progresses through `booked_out → returned`

The freelancer-bookout smart-resolve path (`POST /api/vehicles/freelancer-bookout/resolve`) already handles this by merging the staff-allocation row into the hire-form row. The staff path doesn't.

### Fix

In `PATCH /api/hire-forms/:id`, when:
- `status` transitions to `booked_out`
- `vehicle_id` is set on the row

Run a cleanup pass before responding:

```typescript
// Cancel sibling staff-allocation rows for the same (vehicle, job).
// Skips already-terminal rows (cancelled/returned/swapped).
// Skips this row itself.
await query(
  `UPDATE vehicle_hire_assignments
   SET status = 'cancelled',
       status_changed_at = NOW(),
       notes = COALESCE(notes, '') || $1,
       updated_at = NOW()
   WHERE vehicle_id = $2
     AND hirehop_job_id = $3
     AND id != $4
     AND status IN ('soft', 'confirmed')
     AND booked_out_at IS NULL`,
  [
    ` [Auto-cancelled: superseded by hire-form-driven row ${currentRowId} at book-out]`,
    vehicleId,
    hhJobId,
    currentRowId,
  ]
);
```

Logged via `console.log` with the count of cancelled siblings for observability.

### Where else this might leak

The dual-row pattern only affects self-drive hires with hire forms. V&D and D&C don't have hire-form rows — the staff allocation IS the canonical record. No dedup needed there.

The book-out trigger lives in `PATCH /api/hire-forms/:id`, but the staff-side book-out via `POST /api/assignments/:id/book-out` could also be a write path for self-drive. The dedup helper lives in `backend/src/services/vha-dedup.ts` and is called from both.

### The book-out dedup isn't enough — check-in cleanup is the real prevention (found May 2026)

When we ran the sweeper against live data after PR 1's first cut, it found **0** orphans — but the actual blocking row from the 15613/HLU incident had a **`driver_id` set**, not NULL. The book-out dedup (`cancelOrphanSiblingAllocations`) deliberately guards on `driver_id IS NULL` so it can never cancel a legitimate second driver pending their own book-out. That guard means it would have **missed the very orphan that caused the incident.**

The robust prevention is at **check-in**, not book-out. `cancelStaleVanAllocationsOnReturn` (in `vha-dedup.ts`) fires from both check-in paths (`save-event` check-in side-effect + `POST /api/assignments/:id/check-in`) and cancels **any** soft/confirmed row on the same (vehicle, job) with `booked_out_at IS NULL` — driver-agnostic. The reasoning: once a van is physically checked in, the hire on that (vehicle, job) is over, so nothing un-booked-out on it is going anywhere. There's no multi-driver ambiguity at check-in like there is at book-out. Had this existed on 15 May, the HLU orphan would have been cancelled when its sibling checked in at 10:59, and the 5pm swap would have succeeded.

**Two-layer model, by intent:**

| Helper | Fires at | Guard | Why |
|---|---|---|---|
| `cancelOrphanSiblingAllocations` | book-out (hire-form PATCH + assignments book-out) | `driver_id IS NULL` | Mid-hire we can't safely cancel a driver-bearing sibling — it might be a real second driver pending book-out |
| `cancelStaleVanAllocationsOnReturn` | check-in (save-event + assignments check-in) | driver-agnostic | Hire's over — anything un-booked-out is definitively stale |

The sweeper catches both classes historically: pure staff-allocation orphans (`driver_id IS NULL`, any progressed sibling) AND driver-bearing orphans whose sibling has `returned`.

## 5. Sweeper Script

`backend/src/scripts/cleanup-orphan-vha-rows.ts`

### Detection rules

Find groups of `vehicle_hire_assignments` rows where:
- Same `(vehicle_id, hirehop_job_id)` — both non-null
- At least one row has `booked_out_at` populated (the progressed row)
- At least one OTHER row is in status `soft` or `confirmed` with `booked_out_at IS NULL` (the orphan)

For each orphan: cancel with audit note `[Sweeper: orphan staff-allocation row, sibling <id> progressed to <status>]`.

### Flags

```
npx tsx src/scripts/cleanup-orphan-vha-rows.ts            # Dry-run, full fleet
npx tsx src/scripts/cleanup-orphan-vha-rows.ts --commit   # Apply
npx tsx src/scripts/cleanup-orphan-vha-rows.ts --vehicle=RO23HLU
npx tsx src/scripts/cleanup-orphan-vha-rows.ts --job=15613
```

### Audit row

Same `notes` annotation pattern as the live dedup (§4). Future Claudes / staff investigating can grep for `[Sweeper: orphan` to find historical cleanups.

### Idempotency

Re-running is safe — the cancellation criteria specifically targets `status IN ('soft', 'confirmed')`, and a previously-cancelled orphan is in status `cancelled` so it's skipped.

## 6. Build Order

1. **Soft check-in primitive** (§2) — foundational, used by swap and future freelancer work. Doesn't need the swap UI to land.
2. **Orphan dedup at book-out** (§4) — independent fix, no UI changes. Stops new orphans being created.
3. **Sweeper script** (§5) — one-shot cleanup of historical data once §4 is live.
4. **Phase D3 swap UI** (§1) — the big visible piece. Depends on §2.
5. **Job Issues integration** (§3) — bolts onto §1, but can be initial-release-MVP without it (no issue link, just swap) and added in a follow-up.

Recommended PR shape: §2 + §4 + §5 in one PR (foundation + cleanup), §1 + §3 in a second PR (the user-facing swap).

**Immediate follow-on (next work after this spec lands):** Freelancer-led interim check-in UI. The soft check-in primitive (§2) is the bulk of the work — the freelancer case just needs a different entry point (not the swap modal): a freelancer-facing surface where someone collecting a van from a customer on Ooosh's behalf records its state. Reuses the soft check-in event type, the interim PDF, the `Not Ready` fleet transition, and (optionally) a Job Issue if there's damage. Slots onto the existing freelancer-bookout JWT flow (CLAUDE.md "Freelancer book-out Round 5+"). Capturing it here so it doesn't fall off the radar — jon's steer (May 2026): tackle straight after the swap work, since we're laying 90% of it now.

## 7. Schema changes

Minimal — most fields already exist.

**`vehicle_hire_assignments`** — `swap_reason`, `swapped_at`, `swapped_to_assignment_id` already exist (per CLAUDE.md "Phase D3 — formal flow"). No changes needed.

**`fleet_vehicles.hire_status`** — `'Not Ready'` already exists as a sticky value. No changes needed.

**`job_issues`** — Stage 2 schema (migration 075) supports `vehicle_id`, `job_id`, `category='breakdown'`. No changes needed. Verify `job_issue_events.event_type` enum allows `'swap_logged'`; if not, add it.

**New migration:** none required. Confirm during build.

## 8. Testing checklist

Before merging:

- [ ] Swap a van mid-hire with a known open issue → linked correctly
- [ ] Swap a van with no open issues → new issue created with correct category + severity
- [ ] Swap a van that's NOT yet booked out → button hidden
- [ ] Swap a van that's already `returned` / `swapped` → button hidden
- [ ] Swap to a van that's currently on another hire → 409 surfaced inline in modal, swap blocked
- [ ] Swap fires `syncFleetHireStatus` for both old + new vans (old → `Not Ready`, new stays at current value until book-out)
- [ ] Soft check-in PDF generates and stores under R2 `vehicle-events/{REG}/{id}_interim.pdf`
- [ ] Soft check-in does NOT trigger HH writeback (HH stays at status 5 Dispatched)
- [ ] Soft check-in does NOT auto-create close-out requirements
- [ ] Soft check-in logs mileage to `vehicle_mileage_log` (real reading, real time)
- [ ] Hire form PDF for replacement van shows new reg at book-out (existing trigger works)
- [ ] VE103B regen fires if original assignment had `ve103b_ref` set (international)
- [ ] Orphan dedup fires on staff book-out of a self-drive hire (sibling staff-allocation row gets cancelled)
- [ ] Sweeper script in dry-run mode reports the 15613/HLU orphan + any others
- [ ] Sweeper script in `--commit` mode cleans them up with the right audit notes
- [ ] Job Detail Drivers & Vehicles tab shows the swap on both assignment cards (original = "↪ Swapped to X", new = "↩ Swap-in from Y")
- [ ] Driver Detail Hire History shows both rows with swap relationship
- [ ] Eventual full check-in of the swapped-out van (later, when garage returns it) works without re-flipping the assignment status (it's already `swapped`, full check-in just generates the report)

## 9. Resolved decisions (jon, May 2026)

All four open questions resolved — locked in:

- **Who owns the swap?** `admin`, `manager`, AND `weekend_manager`. No override flow for other roles — genuinely-stuck weekend cases escalate by phone. (See §1 RBAC note — must explicitly include `weekend_manager`, don't use bare `authorize('admin', 'manager')`.)
- **Multi-driver swap** — auto-cascade. If 4 drivers share van A, all 4 move to van B on a single submit. Read-only display of affected drivers in the modal, no per-driver confirmation. (See §1 Section B.)
- **Soft check-in via freelancer-led handover** — soft check-in primitive (§2) is built here; the freelancer-handover entry point is **the very next piece of work after this lands** (see §6 — we're laying ~90% of it). Not deferred indefinitely.
- **HH job memo note on swap** — YES. Push a `job_note` to HireHop on swap: "Mid-hire swap on DD/MM/YYYY: RX73TBZ → RO23HLU". Best-effort (logged warning if it fails, doesn't block the swap), gives HH-only staff operational visibility.

## 10. Cross-references

- CLAUDE.md "Step 2 Phase D3 — Vehicle Swap (Breakdown / Reallocation)" — existing bullets, superseded by this spec
- CLAUDE.md "Soft Check-in primitive" (Future Enhancements) — superseded
- CLAUDE.md "Phase F — actionable notifications + Problems integration" — uses the same `job_issues` write paths
- CLAUDE.md "Phase D1.5 — Job Detail cockpit for self-drive lifecycle" — the swap button slots into the same per-card next-action button pattern
- CLAUDE.md "Hire Date Resolution" — overlap check uses `hire_start/hire_end` with `job_date/job_end` fallback
- CLAUDE.md "Fleet Hire-Status Sync" — `syncFleetHireStatus` is the single source of truth for `fleet_vehicles.hire_status` changes; the swap endpoint must call it for both old + new vans
- CLAUDE.md "Job Issues / Problems register — Stage 2 control panel" — backend endpoints + schema reference
- CLAUDE.md "Smart resolve" (in freelancer-bookout flow) — pattern being ported to staff book-out as the orphan dedup
- `docs/VE103B-SPEC.md` — VE103B regen on swap
- `docs/HIRE-FORM-REPOINTING-SPEC.md` — hire form PDF generation triggers
