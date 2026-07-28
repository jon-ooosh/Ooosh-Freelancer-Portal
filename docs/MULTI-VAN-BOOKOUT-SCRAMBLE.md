# Multi-van book-out scramble — incident, root cause, cleanup & fix design (Jul 2026)

**Status:** root cause confirmed; live data cleanup done for the triggering job; the
code fix + detection scanner are designed but **not yet built**. This doc is a complete
handoff — a fresh session should be able to finish everything from here without re-deriving.

Branch this was investigated on: `claude/vehicle-checkin-error-nm1tib`.

> Line numbers below are as-of the commit this doc was written on and will drift — treat
> them as "look near here", grep the symbol names to confirm.

---

## 1. The trigger

A colleague tried to **check in RX24SZG** and got blocked:

> "Already checked in — This vehicle was checked in on 2026-07-05. It cannot be checked
> in again until it is booked out."

…even though RX24SZG had physically gone out on **19 Jul** (HireHop job **14885**). Job
14885 was a **2-van** self-drive hire — **RO23HLU + RX24SZG**, 4 drivers (everyone drives
everything).

The check-in gate (`GET /api/vehicles/check-in-eligibility`, `routes/vehicles.ts:2407`)
is **DB-authoritative** — it resolves the reg to a `fleet_vehicles` row and looks for a
live `booked_out`/`active` `vehicle_hire_assignments` row via
`JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id WHERE fv.reg = $1`. RX24SZG had **no
such row** (all four driver rows had been re-pointed to RO23HLU), so the query fell back
to RX24SZG's *previous* hire (job 15736, checked in 5 Jul) and blocked. The gate was
behaving correctly — the data was wrong.

---

## 2. Root cause (single defect)

**The book-out write path never partitions driver rows by van.** On a job with N van
slots (`van_requirement_index` 0,1,…) and "everyone drives everything", every van
book-out treats *all* self-drive drivers on the job as belonging to the van being booked
out right now. The frontend already models the correct per-van partition
(`van_requirement_index` / `effective_vehicle_id`, built in `loadVehicleAssignments`,
`JobDetailPage.tsx`), but the **write** path throws it away.

### Two writers, no per-van scoping

**Writer 1 — BookOutPage per-driver writeback loop (`writeBackTrack`)**,
`frontend/src/modules/vehicles/pages/BookOutPage.tsx:~859-896`. Iterates
`form.hireFormEntries` and PATCHes each with the currently-booked-out van:
`updateDriverHireForm({ vehicleId: form.vehicleId, status→'booked_out', … })`.
`form.hireFormEntries` is seeded from `GET /api/hire-forms/by-job/:hh`
(`routes/hire-forms.ts:~697-716`), which is **van-agnostic** — it returns *every*
self-drive assignment on the job. So the loop stamps *this* van onto *all* drivers, with
no `van_requirement_index` filter. `updateDriverHireForm`
(`frontend/src/modules/vehicles/lib/driver-hire-api.ts:~155-193`) sends `vehicle_id` +
`status` + times + `ve103b_ref` — **not `mileage_out`.**

**Writer 2 — `POST /api/vehicles/save-event` book-out branch**,
`backend/src/routes/vehicles.ts:~2661-2749`. Fires once per physical van book-out.
Matches rows (pass 1: linked to this reg + `status IN ('soft','confirmed')`; pass 2:
null-vehicle fallback) and writes:
```
SET status='booked_out',
    vehicle_id     = COALESCE(vehicle_id, (SELECT id FROM fleet_vehicles WHERE reg=$5)),
    mileage_out    = COALESCE(mileage_out, $2),   -- write-once
    fuel_level_out = COALESCE(fuel_level_out, $3)
```
`mileage_out` is written **only here**, **write-once** (`vehicles.ts:~2743`).

**The PATCH endpoint** (`routes/hire-forms.ts:~1364-1659`): `vehicle_id` is a **plain
assignment** in `fieldMap` (`~1496-1514`) → **last-write-wins**. `mileage_out` is **not
in `patchSchema`** (`~1168-1182`) nor `fieldMap` → PATCH never touches it. The terminal-
row guard (`~1442-1460`) blocks writes only on `swapped`/`returned`/`cancelled` — so a
row already at `booked_out` **can** have its `vehicle_id` re-stamped by a *second* van's
PATCH loop. **This single permission is the line that lets symptoms (a)/(c) happen.**

### Why it looks "scrambled" not merely wrong

One defect × three fields with three different write disciplines, so different vans win
different columns on the *same shared rows*:

| Field | Discipline | Winner | Result on job 14885 |
|---|---|---|---|
| `vehicle_id` | last-write-wins (Writer 1 PATCH) | van booked out **2nd** (RO23HLU) | all 4 rows → RO23HLU |
| `mileage_out` | first-write, write-once (Writer 2 COALESCE) | van booked out **1st** (RX24SZG) | 78,458 (RX24SZG's) stuck on RO23HLU's rows |
| `hire_form_pdf_key` / `hire_form_emailed_at` | first-write, atomic-claim (`generateAndEmailHireFormPdf`, `hire-forms.ts:~2027-2137`, claim on `hire_form_emailed_at IS NULL` `~2038-2051`) | van booked out **1st** (RX24SZG) | RX24SZG-stamped PDFs on RO23HLU's rows |
| 2nd van's rows | byproduct of `vehicle_id` overwrite | — | RX24SZG left with **zero** rows |

### The photos are a *sibling* symptom (separate storage, same upstream trigger)

Loose walkaround photos live entirely in R2, untouched by the DB write path — so this is
a **separate mechanism** but the **same upstream trigger** (a crossed
`form.vehicleReg`/`vehicle_id` at book-out).

- Core vs extra photos share one flat `CapturedPhoto[]` array uploaded in one batch. The
  only difference is the **R2 key**, built from the angle:
  `events/{eventId}/{REG}/{angle}.jpg` (`lib/photo-upload.ts:~28-32`). **Core** photos use
  16 *fixed* angle names (`front`, `dashboard`, … `REQUIRED_PHOTOS`,
  `types/vehicle-event.ts:~80-97`); **extras** use *unique* names `extra_${Date.now()}`
  (`components/book-out/PhotoCapture.tsx:~354`).
- **Not an upload failure:** uploads run core-first, extras-last (`photo-upload.ts:~55-85`),
  so a truncated upload would drop the *extras* — the opposite of what was seen (SZG showed
  only the 2 extras, zero core). Instead, SZG's core photos physically went under the
  **crossed reg / a different `eventId`** prefix, so the RX24SZG event the check-in summary
  landed on only ever held the 2 extras.
- The check-in "Book-Out Summary" photo count is a **live R2 listing of one single
  `events/{eventId}/{reg}/` prefix** (`CheckInPage.tsx:~304-394` →
  `fetchBookOutPhotos` → `/list-photos`, `vehicles.ts:~5591-5616`). It only reflects what's
  under that one folder, **not** the global truth — so "2" did not mean lost.
- **The full set survives** in the **condition-report PDF**, which embeds photos from a
  *separate LOCAL base64 pipeline* (capture-time thumbnails, `BookOutPage.tsx:~709-728`),
  independent of the R2 upload, and is frozen to R2 at
  `condition-reports/{REG}/{eventId}.pdf` (`vehicles.ts:~4641-4656`). Confirmed live: the
  19-Jul RX24SZG condition report emailed to the driver had all 16 core shots + the 2
  extras.
- **The "View full size" duff links** are the same mis-filing: the PDF builds each link
  from the *expected* R2 key `events/{eventId}/RX24SZG/{angle}.jpg`, which 404s because the
  loose object is under the crossed prefix. Confirmed self-contained (a clean single-van
  PDF's links work fine) — **not** a general link bug.

---

## 3. Blast radius

**Fingerprint:** a row whose `hire_form_pdf_key` reg differs from its `vehicle_id`'s fleet
reg (and the PDF reg is a *real, different* fleet van). Sweep:

```sql
WITH scrambled AS (
  SELECT vha.hirehop_job_id,
         own.reg AS row_reg,
         upper(regexp_replace(vha.hire_form_pdf_key, '^.*-([A-Za-z0-9]+)\.pdf$', '\1')) AS pdf_reg
  FROM vehicle_hire_assignments vha
  JOIN fleet_vehicles own ON own.id = vha.vehicle_id
  WHERE vha.hire_form_pdf_key IS NOT NULL
    AND vha.swapped_at IS NULL
    AND upper(regexp_replace(vha.hire_form_pdf_key, '^.*-([A-Za-z0-9]+)\.pdf$', '\1'))
        <> regexp_replace(upper(own.reg), '\s', '', 'g')
    AND EXISTS (SELECT 1 FROM fleet_vehicles o
                WHERE regexp_replace(upper(o.reg),'\s','','g')
                    = upper(regexp_replace(vha.hire_form_pdf_key, '^.*-([A-Za-z0-9]+)\.pdf$', '\1')))
)
SELECT hirehop_job_id, count(*) AS scrambled_rows,
       array_agg(DISTINCT row_reg) AS rows_point_to,
       array_agg(DISTINCT pdf_reg) AS pdfs_stamped
FROM scrambled GROUP BY hirehop_job_id ORDER BY hirehop_job_id;
```

**Result (Jul 2026): 3 jobs.**

| Job | Rows point to | PDFs stamped | State |
|---|---|---|---|
| **14885** | RO23HLU | RX24SZG | **Fixed** (see §4). Live at time of discovery. |
| **15411** | RO23HLU | RO23HLR | Completed 29 Jun. Historical mileage tidy only. |
| **16206** | SA75RVV | RX73TBZ | Completed 07 Jul. Historical mileage tidy only. |

**Sweep limitations:** catches only self-drive multi-van jobs where PDFs were generated
and the two regs differ. It does **not** catch a scramble that never generated PDFs, nor
the pure "2nd van got zero rows" case — the latter only shows as a van stuck
`hire_status='On Hire'`, which is exactly what the **detection scanner** (§6) is for.

---

## 4. Cleanup — job 14885 (DONE)

Run against `ooosh_operations`.

**(a) Fix RO23HLU's polluted book-out mileage** (it carried RX24SZG's 78,458; RO23HLU's
real book-out was 102,152 per its own R2 event history; check-in 103,806 was already
correct):
```sql
UPDATE vehicle_hire_assignments
SET mileage_out = 102152, updated_at = now()
WHERE hirehop_job_id = 14885
  AND vehicle_id = '67a341d5-7ddc-4c0e-9354-301779b2e07b'   -- RO23HLU
  AND mileage_out = 78458;                                   -- guard: only polluted rows (expect 4)
```

**(b) Create RX24SZG's missing booked_out row** so it can be checked in normally:
```sql
INSERT INTO vehicle_hire_assignments (
  id, vehicle_id, job_id, hirehop_job_id, driver_id,
  assignment_type, van_requirement_index, status, status_changed_at,
  return_overnight, booked_out_at, booked_out_by,
  mileage_out, fuel_level_out, created_at, created_by
) VALUES (
  gen_random_uuid(),
  '8d1ba507-835b-4266-afb4-91e091984ced',   -- RX24SZG fleet id
  '817fe8df-38e2-4941-ad0e-9cd438f73bcf',   -- OP job id for HH 14885
  14885,
  'f6f57b46-df6c-4827-a93a-6e71377f506b',   -- Neil Sinclair Banks
  'self_drive', 1, 'booked_out', '2026-07-19 09:35:00+00',
  't', '2026-07-19 09:35:00+00', 'de434bb1-11c0-443a-a837-ecb408fadf9e',
  78458, 'Full', now(), '00000000-0000-0000-0000-000000000000'
);
```
Then **Fleet → RX24SZG → Check In** via the normal UI (captures return mileage/fuel/
condition, flips to `returned`, resyncs the fleet flag off `On Hire`). `hire_form_pdf_key`
/ `ve103b_ref` deliberately left NULL on the new row.

**Photos:** confirmed safe — the full core set is in the emailed 19-Jul condition-report
PDF and/or under the crossed R2 prefix (recover/re-file via §5 if the loose objects are
wanted). No data lost.

---

## 5. Cleanup — jobs 15411 & 16206 (REMAINING, low priority)

Both **completed**, both vans long back, **no stuck flags** (SA75RVV reads `On Hire`
correctly — it's genuinely out on job 16086). So these are **data-integrity tidies, not
operational blockers.** The row `mileage_out`/`mileage_in` values are scrambled and can't
be reverse-engineered from the DB — you need each van's TRUE book-out & check-in odometer
from its **R2 event history**.

- **15411** (RO23HLU + RO23HLR): 5 RO23HLU rows carry RO23HLR's book-out mileage (99,608)
  + RO23HLU's own check-in (102,131). RO23HLR has **no rows** (its half lives only in R2
  events). Also 3 stale `cancelled` staff-allocation rows (RX73TCJ/RX73TBZ/RX24SZJ) — leave
  them.
- **16206** (SA75RVV + RX73TBZ): 3 SA75RVV rows stamped RX73TBZ + a 4th correctly-stamped
  SA75RVV row (`mileage_out` NULL). `mileage_in = 5651` on all four is **nonsensical**
  (way below `mileage_out` 100,568) — the *check-in* scrambled too (5,651 is almost
  certainly RX73TBZ's odometer). RX73TBZ has no rows on this job.

**How to get the true figures:**
`GET /api/vehicles/get-events?vehicleReg=<REG>&eventType=Book+Out` (+ the Check In events)
returns per-event `mileage` — or read them off Vehicle Detail → History → Events for each
reg. Then `UPDATE` the crossed rows' `mileage_out`/`mileage_in` to the correct van's
figures. (Optional: the corresponding `vehicle_mileage_log` dual-write rows carry the same
bad figure — the upward-only ratchet means current-mileage display is unaffected, so this
is cosmetic.) **No fake check-ins on completed jobs.**

### Confirmed figures + corrections (read off R2 Event History)

**15411 — RO23HLU** (`67a341d5-7ddc-4c0e-9354-301779b2e07b`): true book-out **101,607**
(26 Jun event), check-in **102,131** (28 Jun event — already correct on the rows). Rows
wrongly hold `mileage_out = 99608` (RO23HLR's crossed value). **Ready to run:**
```sql
UPDATE vehicle_hire_assignments
SET mileage_out = 101607, updated_at = now()
WHERE hirehop_job_id = 15411
  AND vehicle_id = '67a341d5-7ddc-4c0e-9354-301779b2e07b'   -- RO23HLU
  AND mileage_out = 99608;                                   -- guard; expect 5
```

**16206 — SA75RVV** (a new, low-mileage van — the cross is FLIPPED vs 15411): rows hold
`mileage_out = 100568` (RX73TBZ's ~100k, crossed) + `mileage_in = 5651`. Because SA75RVV
genuinely reads ~5–6k, `mileage_in ≈ 5651` is likely SA75RVV's own — **but confirm both
figures from SA75RVV's 3-Jul book-out + 6-Jul check-in events before running** (jon noted
SA75RVV "ends ~5,851", so `mileage_in` may also need nudging). Template:
```sql
UPDATE vehicle_hire_assignments
SET mileage_out = <SA75RVV_3JUL_BOOKOUT>,          -- from SA75RVV's book-out event
    mileage_in  = <SA75RVV_6JUL_CHECKIN>,          -- confirm; may already equal 5651
    updated_at  = now()
WHERE hirehop_job_id = 16206
  AND vehicle_id = (SELECT id FROM fleet_vehicles
                    WHERE regexp_replace(upper(reg),'\s','','g') = 'SA75RVV')
  AND (mileage_out = 100568 OR mileage_out IS NULL);   -- guard; expect 4
```

The per-reg R2 events are ground truth (they were never scrambled). `vehicle_mileage_log`
+ current fleet mileage are unaffected (the events logged the correct figures, and the
upward-only ratchet protects current-mileage display) — so only the assignment-row
`mileage_out`/`mileage_in` need correcting; it's a historical-record fix, no cascade.

### Recovering / enumerating photos in R2 (any job)

1. `GET /api/vehicles/get-events?vehicleReg=<REG>&eventType=Book+Out` → event IDs.
2. `GET /api/vehicles/list-photos?prefix=events/{eventId}/<REG>/` → real objects under a
   prefix. Run **cross-wise** (one van's eventIds under the other van's reg folder) to
   locate mis-filed core photos.
3. `POST /api/vehicles/events/{eventId}/regenerate-pdf` → serves the frozen condition
   report (stored-first, full local-captured set).

---

## 6. Detection scanner (TO BUILD — ship first, low risk)

Sanity scanner mirroring the existing dispatch/return ones in
`services/sanity-check-scanner.ts` (wired into the 15-min sanity cron). Flag a van that
reads `fleet_vehicles.hire_status='On Hire'` **and** has a book-out event, but has **no
live `booked_out`/`active` assignment row** (dual job-match — the exact stuck-shape that
RX24SZG and SA75RVV-had-it-been-stuck present). Also worth flagging the sweep fingerprint
(§3) as it appears.

- **Recipient: `jon@oooshtours.co.uk`, NOT info@** (jon's call — info@ would get ignored
  and staff wouldn't know the context). Include reg + HH job number + a plain description.
- Stamp-first dedup marker (same discipline as the other scanners).
- Near-zero blast radius; ship ahead of the core fix so any recurrence is caught before
  someone hits it at check-in.

---

## 7. The core fix (TO DESIGN WITH JON, THEN BUILD)

Make book-out **partition driver rows by van**. A server-side "adopt-or-create a per-van
assignment row (keyed on `van_requirement_index`)" step at the single choke-point both
book-out paths funnel through — invoked from the PATCH book-out transition
(`hire-forms.ts:~1600-1652`) and the `save-event` matcher (`vehicles.ts:~2672-2749`),
**before `firePostBookOutHooks`** (so it doesn't double-fire PDFs/emails or double-count
excess). For a driver who drives multiple vans, **clone** a fresh per-van row rather than
overwriting the shared one.

- **Reuse existing cloning logic:** `POST /api/hire-forms/:id/add-to-hire`
  (`hire-forms.ts:~1813-1867`) already clones a per-van row; the freelancer smart-resolve
  merge does similar. Lift the frontend's slot-partition logic
  (`loadVehicleAssignments` `effective_vehicle_id`/`van_requirement_index`) server-side so
  read and write agree.
- **Reuse `services/vha-dedup.ts`** (`cancelOrphanSiblingAllocations` at book-out,
  `cancelStaleVanAllocationsOnReturn` at check-in) — complement, don't duplicate; they're
  guarded to `driver_id IS NULL` so they won't touch a real second driver's row.
- **Tighten the PATCH terminal guard** (`hire-forms.ts:~1442-1460`): refuse to overwrite
  `vehicle_id` on a row already `booked_out` to a *different* van. That one line is what
  lets the whole scramble happen.
- **This closes all three surfaces at source** — fields, mis-filed photos, and the
  view-full-size links — because none of them cross if the reg isn't crossed.

### Risks & mitigations

1. **Duplicate / double-counted rows** — adopt-before-create, via the `vha-dedup` +
   `add-to-hire` cloning, never a blind insert.
2. **Client-facing side-effects on a repair/created row** — a created row must be inert
   (no `firePostBookOutHooks` PDF/email/excess cascade) unless it's a genuine hire-form
   book-out.
3. **Driver attribution on a multi-driver van** — driverless rows (`vehicle_id` set,
   `driver_id NULL`) are supported but lean on sibling-inference; keep tidy.
4. **Idempotency** — book-out is retried (poor signal / double-tap); guard creation with
   the same atomic-claim discipline `generateAndEmailHireFormPdf` already uses.

There's a related spec worth reading alongside this: `docs/BOOKOUT-PHASE-SPLIT-SPEC.md`.

---

## 8. Task checklist

- [x] Diagnose 14885 check-in block; confirm root cause (trace).
- [x] Clean up 14885 (mileage `UPDATE` + RX24SZG `INSERT`); van checked in via UI.
- [x] Confirm photos safe (condition-report PDF) + duff links self-contained.
- [x] Sweep for other affected jobs → 3 total (14885, 15411, 16206).
- [x] Confirm 15411/16206 have no stuck flags (SA75RVV correctly On Hire on job 16086).
- [ ] Historical mileage tidy for 15411 + 16206 (needs R2 event odometers; low priority).
- [ ] Build detection scanner → jon@ (ship first).
- [ ] Design + build the partition-by-van core fix (plan with jon before coding).
